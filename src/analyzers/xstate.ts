import { Node, SyntaxKind } from 'ts-morph';
import type { InvokeModel, MachineImplementations, MachineModel, StateNodeModel, TransitionModel } from '../model.js';
import { stateDiagram } from '../output/mermaid.js';
import type { CallSite, EdgeSet } from './calls.js';
import { functionOfInitializer, nodeKey } from './calls.js';
import { NodeRegistry, isFunctionLike, unwrapExpr } from './functions.js';

type CallExpr = import('ts-morph').CallExpression;
type ObjLit = import('ts-morph').ObjectLiteralExpression;

const USE_MACHINE_CALLS = new Set([
  'useMachine', 'useActor', 'useActorRef', 'useInterpret', 'createActor', 'interpret', 'createActorContext',
  'spawn', 'spawnChild', 'useSpawn', 'createBrowserInspector',
]);

export interface XStateContext {
  registry: NodeRegistry;
  edges: EdgeSet;
  warnings: string[];
}

/* ---------- literal helpers ---------- */

function str(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  const u = unwrapExpr(n);
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return u.getLiteralText();
  if (Node.isNumericLiteral(u)) return u.getLiteralText();
  if (Node.isTemplateExpression(u)) return u.getText().slice(1, -1);
  if (Node.isIdentifier(u)) {
    // const ID = 'x'
    const init = resolveIdentifierInitializer(u);
    if (init && init !== u) return str(init) ?? u.getText();
    return u.getText();
  }
  if (Node.isPropertyAccessExpression(u)) return u.getText();
  return undefined;
}

function strList(n: Node | undefined): string[] {
  if (!n) return [];
  const u = unwrapExpr(n);
  if (Node.isArrayLiteralExpression(u)) return u.getElements().flatMap((e) => strList(e));
  const s = str(u);
  return s !== undefined ? [s] : [];
}

/** Follow an identifier to its initializer (const X = {...}), across files if needed. */
export function resolveIdentifierInitializer(id: Node, depth = 0): Node | undefined {
  if (depth > 5) return undefined;
  let sym = id.getSymbol();
  try {
    if (sym && (sym.getFlags() & 0x200000) !== 0) sym = sym.getAliasedSymbol() ?? sym;
  } catch {
    /* ignore */
  }
  for (const d of sym?.getDeclarations() ?? []) {
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      if (!init) continue;
      const u = unwrapExpr(init);
      if (Node.isIdentifier(u)) return resolveIdentifierInitializer(u, depth + 1) ?? u;
      return u;
    }
    if (Node.isPropertyAssignment(d)) return unwrapExpr(d.getInitializerOrThrow());
    if (Node.isShorthandPropertyAssignment(d)) {
      const vs = d.getValueSymbol();
      const vd = vs?.getDeclarations().find((x) => Node.isVariableDeclaration(x));
      if (vd && Node.isVariableDeclaration(vd) && vd.getInitializer()) return unwrapExpr(vd.getInitializer()!);
    }
    if (Node.isExportAssignment(d)) return unwrapExpr(d.getExpression());
    if (isFunctionLike(d)) return d;
  }
  return undefined;
}

function asObject(n: Node | undefined, depth = 0): ObjLit | undefined {
  if (!n || depth > 5) return undefined;
  const u = unwrapExpr(n);
  if (Node.isObjectLiteralExpression(u)) return u;
  if (Node.isIdentifier(u)) return asObject(resolveIdentifierInitializer(u), depth + 1);
  if (Node.isCallExpression(u)) {
    // e.g. createMachine(config) where config = defineConfig({...})
    const arg = u.getArguments()[0];
    if (arg) return asObject(arg, depth + 1);
  }
  return undefined;
}

/** Object literal properties as a name -> initializer map (spreads of resolvable objects are merged). */
function props(obj: ObjLit | undefined): Map<string, Node> {
  const m = new Map<string, Node>();
  if (!obj) return m;
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p)) {
      const init = p.getInitializer();
      if (init) m.set(propName(p), init);
    } else if (Node.isShorthandPropertyAssignment(p)) {
      m.set(p.getName(), p.getNameNode());
    } else if (Node.isMethodDeclaration(p)) {
      m.set(propName(p), p);
    } else if (Node.isSpreadAssignment(p)) {
      const inner = asObject(p.getExpression());
      if (inner) for (const [k, v] of props(inner)) m.set(k, v);
    }
  }
  return m;
}

