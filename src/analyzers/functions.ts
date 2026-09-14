import * as path from 'node:path';
import { Node, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { GraphNode, NodeKind } from '../model.js';
import { isTsLibFile, nearestPackageName, normalize, packageNameFromPath, toRel } from '../project.js';

export type FunctionLike =
  | import('ts-morph').FunctionDeclaration
  | import('ts-morph').FunctionExpression
  | import('ts-morph').ArrowFunction
  | import('ts-morph').MethodDeclaration
  | import('ts-morph').ConstructorDeclaration
  | import('ts-morph').GetAccessorDeclaration
  | import('ts-morph').SetAccessorDeclaration;

export function isFunctionLike(n: Node | undefined): n is FunctionLike {
  return (
    !!n &&
    (Node.isFunctionDeclaration(n) ||
      Node.isFunctionExpression(n) ||
      Node.isArrowFunction(n) ||
      Node.isMethodDeclaration(n) ||
      Node.isConstructorDeclaration(n) ||
      Node.isGetAccessorDeclaration(n) ||
      Node.isSetAccessorDeclaration(n))
  );
}

/** Skip parens / type assertions between a function and its meaningful parent. */
function meaningfulParent(n: Node): Node | undefined {
  let p = n.getParent();
  while (
    p &&
    (Node.isParenthesizedExpression(p) ||
      Node.isAsExpression(p) ||
      Node.isSatisfiesExpression(p) ||
      Node.isTypeAssertion(p) ||
      Node.isNonNullExpression(p) ||
      Node.isAwaitExpression(p))
  ) {
    p = p.getParent();
  }
  return p;
}

function propertyNameText(n: Node): string {
  const name = (n as any).getNameNode?.() as Node | undefined;
  if (!name) return (n as any).getName?.() ?? '?';
  if (Node.isComputedPropertyName(name)) {
    const inner = name.getExpression();
    if (Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)) return inner.getLiteralText();
    return `[${inner.getText()}]`;
  }
  if (Node.isStringLiteral(name) || Node.isNumericLiteral(name)) return name.getLiteralText();
  return name.getText();
}

/**
 * Wrapper calls whose first function argument should take the name of the
 * variable/property the call result is assigned to, even inside a function body:
 * `const Foo = memo(() => ...)`, `const cb = useCallback(() => ...)`, `fetchUser: fromPromise(...)`.
 * Any wrapper is accepted at module scope or when assigned to an object property.
 */
const NAMED_WRAPPERS = new Set([
  'memo', 'forwardRef', 'useCallback', 'lazy', 'cache', 'observer', 'styled',
  'fromPromise', 'fromCallback', 'fromObservable', 'fromEventObservable', 'fromTransition', 'assign', 'enqueueActions',
  'createAsyncThunk', 'createSelector', 'server$', 'createServerFn', 'action', 'loader', 'debounce', 'throttle',
  'wrap', 'withErrorBoundary', 'withAuth', 'connect', 'withRouter', 'dynamic', 'createStore', 'create',
]);

function calleeBaseName(call: import('ts-morph').CallExpression): string {
  const e = unwrapExpr(call.getExpression());
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isPropertyAccessExpression(e)) return e.getName();
  return e.getText();
}

interface OwnName {
  name: string;
  source: 'decl' | 'method' | 'var' | 'prop' | 'default' | 'assign' | 'wrapper' | 'field';
}

/**
 * Name of a function-like node derived from how it is declared or assigned.
 * Returns undefined for anonymous inline callbacks (those fold into their owner).
 */
