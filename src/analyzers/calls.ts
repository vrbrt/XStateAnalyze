import { Node, SourceFile, Symbol as TsSymbol, SyntaxKind, Type } from 'ts-morph';
import type { GraphEdge, GraphNode } from '../model.js';
import { isTsLibFile, normalize, packageNameFromPath } from '../project.js';
import { FunctionLike, NodeRegistry, isFunctionLike, nodeKey, unwrapExpr } from './functions.js';

export interface ImportBinding {
  local: string;
  imported: string; // 'default', '*', or the export name
  module: string;
  resolvedFile?: string;
  internal: boolean;
  package?: string;
}

export interface Resolution {
  kind: 'internal' | 'package' | 'builtin' | 'unresolved';
  node?: GraphNode;
  package?: string;
  member?: string;
  declFile?: string;
}

export interface ReceiverInfo {
  text: string;
  typeName?: string;
  typeFile?: string;
  typePackage?: string;
}

export interface CallSite {
  call: import('ts-morph').CallExpression | import('ts-morph').NewExpression | import('ts-morph').TaggedTemplateExpression;
  isNew: boolean;
  /** callee as written, `this.` stripped: `axios.get`, `client.getUser`, `fetch` */
  calleeText: string;
  /** leftmost identifier of the callee */
  rootName?: string;
  /** module specifier when the root identifier is an import binding */
  importedFrom?: string;
  /** module the root identifier ultimately comes from, following initializers (`const api = new UsersApi()` -> module of UsersApi) */
  originModule?: string;
  /** package for originModule when it is a bare specifier */
  originPackage?: string;
  resolution: Resolution;
  receiver?: ReceiverInfo;
  owner: GraphNode;
  file: string;
  line: number;
}

export class EdgeSet {
  readonly edges = new Map<string, GraphEdge>();
  add(from: string, to: string, kind: GraphEdge['kind'], line?: number, label?: string) {
    if (from === to && kind === 'calls') {
      // keep recursion but do not spam
    }
    const key = `${from}|${to}|${kind}`;
    const e = this.edges.get(key);
    if (e) {
      e.count++;
      if (line !== undefined && (e.line === undefined || line < e.line)) e.line = line;
    } else {
      this.edges.set(key, { from, to, kind, count: 1, line, label });
    }
  }
  /** Undo one call site's contribution to an edge (drops the edge when its count reaches zero). */
  remove(from: string, to: string, kind: GraphEdge['kind']) {
    const key = `${from}|${to}|${kind}`;
    const e = this.edges.get(key);
    if (!e) return;
    if (--e.count <= 0) this.edges.delete(key);
  }
}

export interface CallContext {
  registry: NodeRegistry;
  edges: EdgeSet;
  includeBuiltins: boolean;
  ignorePackages: string[];
  unresolved: number;
}

/** Collect import bindings of a file (local name -> module). */
/** Prefixes of tsconfig `paths` aliases (`@/*` -> `@/`) for the project owning a file, plus common conventions. */
function aliasPrefixesOf(sf: SourceFile): string[] {
  const out = new Set<string>(['@/', '~/', '#/', '$/', 'src/', '~']);
  try {
    const paths = sf.getProject().getCompilerOptions().paths ?? {};
    for (const k of Object.keys(paths)) out.add(k.replace(/\*.*$/, ''));
  } catch {
    /* ignore */
  }
  return [...out].filter(Boolean);
}

function isLocalSpecifier(mod: string, aliasPrefixes: string[]): boolean {
  if (mod.startsWith('.') || mod.startsWith('/')) return true;
  return aliasPrefixes.some((p) => mod === p.replace(/\/$/, '') || mod.startsWith(p));
}