function propName(p: Node): string {
  const nn = (p as any).getNameNode?.() as Node | undefined;
  if (!nn) return (p as any).getName?.() ?? '?';
  if (Node.isComputedPropertyName(nn)) return str(nn.getExpression()) ?? nn.getText();
  if (Node.isStringLiteral(nn) || Node.isNumericLiteral(nn)) return nn.getLiteralText();
  return nn.getText();
}

/* ---------- action / guard summaries ---------- */

function summarizeArg(a: Node | undefined): string {
  if (!a) return '';
  const u = unwrapExpr(a);
  const s = str(u);
  if (s !== undefined && !Node.isPropertyAccessExpression(u)) return s;
  if (Node.isObjectLiteralExpression(u)) {
    const type = props(u).get('type');
    const t = str(type);
    if (t) return t;
    return '{…}';
  }
  if (isFunctionLike(u)) return 'fn';
  return u.getText().replace(/\s+/g, ' ').slice(0, 30);
}

function actionName(n: Node | undefined, ctx: XStateContext | ParseCtx, implNodes: Record<string, string>): string | undefined {
  if (!n) return undefined;
  const u = unwrapExpr(n);
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return u.getLiteralText();
  if (Node.isIdentifier(u)) return u.getText();
  if (Node.isObjectLiteralExpression(u)) {
    const t = str(props(u).get('type'));
    return t ?? '{…}';
  }
  if (Node.isCallExpression(u)) {
    const callee = unwrapExpr(u.getExpression());
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    const args = u.getArguments();
    switch (name) {
      case 'assign':
      case 'log':
      case 'enqueueActions':
      case 'cancel':
      case 'stop':
      case 'stopChild':
      case 'forwardTo':
      case 'escalate':
      case 'choose':
      case 'pure':
        registerInlineFns(u, ctx, implNodes, name);
        return name === 'assign' ? `assign(${assignKeys(args[0])})` : name;
      case 'raise':
      case 'sendParent':
      case 'emit':
        return `${name}(${summarizeArg(args[0])})`;
      case 'sendTo':
        return `sendTo(${summarizeArg(args[0])}, ${summarizeArg(args[1])})`;
      case 'spawnChild':
      case 'spawn': {
        const pc = ctx as Partial<ParseCtx>;
        const a0 = args[0] ? unwrapExpr(args[0]) : undefined;
        if (a0 && pc.actorMap && pc.machineRefs) {
          const ref = (Node.isStringLiteral(a0) || Node.isNoSubstitutionTemplateLiteral(a0)) ? pc.actorMap.get(a0.getLiteralText()) : machineIdOfExpression(a0, ctx.registry);
          if (ref) pc.machineRefs.add(ref);
        }
        return `${name}(${summarizeArg(args[0])})`;
      }
      default:
        return `${name}(${args.map(summarizeArg).join(', ')})`;
    }
  }
  if (isFunctionLike(u)) {
    const node = ctx.registry.functionNode(u);
    if (node) {
      implNodes[`inline.${node.name}`] = node.id;
      return node.name.split('.').pop() ?? 'inline';
    }
    return `inline@${u.getStartLineNumber()}`;
  }
  if (Node.isPropertyAccessExpression(u)) return u.getText();
  return u.getText().slice(0, 30);
}

function assignKeys(arg: Node | undefined): string {
  const o = arg ? asObject(arg) : undefined;
  if (!o) return arg && isFunctionLike(unwrapExpr(arg)) ? 'fn' : '…';
  return [...props(o).keys()].slice(0, 4).join(', ') + (props(o).size > 4 ? ', …' : '');
}

function registerInlineFns(call: CallExpr, ctx: XStateContext, implNodes: Record<string, string>, label: string) {
  for (const a of call.getArguments()) {
    const u = unwrapExpr(a);
    if (isFunctionLike(u)) {
      const node = ctx.registry.functionNode(u);
      if (node) implNodes[`${label}.${node.name}`] = node.id;
    } else if (Node.isObjectLiteralExpression(u)) {
      for (const [k, v] of props(u)) {
        const f = functionOfInitializer(v);
        if (f) {
          const node = ctx.registry.functionNode(f);
          if (node) implNodes[`${label}.${k}`] = node.id;
        }
      }
    }
  }
}