export function ownName(fn: FunctionLike): OwnName | undefined {
  if (Node.isFunctionDeclaration(fn)) {
    const n = fn.getName();
    if (n) return { name: n, source: 'decl' };
    return fn.isDefaultExport() ? { name: 'default', source: 'default' } : undefined;
  }
  if (Node.isConstructorDeclaration(fn)) return { name: 'constructor', source: 'method' };
  if (Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    return { name: propertyNameText(fn), source: 'method' };
  }
  // arrow / function expression
  let node: Node = fn;
  let parent = meaningfulParent(node);
  // Walk up through wrapper calls: memo(() => ...), forwardRef(...), fromPromise(...), useCallback(...)
  let viaWrapper = false;
  let knownWrapper = false;
  while (parent && Node.isCallExpression(parent)) {
    const args = parent.getArguments();
    // node must be the first function-like (or wrapper-chain) argument of the call
    const primary = args.find((a) => {
      const u = unwrapExpr(a);
      return u === node || isFunctionLike(u);
    });
    if (!primary || unwrapExpr(primary) !== node) return fallbackExpressionName(fn);
    viaWrapper = true;
    if (NAMED_WRAPPERS.has(calleeBaseName(parent))) knownWrapper = true;
    node = parent;
    parent = meaningfulParent(node);
    // `useEffect(() => {}, [])` as a statement has no assignment parent -> anonymous
  }
  if (!parent) return fallbackExpressionName(fn);
  const src = viaWrapper ? 'wrapper' : undefined;
  if (Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (!Node.isIdentifier(nameNode)) return fallbackExpressionName(fn);
    if (viaWrapper && !knownWrapper) {
      // `const rows = list.map(() => ...)` inside a function is not a function definition
      const atModuleScope = parent.getVariableStatement()?.getParent() && Node.isSourceFile(parent.getVariableStatement()!.getParent());
      if (!atModuleScope) return fallbackExpressionName(fn);
    }
    return { name: nameNode.getText(), source: src ?? 'var' };
  }
  if (Node.isPropertyAssignment(parent)) return { name: propertyNameText(parent), source: src ?? 'prop' };
  if (Node.isPropertyDeclaration(parent)) return { name: propertyNameText(parent), source: src ?? 'field' };
  if (Node.isExportAssignment(parent)) return { name: 'default', source: 'default' };
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
    const left = parent.getLeft().getText();
    if (/^module\.exports$/.test(left)) return { name: 'default', source: 'default' };
    const m = left.match(/^(?:module\.exports|exports)\.(\w+)$/);
    if (m) return { name: m[1], source: 'assign' };
    const proto = left.match(/^(\w+)\.prototype\.(\w+)$/);
    if (proto) return { name: `${proto[1]}.${proto[2]}`, source: 'assign' };
    if (/^[\w$.]+$/.test(left)) return { name: left, source: 'assign' };
    return fallbackExpressionName(fn);
  }
  return fallbackExpressionName(fn);
}

function fallbackExpressionName(fn: FunctionLike): OwnName | undefined {
  if (Node.isFunctionExpression(fn)) {
    const n = fn.getName();
    if (n) return { name: n, source: 'decl' };
  }
  return undefined;
}

export function unwrapExpr(n: Node): Node {
  let cur = n;
  while (
    Node.isParenthesizedExpression(cur) ||
    Node.isAsExpression(cur) ||
    Node.isSatisfiesExpression(cur) ||
    Node.isTypeAssertion(cur) ||
    Node.isNonNullExpression(cur) ||
    Node.isAwaitExpression(cur)
  ) {
    cur = cur.getExpression();
  }
  return cur;
}

/** Nearest enclosing *named* function-like ancestor (anonymous callbacks are skipped). */
export function ownerFunction(n: Node | undefined): FunctionLike | undefined {
  let cur = n;
  while (cur) {
    if (isFunctionLike(cur) && ownName(cur)) return cur;
    cur = cur.getParent();
  }
  return undefined;
}

function enclosingClassName(n: Node): string | undefined {
  const cls = n.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a));
  if (!cls) return undefined;
  const name = (cls as any).getName?.();
  if (name) return name;
  const p = meaningfulParent(cls);
  if (p && Node.isVariableDeclaration(p)) return p.getName();
  return 'AnonymousClass';
}