export function importMap(sf: SourceFile, registry: NodeRegistry): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  const aliasPrefixes = aliasPrefixesOf(sf);
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    let resolvedFile: string | undefined;
    let internal = false;
    let pkg: string | undefined;
    try {
      const target = imp.getModuleSpecifierSourceFile();
      if (target) {
        resolvedFile = normalize(target.getFilePath());
        internal = registry.isInternalFile(target);
        pkg = registry.packageOf(target);
      }
    } catch {
      /* unresolved module */
    }
    if (!pkg && !internal) {
      if (isLocalSpecifier(mod, aliasPrefixes)) internal = true; // unresolved relative / path-alias import (e.g. generated code not present)
      else pkg = packageFromSpecifier(mod);
    }
    const base = { module: mod, resolvedFile, internal, package: pkg };
    const def = imp.getDefaultImport();
    if (def) map.set(def.getText(), { local: def.getText(), imported: 'default', ...base });
    const ns = imp.getNamespaceImport();
    if (ns) map.set(ns.getText(), { local: ns.getText(), imported: '*', ...base });
    for (const n of imp.getNamedImports()) {
      const local = (n.getAliasNode() ?? n.getNameNode()).getText();
      map.set(local, { local, imported: n.getNameNode().getText(), ...base });
    }
  }
  // CommonJS: const x = require('y') / const { a } = require('y')
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== 'require') continue;
    const arg = init.getArguments()[0];
    if (!arg || !Node.isStringLiteral(arg)) continue;
    const mod = arg.getLiteralText();
    const pkg = isLocalSpecifier(mod, aliasPrefixes) ? undefined : packageFromSpecifier(mod);
    const nameNode = v.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      map.set(nameNode.getText(), { local: nameNode.getText(), imported: 'default', module: mod, internal: !pkg, package: pkg });
    } else if (Node.isObjectBindingPattern(nameNode)) {
      for (const el of nameNode.getElements()) {
        const local = el.getNameNode().getText();
        const imported = el.getPropertyNameNode()?.getText() ?? local;
        map.set(local, { local, imported, module: mod, internal: !pkg, package: pkg });
      }
    }
  }
  return map;
}

const importMapCache = new WeakMap<SourceFile, Map<string, ImportBinding>>();
export function cachedImportMap(sf: SourceFile, registry: NodeRegistry): Map<string, ImportBinding> {
  let m = importMapCache.get(sf);
  if (!m) importMapCache.set(sf, (m = importMap(sf, registry)));
  return m;
}

/**
 * Package an identifier "comes from" when types are unavailable: either an
 * import binding, or a variable whose initializer chains back to one
 * (`const prisma = new PrismaClient()`, `const api = ky.create()`), across files.
 */
export function packageViaInitializer(id: Node, registry: NodeRegistry, depth = 0): { package?: string; module: string; member: string } | undefined {
  const o = originOf(id, registry, depth);
  return o?.package ? { package: o.package, module: o.module, member: o.member } : undefined;
}

/** Like packageViaInitializer but also reports unresolved relative modules (generated code that is not present). */
export function originOf(id: Node, registry: NodeRegistry, depth = 0): { package?: string; module: string; member: string; resolved: boolean } | undefined {
  if (depth > 4 || !Node.isIdentifier(id)) return undefined;
  const sf = id.getSourceFile();
  const imports = cachedImportMap(sf, registry);
  const imp = imports.get(id.getText());
  if (imp) {
    const member = imp.imported === 'default' || imp.imported === '*' ? id.getText() : imp.imported;
    if (imp.package && !imp.internal) return { package: imp.package, module: imp.module, member, resolved: !!imp.resolvedFile };
    if (imp.internal && !imp.resolvedFile) return { module: imp.module, member, resolved: false };
    if (!imp.internal) return undefined;
    // resolved internal import: follow the symbol into the other file's declaration below
  }
  let sym: TsSymbol | undefined;
  try {
    sym = id.getSymbol();
    if (sym && (sym.getFlags() & 0x200000) !== 0) sym = sym.getAliasedSymbol() ?? sym;
  } catch {
    return undefined;
  }
  for (const d of sym?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(d) && !Node.isPropertyAssignment(d)) continue;
    const init = (d as any).getInitializer?.() as Node | undefined;
    if (!init) continue;
    const root = rootIdentifier(init);
    if (root && Node.isIdentifier(root) && root !== id) {
      const r = originOf(root, registry, depth + 1);
      if (r) return { ...r, member: (d as any).getName?.() ?? r.member };
    }
  }
  return undefined;
}