function actionList(n: Node | undefined, ctx: XStateContext | ParseCtx, implNodes: Record<string, string>): string[] {
  if (!n) return [];
  const u = unwrapExpr(n);
  if (Node.isArrayLiteralExpression(u)) return u.getElements().flatMap((e) => actionList(e, ctx, implNodes));
  const a = actionName(u, ctx, implNodes);
  return a ? [a] : [];
}

function guardName(n: Node | undefined, ctx: XStateContext, implNodes: Record<string, string>): string | undefined {
  if (!n) return undefined;
  const u = unwrapExpr(n);
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return u.getLiteralText();
  if (Node.isIdentifier(u)) return u.getText();
  if (Node.isObjectLiteralExpression(u)) return str(props(u).get('type')) ?? '{…}';
  if (Node.isCallExpression(u)) {
    const callee = unwrapExpr(u.getExpression());
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    const args = u.getArguments();
    if (name === 'and' || name === 'or') {
      const arr = args[0] ? unwrapExpr(args[0]) : undefined;
      const items = arr && Node.isArrayLiteralExpression(arr) ? arr.getElements().map((e) => guardName(e, ctx, implNodes) ?? '?') : ['…'];
      return `${name}(${items.join(', ')})`;
    }
    if (name === 'not') return `not(${guardName(args[0], ctx, implNodes) ?? '?'})`;
    if (name === 'stateIn') return `stateIn(${summarizeArg(args[0])})`;
    return `${name}(${args.map(summarizeArg).join(', ')})`;
  }
  if (isFunctionLike(u)) {
    const node = ctx.registry.functionNode(u);
    if (node) {
      implNodes[`inline.${node.name}`] = node.id;
      return node.name.split('.').pop();
    }
    return `inline@${u.getStartLineNumber()}`;
  }
  return u.getText().slice(0, 30);
}

/* ---------- state tree parsing ---------- */

interface ParseCtx extends XStateContext {
  implNodes: Record<string, string>;
  events: Set<string>;
  machineRefs: Set<string>;
  /** actor/service implementation name -> machine graph id (from setup({actors}) / options.services) */
  actorMap: Map<string, string>;
  version: 4 | 5;
}

function parseTransitions(n: Node | undefined, event: string, kind: TransitionModel['kind'], pc: ParseCtx, delay?: string): TransitionModel[] {
  if (!n) return [];
  const u = unwrapExpr(n);
  if (Node.isArrayLiteralExpression(u)) return u.getElements().flatMap((e) => parseTransitions(e, event, kind, pc, delay));
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) {
    return [{ event, kind, targets: [], rawTargets: [u.getLiteralText()], actions: [], delay }];
  }
  if (Node.isIdentifier(u)) {
    const init = resolveIdentifierInitializer(u);
    if (init && init !== u) return parseTransitions(init, event, kind, pc, delay);
    return [{ event, kind, targets: [], rawTargets: [], actions: [], delay, description: `ref ${u.getText()}` }];
  }
  if (Node.isObjectLiteralExpression(u)) {
    const p = props(u);
    const t: TransitionModel = {
      event,
      kind,
      targets: [],
      rawTargets: strList(p.get('target')),
      actions: actionList(p.get('actions'), pc, pc.implNodes),
      guard: guardName(p.get('guard') ?? p.get('cond'), pc, pc.implNodes),
      delay,
      description: str(p.get('description')),
    };
    const reenter = p.get('reenter');
    const internal = p.get('internal');
    if (reenter) t.reenter = unwrapExpr(reenter).getKind() === SyntaxKind.TrueKeyword;
    else if (internal) t.reenter = unwrapExpr(internal).getKind() === SyntaxKind.FalseKeyword;
    if (t.rawTargets.length === 0 && !t.actions.length && !t.guard && !p.has('target')) {
      // { } - forbidden transition or empty
    }
    return [t];
  }
  if (Node.isNullLiteral(u) || u.getKind() === SyntaxKind.UndefinedKeyword) {
    return [{ event, kind, targets: [], rawTargets: [], actions: [], delay, description: 'forbidden' }];
  }
  if (isFunctionLike(u)) {
    // v4 `on: { X: { actions: fn } }` shorthand is not valid, but tolerate
    return [{ event, kind, targets: [], rawTargets: [], actions: actionList(u, pc, pc.implNodes), delay }];
  }
  return [{ event, kind, targets: [], rawTargets: [], actions: [], delay, description: `unparsed: ${u.getText().slice(0, 30)}` }];
}

