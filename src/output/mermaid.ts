import type { Analysis, GraphEdge, GraphNode, MachineModel, StateNodeModel, TransitionModel } from '../model.js';

/* ---------- XState state diagrams ---------- */

/** Id of the machine's root pseudo-state. Must not be `root`: Mermaid uses that id for its own top-level cluster and fails at render time. */
const ROOT_ID = 's__machine';

function sid(path: string): string {
  if (!path) return ROOT_ID;
  let s = path.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  return 's_' + s;
}

function esc(label: string): string {
  return label.replace(/["\n\r]/g, ' ').replace(/[;{}#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function transitionLabel(t: TransitionModel): string {
  let ev = t.event;
  if (t.kind === 'always') ev = 'always';
  if (t.kind === 'after') ev = `after ${t.delay}`;
  const parts = [ev];
  if (t.guard) parts.push(`[${t.guard}]`);
  if (t.actions.length) parts.push(`/ ${t.actions.join(', ')}`);
  if (t.reenter) parts.push('(reenter)');
  return esc(parts.join(' '));
}

export interface StateDiagramOptions {
  notes?: boolean;
  direction?: 'TB' | 'LR';
  title?: boolean;
}

/** Mermaid `stateDiagram-v2` for one machine. */
export function stateDiagram(m: MachineModel, opts: StateDiagramOptions = {}): string {
  const notes = opts.notes ?? true;
  const header: string[] = [];
  if (opts.title ?? true) header.push('---', `title: ${m.name}${m.machineId && m.machineId !== m.name ? ` (${m.machineId})` : ''}`, '---');
  header.push('stateDiagram-v2');
  if (opts.direction) header.push(`  direction ${opts.direction}`);
  const transitions: string[] = [];
  let usesRoot = false;

  const emitTransitions = (s: StateNodeModel, id: string) => {
    const all: TransitionModel[] = [...s.transitions, ...s.invoke.flatMap((i) => [...i.onDone, ...i.onError, ...i.onSnapshot])];
    for (const t of all) {
      const label = transitionLabel(t);
      if (t.targets.length === 0) {
        transitions.push(`  ${id} --> ${id} : ${label}${t.description === 'forbidden' ? ' (forbidden)' : ''}`);
        continue;
      }
      for (const target of t.targets) {
        const tid = target.startsWith('#') ? `unknown_${target.replace(/[^A-Za-z0-9_]/g, '_')}` : sid(target);
        transitions.push(`  ${id} --> ${tid} : ${label}`);
      }
    }
  };

  /** Lines declaring this state (alias, composite block, notes) at the given indent. */
  const emitState = (s: StateNodeModel, indent: string): string[] => {
    const id = sid(s.path);
    const out: string[] = [];
    let label = s.key;
    if (s.type === 'history') label = `${s.key} (H${s.history === 'deep' ? '*' : ''})`;
    if (s.type === 'final') label = `${s.key} (final)`;
    if (s.type === 'parallel') label = `${s.key} (parallel)`;
    out.push(`${indent}state "${esc(label)}" as ${id}`);
    if (s.states.length) {
      out.push(`${indent}state ${id} {`);
      if (s.initial && s.type !== 'parallel') out.push(`${indent}  [*] --> ${sid(s.path ? `${s.path}.${s.initial}` : s.initial)}`);
      s.states.forEach((child, i) => {
        if (s.type === 'parallel' && i > 0) out.push(`${indent}  --`);
        out.push(...emitState(child, indent + '  '));
      });
      out.push(`${indent}}`);
    }
    if (notes) {
      const n: string[] = [];
      if (s.entry.length) n.push(`entry / ${s.entry.join(', ')}`);
      if (s.exit.length) n.push(`exit / ${s.exit.join(', ')}`);
      for (const inv of s.invoke) n.push(`invoke ${inv.src}${inv.id && inv.id !== inv.src ? ` as ${inv.id}` : ''}`);
      if (s.tags.length) n.push(`tags: ${s.tags.join(', ')}`);
      if (s.description) n.push(s.description);
      if (n.length) out.push(`${indent}note right of ${id}`, ...n.map((x) => `${indent}  ${esc(x)}`), `${indent}end note`);
    }
    emitTransitions(s, id);
    if (s.type === 'final') transitions.push(`  ${id} --> [*]`);
    return out;
  };

  const body: string[] = [];
  const root = m.root;
  if (root.initial && root.type !== 'parallel') body.push(`  [*] --> ${sid(root.initial)}`);
  root.states.forEach((child, i) => {
    if (root.type === 'parallel' && i > 0) body.push('  --');
    body.push(...emitState(child, '  '));
  });
  const before = transitions.length;
  emitTransitions(root, ROOT_ID);
  if (transitions.length > before) usesRoot = true;
  if (notes) {
    const n: string[] = [];
    if (root.entry.length) n.push(`entry / ${root.entry.join(', ')}`);
    if (root.exit.length) n.push(`exit / ${root.exit.join(', ')}`);
    for (const inv of root.invoke) n.push(`invoke ${inv.src}${inv.id && inv.id !== inv.src ? ` as ${inv.id}` : ''}`);
    if (n.length) {
      usesRoot = true;
      body.push(`  note right of ${ROOT_ID}`, ...n.map((x) => `    ${esc(x)}`), '  end note');
    }
  }
  if (usesRoot) body.unshift(`  state "${esc(m.name)} (root)" as ${ROOT_ID}`);
  return [...header, ...body, ...transitions].join('\n');
}

/* ---------- call graph flowchart ---------- */

const KIND_STYLE: Record<string, string> = {
  component: 'fill:#dbeafe,stroke:#2563eb',
  hook: 'fill:#ede9fe,stroke:#7c3aed',
  function: 'fill:#f1f5f9,stroke:#64748b',
  method: 'fill:#f1f5f9,stroke:#64748b',
  module: 'fill:#fef9c3,stroke:#ca8a04',
  package: 'fill:#fee2e2,stroke:#dc2626',
  builtin: 'fill:#f5f5f4,stroke:#a8a29e',
  machine: 'fill:#dcfce7,stroke:#16a34a',
  external: 'fill:#ffedd5,stroke:#ea580c',
};

function fid(id: string): string {
  return 'n' + hash(id).toString(36);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export interface FlowchartOptions {
  /** Only include these node ids (plus their edges) */
  nodeIds?: Set<string>;
  maxNodes?: number;
  direction?: 'LR' | 'TB';
  groupByFile?: boolean;
}

/** Mermaid flowchart of the call graph (optionally restricted to a node subset). */
export function callGraphFlowchart(a: Analysis, opts: FlowchartOptions = {}): string {
  const dir = opts.direction ?? 'LR';
  let nodes = a.nodes.filter((n) => !opts.nodeIds || opts.nodeIds.has(n.id));
  const max = opts.maxNodes ?? 300;
  if (nodes.length > max) nodes = nodes.slice(0, max);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = a.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const lines = [`flowchart ${dir}`];
  const byFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const g = n.internal ? n.file : n.kind === 'package' ? `pkg: ${n.file}` : n.kind === 'external' ? `external: ${n.external?.category ?? ''}` : '(builtin)';
    if (!byFile.has(g)) byFile.set(g, []);
    byFile.get(g)!.push(n);
  }
  const nodeLine = (n: GraphNode) => {
    const label = esc(n.name) + (n.entry ? ` «${n.entry}»` : '');
    const shape = n.kind === 'machine' ? `{{"${label}"}}` : n.kind === 'external' ? `>"${label}"]` : n.kind === 'package' || n.kind === 'builtin' ? `[("${label}")]` : n.kind === 'component' ? `("${label}")` : `["${label}"]`;
    return `${fid(n.id)}${shape}`;
  };
  if (opts.groupByFile ?? true) {
    let i = 0;
    for (const [file, ns] of byFile) {
      lines.push(`  subgraph g${i++}["${esc(file)}"]`);
      for (const n of ns) lines.push('    ' + nodeLine(n));
      lines.push('  end');
    }
  } else {
    for (const n of nodes) lines.push('  ' + nodeLine(n));
  }
  const arrow = (e: GraphEdge) => {
    switch (e.kind) {
      case 'renders': return '-.->';
      case 'uses-machine': return '==>';
      case 'implements': return '-->';
      case 'invokes': return '==>';
      case 'server-action': return '-->';
      case 'http-route': return '-.->';
      case 'defines': return '-->';
      default: return '-->';
    }
  };
  for (const e of edges) {
    const label = e.kind === 'calls' ? (e.count > 1 ? `|${e.count}x|` : '') : `|${e.kind}|`;
    lines.push(`  ${fid(e.from)} ${arrow(e)}${label} ${fid(e.to)}`);
  }
  for (const [kind, style] of Object.entries(KIND_STYLE)) {
    const members = nodes.filter((n) => n.kind === kind).map((n) => fid(n.id));
    if (members.length) lines.push(`  classDef ${kind} ${style}`, `  class ${members.join(',')} ${kind}`);
  }
  return lines.join('\n');
}