/** Outermost variable / class this node's object-literal nesting belongs to, for prefixing property functions. */
function topLevelContainerName(fn: Node, stopAt: Node | undefined): string | undefined {
  let cur: Node | undefined = fn.getParent();
  let found: string | undefined;
  while (cur && cur !== stopAt && !Node.isSourceFile(cur)) {
    if (Node.isVariableDeclaration(cur)) {
      const nn = cur.getNameNode();
      if (Node.isIdentifier(nn)) found = nn.getText();
    } else if (Node.isClassDeclaration(cur) && cur.getName()) {
      found = cur.getName();
    } else if (isFunctionLike(cur)) {
      break;
    }
    cur = cur.getParent();
  }
  return found;
}

const qnameCache = new WeakMap<Node, string | undefined>();

export function qualifiedName(fn: FunctionLike): string | undefined {
  if (qnameCache.has(fn)) return qnameCache.get(fn);
  const own = ownName(fn);
  let result: string | undefined;
  if (own) {
    const container = ownerFunction(fn.getParent());
    const parts: string[] = [];
    if (container) parts.push(qualifiedName(container)!);
    if (own.source === 'method' || own.source === 'field') {
      const cls = enclosingClassName(fn);
      if (cls) parts.push(cls);
    } else if (own.source === 'prop' || own.source === 'wrapper') {
      const top = topLevelContainerName(fn, container);
      if (top && top !== own.name) parts.push(top);
    }
    parts.push(own.name);
    result = parts.join('.');
  }
  qnameCache.set(fn, result);
  return result;
}

function containsJsx(n: Node): boolean {
  return (
    n.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
    n.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
    n.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0
  );
}

export function classify(fn: FunctionLike, qname: string): NodeKind {
  const own = ownName(fn);
  const last = qname.split('.').pop() ?? qname;
  if (own?.source === 'method' || own?.source === 'field') return 'method';
  if (/^use[A-Z0-9_]/.test(last)) return 'hook';
  if (/^[A-Z]/.test(last) && containsJsx(fn)) return 'component';
  return 'function';
}

export function nodeKey(n: Node): string {
  return `${n.getSourceFile().getFilePath()}:${n.getStart()}`;
}

/**
 * Registry of graph nodes shared across all ts-morph Projects in the workspace.
 * Ids are deterministic (root-relative file + qualified name) so the same
 * declaration reached from different projects maps to the same node.
 */
export class NodeRegistry {
  readonly nodes = new Map<string, GraphNode>();
  private byKey = new Map<string, string>();
  private nameCounts = new Map<string, Map<string, number>>(); // file -> qname -> count
  private exportedCache = new WeakMap<SourceFile, Set<string>>();

  constructor(
    readonly root: string,
    readonly fileOwner: Map<string, string>,
    readonly rootPackageName: string,
  ) {}

  relPath(sf: SourceFile): string {
    return toRel(this.root, sf.getFilePath());
  }

  packageOf(sf: SourceFile): string | undefined {
    const abs = normalize(sf.getFilePath());
    const owned = this.fileOwner.get(abs);
    if (owned) return owned;
    const npm = packageNameFromPath(abs);
    if (npm) return npm;
    return nearestPackageName(abs, this.root) ?? this.rootPackageName;
  }

  isInternalFile(sf: SourceFile): boolean {
    const abs = normalize(sf.getFilePath());
    if (packageNameFromPath(abs)) return false;
    if (isTsLibFile(abs)) return false;
    return abs.startsWith(normalize(this.root) + '/') || abs === normalize(this.root);
  }

  private exportedPositions(sf: SourceFile): Set<string> {
    let s = this.exportedCache.get(sf);
    if (!s) {
      s = new Set();
      try {
        for (const [, decls] of sf.getExportedDeclarations()) {
          for (const d of decls) s.add(nodeKey(d));
        }
      } catch {
        /* ignore */
      }
      this.exportedCache.set(sf, s);
    }
    return s;
  }