function parseInvoke(n: Node | undefined, pc: ParseCtx): InvokeModel[] {
  if (!n) return [];
  const u = unwrapExpr(n);
  if (Node.isArrayLiteralExpression(u)) return u.getElements().flatMap((e) => parseInvoke(e, pc));
  const obj = asObject(u);
  if (!obj) {
    if (Node.isIdentifier(u)) return [{ src: u.getText(), onDone: [], onError: [], onSnapshot: [] }];
    return [];
  }
  const p = props(obj);
  const srcNode = p.get('src');
  let src = '?';
  let machineRef: string | undefined;
  if (srcNode) {
    const su = unwrapExpr(srcNode);
    if (Node.isStringLiteral(su) || Node.isNoSubstitutionTemplateLiteral(su)) {
      src = su.getLiteralText();
      machineRef = pc.actorMap?.get(src);
    } else if (Node.isIdentifier(su)) {
      src = su.getText();
      machineRef = machineIdOfExpression(su, pc.registry);
    } else if (Node.isCallExpression(su)) {
      const callee = unwrapExpr(su.getExpression());
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      src = `${name}(inline)`;
      registerInlineFns(su, pc, pc.implNodes, `invoke.${name}`);
    } else if (isFunctionLike(su)) {
      const node = pc.registry.functionNode(su);
      src = node ? node.name.split('.').pop()! : `inline@${su.getStartLineNumber()}`;
      if (node) pc.implNodes[`invoke.${node.name}`] = node.id;
    } else {
      src = su.getText().slice(0, 40);
    }
  }
  if (machineRef) pc.machineRefs.add(machineRef);
  const id = str(p.get('id'));
  const label = id ?? src;
  return [
    {
      src,
      id,
      machineRef,
      onDone: parseTransitions(p.get('onDone'), `done: ${label}`, 'onDone', pc),
      onError: parseTransitions(p.get('onError'), `error: ${label}`, 'onError', pc),
      onSnapshot: parseTransitions(p.get('onSnapshot'), `snapshot: ${label}`, 'onSnapshot', pc),
    },
  ];
}

function parseState(obj: ObjLit | undefined, key: string, path: string, pc: ParseCtx): StateNodeModel {
  const p = props(obj);
  const statesObj = asObject(p.get('states'));
  const typeStr = str(p.get('type'));
  const states: StateNodeModel[] = [];
  if (statesObj) {
    for (const [k, v] of props(statesObj)) {
      states.push(parseState(asObject(v), k, path ? `${path}.${k}` : k, pc));
    }
  }
  let type: StateNodeModel['type'] = 'atomic';
  if (typeStr === 'parallel' || typeStr === 'final' || typeStr === 'history') type = typeStr;
  else if (states.length) type = 'compound';

  const transitions: TransitionModel[] = [];
  const onObj = asObject(p.get('on'));
  if (onObj) {
    for (const [ev, v] of props(onObj)) {
      pc.events.add(ev);
      transitions.push(...parseTransitions(v, ev, 'on', pc));
    }
  }
  transitions.push(...parseTransitions(p.get('always'), '', 'always', pc));
  const afterObj = asObject(p.get('after'));
  if (afterObj) {
    for (const [delay, v] of props(afterObj)) transitions.push(...parseTransitions(v, `after ${delay}`, 'after', pc, delay));
  }
  transitions.push(...parseTransitions(p.get('onDone'), 'done', 'onDone', pc));

  const node: StateNodeModel = {
    key,
    path,
    id: str(p.get('id')),
    type,
    initial: str(p.get('initial')),
    history: (str(p.get('history')) as 'shallow' | 'deep' | undefined) ?? (type === 'history' ? 'shallow' : undefined),
    entry: actionList(p.get('entry'), pc, pc.implNodes),
    exit: actionList(p.get('exit'), pc, pc.implNodes),
    invoke: parseInvoke(p.get('invoke'), pc),
    transitions,
    states,
    tags: strList(p.get('tags')),
    description: str(p.get('description')),
  };
  return node;
}

/* ---------- target resolution ---------- */

function indexStates(root: StateNodeModel): { byPath: Map<string, StateNodeModel>; byId: Map<string, StateNodeModel> } {
  const byPath = new Map<string, StateNodeModel>();
  const byId = new Map<string, StateNodeModel>();
  const walk = (s: StateNodeModel) => {
    byPath.set(s.path, s);
    if (s.id) byId.set(s.id, s);
    s.states.forEach(walk);
  };
  walk(root);
  return { byPath, byId };
}