export function packageFromSpecifier(spec: string): string {
  if (spec.startsWith('node:')) return 'node';
  const parts = spec.split('/');
  if (spec.startsWith('@') && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function rootIdentifier(expr: Node): Node | undefined {
  let cur = unwrapExpr(expr);
  while (true) {
    if (Node.isPropertyAccessExpression(cur) || Node.isElementAccessExpression(cur)) cur = unwrapExpr(cur.getExpression());
    else if (Node.isCallExpression(cur) || Node.isNewExpression(cur)) cur = unwrapExpr(cur.getExpression());
    else break;
  }
  return Node.isIdentifier(cur) || Node.isThisExpression(cur) ? cur : undefined;
}

/** Function-like node "defined" by an initializer, looking through wrapper calls. */
export function functionOfInitializer(init: Node | undefined, depth = 0): FunctionLike | undefined {
  if (!init || depth > 4) return undefined;
  const u = unwrapExpr(init);
  if (isFunctionLike(u)) return u;
  if (Node.isCallExpression(u)) {
    for (const a of u.getArguments()) {
      const f = functionOfInitializer(a, depth + 1);
      if (f) return f;
    }
  }
  return undefined;
}

function ownerTypeName(decl: Node): string | undefined {
  const owner = decl.getFirstAncestor(
    (a) => Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeAliasDeclaration(a) || Node.isClassExpression(a) || Node.isTypeLiteral(a),
  );
  if (!owner) return undefined;
  if (Node.isTypeLiteral(owner)) {
    const p = owner.getParent();
    if (p && (Node.isTypeAliasDeclaration(p) || Node.isVariableDeclaration(p) || Node.isPropertySignature(p))) return p.getName();
    return undefined;
  }
  return (owner as any).getName?.();
}

const GLOBAL_OBJECT_ALIASES: Record<string, string> = { Console: 'console', Math: 'Math', JSON: 'JSON', Window: 'window', Document: 'document', Navigator: 'navigator', Storage: 'localStorage' };

function memberName(decl: Node, sym: TsSymbol | undefined): string {
  const name = sym?.getName() ?? (decl as any).getName?.() ?? decl.getText().slice(0, 40);
  const owner = ownerTypeName(decl);
  if (owner && owner !== name) return `${GLOBAL_OBJECT_ALIASES[owner] ?? owner}.${name}`;
  return name;
}

function declarationTarget(decl: Node, sym: TsSymbol | undefined, registry: NodeRegistry): Resolution | undefined {
  const sf = decl.getSourceFile();
  const abs = normalize(sf.getFilePath());
  if (isTsLibFile(abs)) return { kind: 'builtin', member: memberName(decl, sym), declFile: abs };
  const npm = packageNameFromPath(abs);
  if (npm) return { kind: 'package', package: npm, member: memberName(decl, sym), declFile: abs };

  if (isFunctionLike(decl)) {
    const node = registry.functionNode(decl);
    if (node) return { kind: 'internal', node, declFile: abs };
    // anonymous function-like declaration: attribute to its owner
    return { kind: 'internal', node: registry.ownerNode(decl), declFile: abs };
  }
  if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl) || Node.isPropertyDeclaration(decl) || Node.isBindingElement(decl)) {
    const init = (decl as any).getInitializer?.() as Node | undefined;
    const fn = functionOfInitializer(init);
    if (fn) {
      const node = registry.functionNode(fn);
      if (node) return { kind: 'internal', node, declFile: abs };
    }
    // variable holding an instance / object from a package (const api = axios.create())
    if (init) {
      const t = init.getType();
      const pkg = packageOfType(t);
      if (pkg) return { kind: 'package', package: pkg, member: (decl as any).getName?.() ?? decl.getText(), declFile: abs };
      const root = rootIdentifier(init);
      if (root && Node.isIdentifier(root)) {
        const via = packageViaInitializer(root, registry);
        if (via) return { kind: 'package', package: via.package, member: (decl as any).getName?.() ?? via.member, declFile: abs };
      }
    }
    return undefined;
  }
  if (Node.isShorthandPropertyAssignment(decl)) {
    const vs = decl.getValueSymbol?.() ?? decl.getNameNode().getSymbol();
    for (const d of vs?.getDeclarations() ?? []) {
      if (d === decl) continue;
      const r = declarationTarget(d, vs, registry);
      if (r) return r;
    }
    return undefined;
  }
  if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
    const ctor = decl.getConstructors()[0];
    if (ctor) {
      const node = registry.functionNode(ctor);
      if (node) return { kind: 'internal', node, declFile: abs };
    }
    return { kind: 'internal', node: classNode(decl, registry), declFile: abs };
  }
  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    const imp = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const spec = imp?.getModuleSpecifierValue();
    if (spec && !spec.startsWith('.')) return { kind: 'package', package: packageFromSpecifier(spec), member: sym?.getName() ?? decl.getText(), declFile: abs };
    return undefined;
  }
  if (Node.isMethodSignature(decl) || Node.isPropertySignature(decl)) {
    // interface member on an internal type: dynamic dispatch (props.onClick())
    return undefined;
  }
  if (Node.isParameterDeclaration(decl)) return undefined;
  if (Node.isEnumMember(decl) || Node.isTypeAliasDeclaration(decl) || Node.isInterfaceDeclaration(decl)) return undefined;
  if (Node.isModuleDeclaration(decl)) {
    return { kind: 'package', package: decl.getName().replace(/['"]/g, ''), member: sym?.getName() ?? '?', declFile: abs };
  }
  return undefined;
}

function classNode(cls: import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression, registry: NodeRegistry): GraphNode {
  const sf = cls.getSourceFile();
  const file = registry.relPath(sf);
  const name = (cls as any).getName?.() ?? 'AnonymousClass';
  const id = `${file}#${name}`;
  let n = registry.nodes.get(id);
  if (!n) {
    n = { id, kind: 'function', name, file, package: registry.packageOf(sf), line: cls.getStartLineNumber(), internal: registry.isInternalFile(sf), tags: ['class'] };
    registry.nodes.set(id, n);
  }
  return n;
}

function packageOfType(t: Type): string | undefined {
  const sym = t.getSymbol() ?? t.getAliasSymbol();
  const decl = sym?.getDeclarations()?.[0];
  if (!decl) return undefined;
  return packageNameFromPath(decl.getSourceFile().getFilePath());
}

function receiverInfo(expr: Node): ReceiverInfo | undefined {
  const u = unwrapExpr(expr);
  if (!Node.isPropertyAccessExpression(u) && !Node.isElementAccessExpression(u)) return undefined;
  const recv = u.getExpression();
  const info: ReceiverInfo = { text: recv.getText() };
  try {
    let t = recv.getType();
    if (t.isUnion()) t = t.getUnionTypes().find((x) => !x.isUndefined() && !x.isNull()) ?? t;
    const sym = t.getSymbol() ?? t.getAliasSymbol();
    if (sym) {
      info.typeName = sym.getName();
      if (info.typeName === '__type' || info.typeName === '__object') {
        info.typeName = t.getAliasSymbol()?.getName() ?? t.getText().slice(0, 60);
      }
      const d = sym.getDeclarations()[0];
      if (d) {
        info.typeFile = normalize(d.getSourceFile().getFilePath());
        info.typePackage = packageNameFromPath(info.typeFile);
      }
    } else {
      info.typeName = t.getText().slice(0, 60);
    }
  } catch {
    /* ignore */
  }
  if (!info.typePackage && registryRef) {
    const root = rootIdentifier(recv);
    if (root && Node.isIdentifier(root)) {
      const via = packageViaInitializer(root, registryRef);
      if (via) {
        info.typePackage = via.package;
        if (!info.typeName || info.typeName === 'any') info.typeName = via.member;
      }
    }
  }
  return info;
}
let registryRef: NodeRegistry | undefined;

/** Resolve a callee expression to a graph target. */
export function resolveExpression(expr: Node, imports: Map<string, ImportBinding>, registry: NodeRegistry): Resolution {
  const u = unwrapExpr(expr);
  if (isFunctionLike(u)) {
    // IIFE
    const n = registry.functionNode(u);
    return { kind: 'internal', node: n ?? registry.ownerNode(u) };
  }
  let sym: TsSymbol | undefined;
  try {
    sym = u.getSymbol();
    if (sym && (sym.getFlags() & 0x200000 /* Alias */) !== 0) {
      const aliased = sym.getAliasedSymbol();
      if (aliased) sym = aliased;
    }
  } catch {
    sym = undefined;
  }
  if (sym) {
    for (const d of sym.getDeclarations()) {
      const r = declarationTarget(d, sym, registry);
      if (r) return r;
    }
  }
  // Fallback: leftmost identifier maps to an import
  const root = rootIdentifier(u);
  if (root && Node.isIdentifier(root)) {
    const imp = imports.get(root.getText());
    if (imp) {
      const text = chainText(u);
      const member = imp.imported === 'default' || imp.imported === '*' ? text : text.replace(new RegExp('^' + root.getText()), imp.imported);
      if (imp.package) return { kind: 'package', package: imp.package, member, declFile: imp.resolvedFile };
      return { kind: 'unresolved' };
    }
    // Local variable initialised from an (untyped) package: const prisma = new PrismaClient()
    const via = packageViaInitializer(root, registry);
    if (via) {
      const text = chainText(u);
      const member = text.startsWith(root.getText() + '.') ? `${via.member}${text.slice(root.getText().length)}` : via.member;
      return { kind: 'package', package: via.package, member };
    }
    // Unresolved global like `fetch` in a JS project without lib types
    if (!sym) {
      const name = u.getText().replace(/\s+/g, '');
      if (/^(fetch|WebSocket|XMLHttpRequest|EventSource|setTimeout|setInterval|console\.\w+|JSON\.\w+|Math\.\w+|Promise\.\w+|Object\.\w+|Array\.\w+)$/.test(name)) {
        return { kind: 'builtin', member: name };
      }
    }
  }
  return { kind: 'unresolved' };
}

/** `a.b(x).c` -> `a.b.c` */
function chainText(expr: Node): string {
  const parts: string[] = [];
  let cur: Node = unwrapExpr(expr);
  while (true) {
    if (Node.isPropertyAccessExpression(cur)) { parts.unshift(cur.getName()); cur = unwrapExpr(cur.getExpression()); }
    else if (Node.isElementAccessExpression(cur)) { parts.unshift(`[${cur.getArgumentExpression()?.getText() ?? ''}]`); cur = unwrapExpr(cur.getExpression()); }
    else if (Node.isCallExpression(cur) || Node.isNewExpression(cur)) cur = unwrapExpr(cur.getExpression());
    else { parts.unshift(cur.getText()); break; }
  }
  return parts.join('.').replace(/\.\[/g, '[');
}

export function calleeText(expr: Node): string {
  return unwrapExpr(expr).getText().replace(/\s+/g, '').replace(/^this\./, '');
}

function pkgIgnored(pkg: string | undefined, patterns: string[]): boolean {
  if (!pkg) return false;
  return patterns.some((p) => (p.endsWith('*') ? pkg.startsWith(p.slice(0, -1)) : p === pkg));
}

/**
 * Walk a file: register function nodes, resolve every call / new / tagged
 * template / JSX element, add edges, and return the call sites for the
 * external-call and XState analyzers.
 */
export function analyzeCalls(sf: SourceFile, ctx: CallContext): CallSite[] {
  const { registry, edges } = ctx;
  registryRef = registry;
  const imports = cachedImportMap(sf, registry);
  const file = registry.relPath(sf);
  const sites: CallSite[] = [];

  const addTargetEdge = (owner: GraphNode, res: Resolution, kind: GraphEdge['kind'], line: number) => {
    if (res.kind === 'internal' && res.node) {
      if (res.node.id !== owner.id || kind !== 'calls') edges.add(owner.id, res.node.id, kind, line);
      else edges.add(owner.id, res.node.id, kind, line); // recursion
    } else if (res.kind === 'package' && res.package && res.member) {
      if (pkgIgnored(res.package, ctx.ignorePackages)) return;
      const n = registry.packageNode(res.package, res.member);
      edges.add(owner.id, n.id, kind, line);
    } else if (res.kind === 'builtin' && res.member) {
      if (!ctx.includeBuiltins) return;
      const n = registry.builtinNode(res.member);
      edges.add(owner.id, n.id, kind, line);
    } else {
      ctx.unresolved++;
    }
  };

  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      const expr = node.getExpression();
      // skip `require('x')` and `import()` pseudo calls
      if (Node.isCallExpression(node) && (expr.getText() === 'require' || expr.getKind() === SyntaxKind.ImportKeyword)) return;
      const owner = registry.ownerNode(node);
      const resolution = resolveExpression(expr, imports, registry);
      const line = node.getStartLineNumber();
      const root = rootIdentifier(expr);
      const origin = root && Node.isIdentifier(root) ? originOf(root, registry) : undefined;
      const site: CallSite = {
        call: node,
        isNew: Node.isNewExpression(node),
        calleeText: calleeText(expr),
        rootName: root?.getText(),
        importedFrom: root ? imports.get(root.getText())?.module : undefined,
        originModule: origin?.module,
        originPackage: origin?.package,
        resolution,
        receiver: receiverInfo(expr),
        owner,
        file,
        line,
      };
      sites.push(site);
      addTargetEdge(owner, resolution, 'calls', line);
    } else if (Node.isTaggedTemplateExpression(node)) {
      const tag = node.getTag();
      const owner = registry.ownerNode(node);
      const resolution = resolveExpression(tag, imports, registry);
      const root = rootIdentifier(tag);
      sites.push({
        call: node,
        isNew: false,
        calleeText: calleeText(tag),
        rootName: root?.getText(),
        importedFrom: root ? imports.get(root.getText())?.module : undefined,
        resolution,
        receiver: receiverInfo(tag),
        owner,
        file,
        line: node.getStartLineNumber(),
      });
      addTargetEdge(owner, resolution, 'calls', node.getStartLineNumber());
    } else if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
      const tag = node.getTagNameNode();
      const text = tag.getText();
      if (/^[a-z]/.test(text)) return; // intrinsic element
      const owner = registry.ownerNode(node);
      const resolution = resolveExpression(tag, imports, registry);
      addTargetEdge(owner, resolution, 'renders', node.getStartLineNumber());
    }
  });

  return sites;
}

export { nodeKey };