  isExported(fn: FunctionLike): boolean {
    const sf = fn.getSourceFile();
    const set = this.exportedPositions(sf);
    if (set.has(nodeKey(fn))) return true;
    const own = ownName(fn);
    if (!own) return false;
    if (own.source === 'default') return true;
    if (Node.isFunctionDeclaration(fn)) return fn.isExported();
    // var-assigned: check the variable declaration
    let p: Node | undefined = fn.getParent();
    while (p && !Node.isVariableDeclaration(p) && !Node.isSourceFile(p) && !isFunctionLike(p)) p = p.getParent();
    if (p && Node.isVariableDeclaration(p)) return set.has(nodeKey(p)) || p.getVariableStatement()?.isExported() === true;
    return false;
  }

  /** Module-scope pseudo node for a file (top-level statements). */
  moduleNode(sf: SourceFile): GraphNode {
    const file = this.relPath(sf);
    const id = `${file}#<module>`;
    let n = this.nodes.get(id);
    if (!n) {
      n = {
        id,
        kind: 'module',
        name: `<module> ${path.basename(file)}`,
        file,
        package: this.packageOf(sf),
        line: 1,
        internal: this.isInternalFile(sf),
      };
      this.nodes.set(id, n);
    }
    return n;
  }

  /** Get (or create) the graph node for a named function-like declaration. */
  functionNode(fn: FunctionLike): GraphNode | undefined {
    const key = nodeKey(fn);
    const existing = this.byKey.get(key);
    if (existing) return this.nodes.get(existing);
    const qname = qualifiedName(fn);
    if (!qname) return undefined;
    const sf = fn.getSourceFile();
    const file = this.relPath(sf);
    const line = fn.getStartLineNumber();
    let counts = this.nameCounts.get(file);
    if (!counts) this.nameCounts.set(file, (counts = new Map()));
    const c = counts.get(qname) ?? 0;
    counts.set(qname, c + 1);
    const id = c === 0 ? `${file}#${qname}` : `${file}#${qname}@${line}`;
    const node: GraphNode = {
      id,
      kind: classify(fn, qname),
      name: c === 0 ? qname : `${qname}@${line}`,
      file,
      package: this.packageOf(sf),
      line,
      endLine: fn.getEndLineNumber(),
      internal: this.isInternalFile(sf),
      exported: this.isExported(fn),
      async: (fn as any).isAsync?.() ?? false,
      params: fn.getParameters().map((p) => p.getName()).filter((n) => !!n),
    };
    const own = ownName(fn);
    // property-assigned callbacks (`onDone: () => ...`, `input: () => ...`) are pruned later when they call nothing
    if (own && (own.source === 'prop' || own.source === 'wrapper' || own.source === 'assign')) node.tags = ['inline'];
    this.nodes.set(id, node);
    this.byKey.set(key, id);
    return node;
  }

  /** Owner node for any AST position: nearest named function, else the module node. */
  ownerNode(n: Node): GraphNode {
    const fn = ownerFunction(n);
    if (fn) {
      const node = this.functionNode(fn);
      if (node) return node;
    }
    return this.moduleNode(n.getSourceFile());
  }

  packageNode(pkg: string, member: string): GraphNode {
    const id = `pkg:${pkg}#${member}`;
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind: 'package', name: member, file: pkg, package: pkg, internal: false };
      this.nodes.set(id, n);
    }
    return n;
  }

  builtinNode(member: string): GraphNode {
    const id = `builtin:${member}`;
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind: 'builtin', name: member, file: '(builtin)', internal: false };
      this.nodes.set(id, n);
    }
    return n;
  }

  /** All named function-like nodes declared in a file (registers them). */
  collectFunctions(sf: SourceFile): { node: GraphNode; fn: FunctionLike }[] {
    const out: { node: GraphNode; fn: FunctionLike }[] = [];
    sf.forEachDescendant((d) => {
      if (isFunctionLike(d)) {
        const node = this.functionNode(d);
        if (node) out.push({ node, fn: d });
      }
    });
    return out;
  }
}

export { ts };