function resolveTargets(root: StateNodeModel, machineId: string | undefined, warnings: string[], name: string) {
  const { byPath, byId } = indexStates(root);
  const resolveOne = (raw: string, from: StateNodeModel): string | undefined => {
    if (raw.startsWith('#')) {
      const [id, ...rest] = raw.slice(1).split('.');
      const base = byId.get(id) ?? (id === machineId ? root : undefined);
      if (!base) return raw; // unknown id, keep as-is
      const p = rest.length ? [base.path, ...rest].filter(Boolean).join('.') : base.path;
      return p;
    }
    if (raw.startsWith('.')) {
      return from.path ? `${from.path}${raw}` : raw.slice(1);
    }
    // sibling relative to parent (root-level transitions target root children)
    const parentPath = from.path.includes('.') ? from.path.slice(0, from.path.lastIndexOf('.')) : '';
    const candidate = parentPath ? `${parentPath}.${raw}` : raw;
    if (byPath.has(candidate)) return candidate;
    // v4 allowed targeting own children by key in some cases; try child
    const child = from.path ? `${from.path}.${raw}` : raw;
    if (byPath.has(child)) return child;
    if (byId.has(raw)) return byId.get(raw)!.path;
    warnings.push(`xstate ${name}: cannot resolve target '${raw}' from state '${from.path || '(root)'}'`);
    return candidate;
  };
  const walk = (s: StateNodeModel) => {
    const all = [...s.transitions, ...s.invoke.flatMap((i) => [...i.onDone, ...i.onError, ...i.onSnapshot])];
    for (const t of all) {
      t.targets = t.rawTargets.map((r) => resolveOne(r, s)).filter((x): x is string => x !== undefined);
    }
    s.states.forEach(walk);
  };
  walk(root);
}

/* ---------- machine identity ---------- */

function isMachineCall(call: CallExpr): { api: MachineModel['api']; setupCall?: CallExpr } | undefined {
  const callee = unwrapExpr(call.getExpression());
  if (Node.isIdentifier(callee)) {
    const n = callee.getText();
    if (n === 'createMachine') return { api: 'createMachine' };
    if (n === 'Machine') return { api: 'Machine' };
    return undefined;
  }
  if (Node.isPropertyAccessExpression(callee)) {
    const name = callee.getName();
    if (name !== 'createMachine' && name !== 'Machine') return undefined;
    const recv = unwrapExpr(callee.getExpression());
    if (Node.isCallExpression(recv)) {
      const rc = unwrapExpr(recv.getExpression());
      const rn = Node.isPropertyAccessExpression(rc) ? rc.getName() : rc.getText();
      if (rn === 'setup') return { api: 'setup().createMachine', setupCall: recv };
    }
    if (Node.isIdentifier(recv)) {
      // const m = setup({...}); m.createMachine({...})  or  xstate.createMachine
      const init = resolveIdentifierInitializer(recv);
      if (init && Node.isCallExpression(init)) {
        const rc = unwrapExpr(init.getExpression());
        const rn = Node.isPropertyAccessExpression(rc) ? rc.getName() : rc.getText();
        if (rn === 'setup') return { api: 'setup().createMachine', setupCall: init };
      }
      return { api: name === 'Machine' ? 'Machine' : 'createMachine' };
    }
  }
  return undefined;
}

/** Name for a machine: the variable it is assigned to, else `default`, else config id. */
function machineVariableName(call: CallExpr): string | undefined {
  let cur: Node | undefined = call;
  let parent = cur.getParent();
  while (parent) {
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isExportAssignment(parent)) return 'default';
    if (Node.isPropertyAssignment(parent)) return propName(parent);
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      (Node.isCallExpression(parent) && /\.(provide|withConfig|withContext)$/.test(parent.getExpression().getText())) ||
      (Node.isPropertyAccessExpression(parent) && /^(provide|withConfig|withContext)$/.test(parent.getName()))
    ) {
      cur = parent;
      parent = parent.getParent();
      continue;
    }
    break;
  }
  return undefined;
}

export function machineIdForCall(call: CallExpr, registry: NodeRegistry): string {
  const file = registry.relPath(call.getSourceFile());
  const name = machineVariableName(call) ?? str(props(asObject(call.getArguments()[0])).get('id')) ?? `machine@${call.getStartLineNumber()}`;
  return `machine:${file}#${name}`;
}

