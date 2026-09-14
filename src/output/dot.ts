import type { Analysis, GraphNode } from '../model.js';

const FILL: Record<string, string> = {
  component: '#dbeafe',
  hook: '#ede9fe',
  function: '#f1f5f9',
  method: '#f1f5f9',
  module: '#fef9c3',
  package: '#fee2e2',
  builtin: '#f5f5f4',
  machine: '#dcfce7',
  external: '#ffedd5',
};

function q(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export interface DotOptions {
  nodeIds?: Set<string>;
  rankdir?: 'LR' | 'TB';
}

/** Graphviz DOT with a cluster per file / package. */
export function callGraphDot(a: Analysis, opts: DotOptions = {}): string {
  const nodes = a.nodes.filter((n) => !opts.nodeIds || opts.nodeIds.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = a.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const lines = [
    'digraph callgraph {',
    `  rankdir=${opts.rankdir ?? 'LR'};`,
    '  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=10];',
    '  edge [fontname="Helvetica", fontsize=8, color="#64748b"];',
    '  compound=true;',
  ];
  const groups = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const g = n.internal ? n.file : n.kind === 'package' ? `pkg: ${n.file}` : n.kind === 'external' ? `external: ${n.external?.category ?? ''}` : '(builtin)';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }
  let i = 0;
  for (const [g, ns] of groups) {
    lines.push(`  subgraph cluster_${i++} {`, `    label=${q(g)}; color="#cbd5e1"; fontname="Helvetica"; fontsize=9;`);
    for (const n of ns) {
      const label = n.name + (n.entry ? `\\n«${n.entry}${n.route ? ' ' + n.route : ''}»` : '');
      const shape = n.kind === 'machine' ? 'hexagon' : n.kind === 'external' ? 'cds' : n.kind === 'package' || n.kind === 'builtin' ? 'cylinder' : n.kind === 'component' ? 'ellipse' : 'box';
      lines.push(`    ${q(n.id)} [label=${q(label)}, shape=${shape}, fillcolor="${FILL[n.kind] ?? '#fff'}"];`);
    }
    lines.push('  }');
  }
  for (const e of edges) {
    const attrs: string[] = [];
    if (e.kind !== 'calls') attrs.push(`label=${q(e.kind)}`);
    else if (e.count > 1) attrs.push(`label="${e.count}x"`);
    if (e.kind === 'renders') attrs.push('style=dashed, color="#2563eb"');
    if (e.kind === 'uses-machine' || e.kind === 'invokes') attrs.push('color="#16a34a", penwidth=2');
    if (e.kind === 'implements') attrs.push('color="#16a34a", style=dotted');
    if (e.kind === 'server-action' || e.kind === 'http-route') attrs.push('color="#dc2626", style=dashed');
    if (e.kind === 'external') attrs.push('color="#ea580c"');
    if (e.kind === 'defines') attrs.push('color="#16a34a", style=dashed');
    lines.push(`  ${q(e.from)} -> ${q(e.to)}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
  }
  lines.push('}');
  return lines.join('\n');
}