/** If an expression (identifier / call) denotes a machine, return its graph id. */
export function machineIdOfExpression(expr: Node, registry: NodeRegistry, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  const u = unwrapExpr(expr);
  if (Node.isCallExpression(u)) {
    if (isMachineCall(u)) return machineIdForCall(u, registry);
    // machine.provide({...}) / createActorContext(machine) / machine.withConfig
    const callee = unwrapExpr(u.getExpression());
    if (Node.isPropertyAccessExpression(callee) && /^(provide|withConfig|withContext)$/.test(callee.getName())) {
      return machineIdOfExpression(callee.getExpression(), registry, depth + 1);
    }
    return undefined;
  }
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const init = resolveIdentifierInitializer(u, depth);
    if (init && init !== u) return machineIdOfExpression(init, registry, depth + 1);
  }
  return undefined;
}

/* ---------- implementations ---------- */

function collectImplementations(obj: ObjLit | undefined, impl: MachineImplementations, implNodes: Record<string, string>, registry: NodeRegistry, actorMap: Map<string, string>) {
  if (!obj) return;
  const p = props(obj);
  const groups: [keyof MachineImplementations, string[]][] = [
    ['actions', ['actions']],
    ['guards', ['guards']],
    ['actors', ['actors', 'services']],
    ['delays', ['delays']],
  ];
  for (const [group, keys] of groups) {
    for (const k of keys) {
      const g = asObject(p.get(k));
      if (!g) continue;
      for (const [name, v] of props(g)) {
        if (!impl[group].includes(name)) impl[group].push(name);
        const fn = functionOfInitializer(v);
        if (fn) {
          const node = registry.functionNode(fn);
          if (node) {
            implNodes[`${group}.${name}`] = node.id;
            // declared implementations are first-class nodes, never pruned
            node.tags = (node.tags ?? []).filter((t) => t !== 'inline');
            if (!node.tags.includes(`xstate:${group}`)) node.tags.push(`xstate:${group}`);
          }
        }
        if (group === 'actors') {
          const ref = machineIdOfExpression(v, registry);
          if (ref) actorMap.set(name, ref);
        }
      }
    }
  }
}

/* ---------- entry point ---------- */

export interface MachineUsage {
  ownerId: string;
  machineRef: string;
  line: number;
}

/** Pass 1 (per file): find and parse machine definitions in the given call sites. */
export function findMachines(sites: CallSite[], ctx: XStateContext): MachineModel[] {
  const { registry, edges } = ctx;
  const machines: MachineModel[] = [];
  const seen = new Set<string>();

  for (const site of sites) {
    if (site.isNew || !Node.isCallExpression(site.call)) continue;
    const call = site.call;
    const info = isMachineCall(call);
    if (!info) continue;
    // must come from xstate (or be unresolvable, in which case trust the name)
    const pkg = site.resolution.package;
    if (site.resolution.kind === 'package' && pkg && pkg !== 'xstate' && !pkg.startsWith('@xstate/')) continue;
    const id = machineIdForCall(call, registry);
    if (seen.has(id)) continue;
    seen.add(id);

    const sf = call.getSourceFile();
    const file = registry.relPath(sf);
    const name = id.slice(id.indexOf('#') + 1);
    const configObj = asObject(call.getArguments()[0]);
    if (!configObj) {
      ctx.warnings.push(`xstate: could not statically read config of machine ${name} in ${file}:${call.getStartLineNumber()}`);
    }
    const impl: MachineImplementations = { actions: [], guards: [], actors: [], delays: [] };
    const implNodes: Record<string, string> = {};
    const actorMap = new Map<string, string>();
    let version: 4 | 5 = info.api === 'Machine' ? 4 : 5;
    if (info.setupCall) collectImplementations(asObject(info.setupCall.getArguments()[0]), impl, implNodes, registry, actorMap);
    const second = call.getArguments()[1];
    if (second) {
      const o = asObject(second);
      if (o) {
        if (props(o).has('services') || props(o).has('activities')) version = 4;
        collectImplementations(o, impl, implNodes, registry, actorMap);
      }
    }
    // .provide({...}) / .withConfig({...}) chained on this machine
    const factoryCalls = new Set<Node>([call, ...(info.setupCall ? [info.setupCall] : [])]);
    let chain: Node | undefined = call.getParent();
    while (chain && (Node.isPropertyAccessExpression(chain) || Node.isCallExpression(chain) || Node.isParenthesizedExpression(chain))) {
      if (Node.isCallExpression(chain)) {
        const ce = unwrapExpr(chain.getExpression());
        if (Node.isPropertyAccessExpression(ce) && /^(provide|withConfig|withContext)$/.test(ce.getName())) {
          collectImplementations(asObject(chain.getArguments()[0]), impl, implNodes, registry, actorMap);
          factoryCalls.add(chain);
        }
      }
      chain = chain.getParent();
    }
    const cfgProps = props(configObj);
    if (cfgProps.has('predictableActionArguments') || cfgProps.has('preserveActionOrder') || cfgProps.has('schema')) version = 4;

    const pc: ParseCtx = { ...ctx, implNodes, events: new Set(), machineRefs: new Set(), version, actorMap };
    const root = parseState(configObj, name, '', pc);
    resolveTargets(root, root.id, ctx.warnings, name);

    const model: MachineModel = {
      id,
      name,
      machineId: root.id,
      file,
      line: call.getStartLineNumber(),
      version,
      api: info.api,
      root,
      implementations: impl,
      implementationNodes: implNodes,
      events: [...pc.events].sort(),
      usedBy: [],
      invokes: [...pc.machineRefs],
      mermaid: '',
    };
    model.mermaid = stateDiagram(model);
    machines.push(model);

    registry.nodes.set(id, {
      id,
      kind: 'machine',
      name,
      file,
      package: registry.packageOf(sf),
      line: model.line,
      internal: true,
      exported: true,
      tags: [`xstate v${version}`],
    });
    for (const nid of Object.values(implNodes)) edges.add(id, nid, 'implements', model.line);

    // the scope evaluating createMachine(...) defines the machine; the factory-call edges into xstate are noise
    edges.add(site.owner.id, id, 'defines', model.line);
    for (const other of sites) {
      if (!factoryCalls.has(other.call)) continue;
      if (other.resolution.kind === 'package' && other.resolution.package && other.resolution.member) {
        edges.remove(other.owner.id, `pkg:${other.resolution.package}#${other.resolution.member}`, 'calls');
      }
    }
  }
  return machines;
}

/** Pass 1b (per file): call sites that use a machine (useMachine, createActor, spawn, Context.useSelector ...). */
export function findMachineUsages(sites: CallSite[], registry: NodeRegistry): MachineUsage[] {
  const out: MachineUsage[] = [];
  for (const site of sites) {
    if (!Node.isCallExpression(site.call)) continue;
    const call = site.call;
    const callee = unwrapExpr(call.getExpression());
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    let machineRef: string | undefined;
    if (USE_MACHINE_CALLS.has(name)) {
      const arg = call.getArguments()[0];
      if (arg) machineRef = machineIdOfExpression(arg, registry);
    } else if (Node.isPropertyAccessExpression(callee) && /^(useActorRef|useSelector|useActor)$/.test(name)) {
      // SomeContext.useActorRef() where SomeContext = createActorContext(machine)
      const init = resolveIdentifierInitializer(callee.getExpression());
      if (init && Node.isCallExpression(init)) {
        const ic = unwrapExpr(init.getExpression());
        const iname = Node.isPropertyAccessExpression(ic) ? ic.getName() : ic.getText();
        if (iname === 'createActorContext') {
          const a = init.getArguments()[0];
          if (a) machineRef = machineIdOfExpression(a, registry);
        }
      }
    }
    if (machineRef && site.owner.id !== machineRef) out.push({ ownerId: site.owner.id, machineRef, line: site.line });
  }
  return out;
}

/** Pass 2 (workspace-wide): link machine -> machine invokes and usage edges. */
export function linkMachines(machines: MachineModel[], usages: MachineUsage[], edges: EdgeSet) {
  const byId = new Map(machines.map((m) => [m.id, m]));
  for (const m of machines) {
    for (const ref of m.invokes) if (byId.has(ref)) edges.add(m.id, ref, 'invokes', m.line);
  }
  for (const u of usages) {
    const m = byId.get(u.machineRef);
    if (!m) continue;
    if (!m.usedBy.includes(u.ownerId)) m.usedBy.push(u.ownerId);
    edges.add(u.ownerId, m.id, 'uses-machine', u.line);
  }
}
