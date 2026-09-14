import * as fs from 'node:fs';
import * as path from 'node:path';
import { EdgeSet } from '../analyzers/calls.js';
import { attachExternalNode } from '../analyzers/external.js';
import { NodeRegistry } from '../analyzers/functions.js';
import type { Analysis, AnalyzerOptions, EntryKind, ExternalCall, ExternalCategory, FileInfo, GraphNode, ProjectInfo, UnresolvedClientCall } from '../model.js';
import { OpenApiIndex, loadOpenApi } from '../openapi.js';
import { normalize } from '../project.js';
import { JavaIndex, type Injection } from './index.js';
import type { JExpr, JField, JFile, JMethod, JType, JTypeRef } from './model.js';
import { parseJava } from './parse.js';
import { SpringProps, ann, annValue, classMapping, joinPath, kebab, listenerOf, loadSpringProps, methodMapping, valueAnnotation } from './spring.js';

type Chain = Extract<JExpr, { kind: 'chain' }>;

const BUILTIN_PKG = /^(java|javax|jakarta|lombok|org\.slf4j|kotlin|sun|jdk)(\.|$)/;
const EXCLUDED_DIRS = new Set(['target', 'build', 'out', 'bin', 'node_modules', '.git', '.idea', '.gradle', 'generated', 'generated-sources']);

/* ---------- source discovery ---------- */

function listJavaFiles(root: string, includeTests: boolean, excludeRe: RegExp[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const n = normalize(full);
      if (excludeRe.some((r) => r.test(n))) continue;
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (!includeTests && /\/src\/test$/.test(n)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.java') && e.name !== 'package-info.java' && e.name !== 'module-info.java') {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function isJavaProject(root: string): boolean {
  return ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'gradlew'].some((f) => fs.existsSync(path.join(root, f)));
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
}

/* ---------- scope & type inference ---------- */

interface Scope {
  type: JType;
  method: JMethod;
  locals: Map<string, JTypeRef | undefined>;
  lambdaParams: Map<string, JTypeRef>;
  /** lambda params iterating an injected collection (List<Handler> handlers -> h): calls fan out to all implementations */
  collectionParams: Set<string>;
}

const OPTIONAL_LIKE = new Set(['Optional', 'Mono', 'Flux', 'CompletableFuture', 'Future', 'Supplier', 'Callable', 'ResponseEntity', 'HttpEntity', 'Page', 'Slice', 'List', 'Set', 'Collection', 'Iterable', 'Stream']);
const UNWRAP_METHODS = new Set(['get', 'orElse', 'orElseThrow', 'orElseGet', 'block', 'join', 'getBody', 'getContent', 'stream', 'iterator', 'findFirst', 'findAny', 'blockFirst', 'blockLast', 'getFirst', 'getLast', 'first', 'toList']);

class JavaAnalyzer {
  readonly registry: NodeRegistry;
  readonly edges = new EdgeSet();
  readonly externalCalls: ExternalCall[] = [];
  readonly warnings: string[] = [];
  readonly files: FileInfo[] = [];
  readonly unresolvedClientCalls: UnresolvedClientCall[] = [];
  unresolved = 0;
  private counter = { n: 0 };
  private nodeByMethod = new Map<JMethod, GraphNode>();
  private classNodes = new Map<string, GraphNode>();
  private contextPath = '';
  private constCache = new Map<string, string | undefined>();

  constructor(
    readonly root: string,
    readonly project: string,
    readonly index: JavaIndex,
    readonly openapi: OpenApiIndex,
    readonly opts: AnalyzerOptions,
  ) {
    this.registry = new NodeRegistry(root, new Map(), project);
    const ctx = index.props.get('server.servlet.context-path') ?? index.props.get('spring.webflux.base-path') ?? '';
    this.contextPath = ctx.replace(/\/$/, '');
  }

  /* ----- nodes ----- */

  private typeDisplayName(t: JType): string {
    return t.fqn.slice(t.package ? t.package.length + 1 : 0).replace(/\$/g, '.');
  }

  private fileRel(t: JType): string {
    return t.file;
  }

  private nameCounts = new Map<string, number>();

  methodNode(t: JType, m: JMethod): GraphNode {
    const existing = this.nodeByMethod.get(m);
    if (existing) return existing;
    const cls = this.typeDisplayName(t);
    const base = `${cls}.${m.isConstructor ? 'constructor' : m.name}`;
    const key = `${t.file}#${base}`;
    const c = this.nameCounts.get(key) ?? 0;
    this.nameCounts.set(key, c + 1);
    const id = c === 0 ? key : `${key}@${m.line}`;
    const returnsAsync = !!m.returnType && /^(Mono|Flux|CompletableFuture|Future|ListenableFuture|Publisher)$/.test(m.returnType.name);
    const node: GraphNode = {
      id,
      kind: 'method',
      name: c === 0 ? base : `${base}@${m.line}`,
      file: t.file,
      package: this.project,
      project: this.project,
      line: m.line,
      endLine: m.endLine,
      internal: true,
      exported: m.modifiers.includes('public') || t.kind === 'interface',
      async: returnsAsync || !!ann(m.annotations, 'Async'),
      params: m.params.map((p) => p.name),
      className: t.fqn,
      tags: [...JavaIndex.stereotypes(t).map((s) => `@${s}`), ...(m.isAbstract ? ['abstract'] : []), ...(t.kind === 'interface' ? ['interface'] : [])],
    };
    if (!node.tags?.length) delete node.tags;
    this.registry.nodes.set(id, node);
    this.nodeByMethod.set(m, node);
    return node;
  }

  /** Pseudo node for a class without the referenced constructor (e.g. `new Foo()` with the default constructor). */
  classNode(t: JType): GraphNode {
    let n = this.classNodes.get(t.fqn);
    if (n) return n;
    const id = `${t.file}#${this.typeDisplayName(t)}`;
    n = this.registry.nodes.get(id) ?? { id, kind: 'function', name: this.typeDisplayName(t), file: t.file, package: this.project, project: this.project, line: t.line, internal: true, exported: t.modifiers.includes('public'), className: t.fqn, tags: ['class', ...JavaIndex.stereotypes(t).map((s) => `@${s}`)] };
    this.registry.nodes.set(id, n);
    this.classNodes.set(t.fqn, n);
    return n;
  }

  /* ----- constants / strings ----- */

  /** Compile-time string of a field: literal initializer, @Value property, @ConfigurationProperties binding, or constructor-injected @Value. */
  fieldConst(t: JType, f: JField): string | undefined {
    const key = `${t.fqn}.${f.name}`;
    if (this.constCache.has(key)) return this.constCache.get(key);
    let v: string | undefined;
    if (f.constValue !== undefined) v = this.index.props.resolve(f.constValue);
    else {
      const val = valueAnnotation(f.annotations, this.index.props);
      if (val !== undefined) v = val;
    }
    if (v === undefined) {
      const cp = ann(t.annotations, 'ConfigurationProperties');
      if (cp) {
        const prefix = annValue(cp, 'prefix', 'value')[0] ?? '';
        v = this.index.props.get(prefix ? `${prefix}.${kebab(f.name)}` : kebab(f.name));
      }
    }
    if (v === undefined) {
      // constructor injection: this.x = param where param has @Value
      for (const ctor of t.methods.filter((m) => m.isConstructor)) {
        const a = ctor.assignments.find((x) => x.field === f.name);
        const p = a && ctor.params.find((pp) => pp.name === a.from);
        const pv = p && valueAnnotation(p.annotations, this.index.props);
        if (pv !== undefined) {
          v = pv;
          break;
        }
      }
    }
    this.constCache.set(key, v);
    return v;
  }

  /** Best-effort string value of an expression in a scope; unknown parts become `{name}` placeholders. */
  evalString(e: JExpr | undefined, scope: Scope, depth = 0): string | undefined {
    if (!e || depth > 6) return undefined;
    switch (e.kind) {
      case 'literal':
        return e.isString ? this.index.props.resolve(e.value) : e.value;
      case 'binary':
        if (e.op === '+') return e.parts.map((p) => this.evalString(p, scope, depth + 1) ?? '{?}').join('');
        return undefined;
      case 'ternary':
        return this.evalString(e.parts[1], scope, depth + 1);
      case 'cast':
        return this.evalString(e.expr, scope, depth + 1);
      case 'chain':
        return this.evalChainString(e, scope, depth);
      default:
        return undefined;
    }
  }

  private evalChainString(c: Chain, scope: Scope, depth: number): string | undefined {
    const segs = c.segments;
    if (c.base.kind === 'expr') {
      const base = this.evalString(c.base.expr, scope, depth + 1);
      return this.applyStringSegments(base, segs, scope, depth);
    }
    if (c.base.kind === 'new') {
      if (c.base.type.name === 'URI' || c.base.type.name === 'URL' || c.base.type.name === 'StringBuilder') return this.applyStringSegments(this.evalString(c.base.args[0], scope, depth + 1), segs, scope, depth);
      return undefined;
    }
    if (c.base.kind !== 'name' || !segs.length) return undefined;
    const first = segs[0];
    const placeholder = () => {
      const last = segs[segs.length - 1].name.replace(/^(get|is)(?=[A-Z])/, '');
      return `{${last[0].toLowerCase() + last.slice(1)}}`;
    };
    // static helpers
    if (segs.length >= 2 && segs[1].call) {
      const helper = `${first.name}.${segs[1].name}`;
      const args = segs[1].call.args;
      const rest = segs.slice(2);
      if (helper === 'String.format' || helper === 'MessageFormat.format') {
        const fmt = this.evalString(args[0], scope, depth + 1) ?? '';
        return this.applyStringSegments(fmt.replace(/%[-+ 0#]*\d*(?:\.\d+)?[sdfxXobcegn]/g, '{}').replace(/\{\d+\}/g, '{}'), rest, scope, depth);
      }
      if (helper === 'String.valueOf' || helper === 'URI.create' || helper === 'Objects.requireNonNull' || helper === 'Optional.ofNullable' || helper === 'Optional.of') {
        return this.applyStringSegments(this.evalString(args[0], scope, depth + 1), rest, scope, depth);
      }
      if (helper === 'String.join') {
        const sep = this.evalString(args[0], scope, depth + 1) ?? '/';
        return this.applyStringSegments(args.slice(1).map((a) => this.evalString(a, scope, depth + 1) ?? '{?}').join(sep), rest, scope, depth);
      }
      if (/^UriComponentsBuilder\.(fromHttpUrl|fromUriString|fromUri|fromPath|newInstance)$/.test(helper)) {
        return this.applyStringSegments(args.length ? this.evalString(args[0], scope, depth + 1) : '', rest, scope, depth);
      }
      if (helper === 'System.getenv' || helper === 'System.getProperty') {
        return this.applyStringSegments(`{env:${this.evalString(args[0], scope, depth + 1) ?? '?'}}`, rest, scope, depth);
      }
    }
    // identifier: local constant, field constant, static constant on another class, property getter
    if (!first.call) {
      const local = scope.method.locals.find((l) => l.name === first.name);
      let value: string | undefined;
      let curType: JType | undefined;
      if (local) {
        value = local.init ? this.evalString(local.init, scope, depth + 1) : undefined;
        curType = this.index.resolveType(local.type?.name, scope.type);
      } else {
        const f = this.index.findField(scope.type, first.name);
        if (f) {
          value = this.fieldConst(f.type, f.field);
          curType = this.index.resolveType(f.field.type.name, scope.type);
        } else {
          const t = this.index.resolveType(first.name, scope.type);
          if (t) curType = t; // static reference Foo.X
          else {
            const p = scope.method.params.find((x) => x.name === first.name);
            if (p) {
              const pv = valueAnnotation(p.annotations, this.index.props);
              if (pv !== undefined && segs.length === 1) return pv;
              curType = this.index.resolveType(p.type.name, scope.type);
            } else if (segs.every((x) => !x.call) && /^[A-Z]/.test(first.name)) {
              return segs.map((x) => x.name).join('.'); // enum / constant of a library type: HttpMethod.GET
            } else if (!p) return placeholder();
          }
        }
      }
      if (segs.length === 1) return value ?? `{${first.name}}`;
      // Foo.CONST / props.getBaseUrl() / env.getProperty("k")
      const second = segs[1];
      if (curType) {
        if (!second.call) {
          const f2 = this.index.findField(curType, second.name);
          const v2 = f2 ? this.fieldConst(f2.type, f2.field) : undefined;
          return this.applyStringSegments(v2 ?? `{${first.name}.${second.name}}`, segs.slice(2), scope, depth);
        }
        const getter = second.name.match(/^(?:get|is)([A-Z]\w*)$/);
        if (getter && second.call.args.length === 0) {
          const prop = getter[1][0].toLowerCase() + getter[1].slice(1);
          const f2 = this.index.findField(curType, prop);
          const v2 = f2 ? this.fieldConst(f2.type, f2.field) : undefined;
          return this.applyStringSegments(v2 ?? `{${first.name}.${prop}}`, segs.slice(2), scope, depth);
        }
      }
      if (second.call && /^(getProperty|getRequiredProperty)$/.test(second.name)) {
        const k = this.evalString(second.call.args[0], scope, depth + 1);
        return this.applyStringSegments(k ? (this.index.props.get(k) ?? `{${k}}`) : '{?}', segs.slice(2), scope, depth);
      }
      const applied = this.applyStringSegments(value, segs.slice(1), scope, depth);
      return applied ?? placeholder();
    }
    return placeholder();
  }

  /** Apply string-ish method segments (.path(), .concat(), .toString(), builder methods) to a base value. */
  private applyStringSegments(base: string | undefined, segs: { name: string; call?: { args: JExpr[] } }[], scope: Scope, depth: number): string | undefined {
    let v = base;
    for (const s of segs) {
      if (!s.call) {
        v = v === undefined ? `{${s.name}}` : v;
        continue;
      }
      const a0 = s.call.args[0];
      switch (s.name) {
        case 'path':
        case 'concat':
        case 'append':
        case 'pathSegment': {
          const parts = s.call.args.map((a) => this.evalString(a, scope, depth + 1) ?? '{?}');
          const add = s.name === 'pathSegment' ? '/' + parts.join('/') : parts.join('');
          v = (v ?? '') + (s.name === 'path' && v && !v.endsWith('/') && !add.startsWith('/') ? '/' : '') + add;
          break;
        }
        case 'queryParam': {
          const k = this.evalString(a0, scope, depth + 1) ?? '?';
          v = (v ?? '') + (v?.includes('?') ? '&' : '?') + k + '={' + k + '}';
          break;
        }
        case 'formatted':
          v = (v ?? '').replace(/%[-+ 0#]*\d*(?:\.\d+)?[sdfxXobcegn]/g, '{}');
          break;
        case 'replace':
        case 'replaceAll':
        case 'replaceFirst':
        case 'trim':
        case 'strip':
        case 'toString':
        case 'toUriString':
        case 'toUri':
        case 'build':
        case 'buildAndExpand':
        case 'encode':
        case 'expand':
        case 'toLowerCase':
        case 'toUpperCase':
        case 'intern':
        case 'normalize':
        case 'toURI':
        case 'getURI':
        case 'orElse':
        case 'get':
          break;
        case 'resolve':
          v = (v ?? '').replace(/\/$/, '') + '/' + (this.evalString(a0, scope, depth + 1) ?? '{?}').replace(/^\//, '');
          break;
        default:
          return v === undefined ? undefined : v;
      }
    }
    return v;
  }

  /* ----- type inference ----- */

  private typeOfName(name: string, scope: Scope): { ref?: JTypeRef; type?: JType; isStatic?: boolean; field?: JField } | undefined {
    if (scope.lambdaParams.has(name)) {
      const ref = scope.lambdaParams.get(name)!;
      return { ref, type: this.index.resolveType(ref.name, scope.type) };
    }
    if (scope.locals.has(name)) {
      const ref = scope.locals.get(name);
      return { ref, type: ref ? this.index.resolveType(ref.name, scope.type) : undefined };
    }
    const p = scope.method.params.find((x) => x.name === name);
    if (p) return { ref: p.type, type: this.index.resolveType(p.type.name, scope.type) };
    const f = this.index.findField(scope.type, name);
    if (f) return { ref: f.field.type, type: this.index.resolveType(f.field.type.name, scope.type), field: f.field };
    const t = this.index.resolveType(name, scope.type);
    if (t) return { ref: { name: t.name, args: [], dims: 0, raw: t.name }, type: t, isStatic: true };
    return undefined;
  }

  /** Result type of a chain evaluated in a scope (project types only; library types by name). */
  chainResultRef(c: Chain, scope: Scope, upTo = c.segments.length): JTypeRef | undefined {
    let ref: JTypeRef | undefined;
    let start = 0;
    if (c.base.kind === 'this') ref = { name: scope.type.name, args: [], dims: 0, raw: scope.type.name };
    else if (c.base.kind === 'super') ref = scope.type.superclass;
    else if (c.base.kind === 'new') ref = c.base.type;
    else if (c.base.kind === 'expr') ref = c.base.expr.kind === 'literal' && c.base.expr.isString ? { name: 'String', args: [], dims: 0, raw: 'String' } : c.base.expr.kind === 'chain' ? this.chainResultRef(c.base.expr, scope) : c.base.expr.kind === 'cast' ? { name: c.base.expr.type, args: [], dims: 0, raw: c.base.expr.type } : undefined;
    else {
      const info = this.typeOfName(c.segments[0].name, scope);
      ref = info?.ref;
      start = 1;
      if (!info && !c.segments[0].call) {
        // maybe a package-qualified name a.b.C.method(): skip leading lowercase segments
        let i = 0;
        while (i < c.segments.length && /^[a-z]/.test(c.segments[i].name) && !c.segments[i].call) i++;
        if (i < c.segments.length && !c.segments[i].call) {
          const t = this.index.resolveType(c.segments[i].name, scope.type);
          if (t) {
            ref = { name: t.name, args: [], dims: 0, raw: t.name };
            start = i + 1;
          }
        }
      }
    }
    for (let i = start; i < upTo; i++) {
      const seg = c.segments[i];
      if (!ref) return undefined;
      const t = this.index.resolveType(ref.name, scope.type);
      if (seg.call) {
        if (t) {
          const targets = this.index.isAbstractLike(t) ? [t, ...this.index.implementations(t)] : [t];
          let found: JMethod | undefined;
          for (const tt of targets) {
            const fm = this.index.findMethod(tt, seg.name, seg.call.args.length);
            if (fm) {
              found = fm.method;
              break;
            }
          }
          ref = found?.returnType;
          if (found?.returnType && OPTIONAL_LIKE.has(found.returnType.name) && i + 1 < upTo && UNWRAP_METHODS.has(c.segments[i + 1].name)) {
            // handled on the next iteration via the unwrap rule below
          }
        } else if (OPTIONAL_LIKE.has(ref.name) && UNWRAP_METHODS.has(seg.name) && ref.args.length) {
          ref = ref.args[0];
        } else if (ref.name === 'Map' && /^(get|getOrDefault|remove)$/.test(seg.name) && ref.args.length === 2) {
          ref = ref.args[1];
        } else if (/^(getBody|block|join|get|orElse|orElseThrow|orElseGet)$/.test(seg.name) && ref.args.length) {
          ref = ref.args[0];
        } else if (/^(builder|newBuilder)$/.test(seg.name) || /^(with|set)[A-Z]/.test(seg.name) || seg.name === 'build') {
          // builder pattern: `Foo.builder().x().build()` -> Foo
          ref = seg.name === 'build' ? ref : ref;
        } else if (ref.name === 'String' || seg.name === 'toString') {
          ref = { name: 'String', args: [], dims: 0, raw: 'String' };
        } else {
          return undefined; // library call with unknown return type
        }
      } else {
        // field access
        if (t) {
          const f = this.index.findField(t, seg.name);
          ref = f?.field.type;
        } else return undefined;
      }
    }
    return ref;
  }

  /* ----- per method analysis ----- */

  private scopeFor(t: JType, m: JMethod): Scope {
    const scope: Scope = { type: t, method: m, locals: new Map(), lambdaParams: new Map(), collectionParams: new Set() };
    for (const l of m.locals) {
      if (l.type) scope.locals.set(l.name, l.type);
      else if (l.init && l.init.kind === 'chain') scope.locals.set(l.name, this.chainResultRef(l.init, scope));
      else if (l.init && l.init.kind === 'literal') scope.locals.set(l.name, { name: l.init.isString ? 'String' : 'int', args: [], dims: 0, raw: '' });
      else scope.locals.set(l.name, undefined);
    }
    // lambda parameter types from collection-typed receivers: handlers.forEach(h -> ...)
    for (const c of m.chains) {
      for (let i = 0; i < c.segments.length; i++) {
        const seg = c.segments[i];
        if (!seg.call) continue;
        const lambdas = seg.call.args.filter((a): a is Extract<JExpr, { kind: 'lambda' }> => a.kind === 'lambda' && a.params.length > 0);
        if (!lambdas.length) continue;
        const recv = this.chainResultRef(c, scope, i);
        if (!recv) continue;
        let elem: JTypeRef | undefined;
        if (/^(List|Set|Collection|Iterable|Stream|Optional|Flux|Mono|CompletableFuture|Page|Slice)$/.test(recv.name)) elem = recv.args[0];
        if (recv.name === 'Map' && recv.args.length === 2) elem = seg.name === 'forEach' ? recv.args[1] : recv.args[0];
        if (!elem) continue;
        const fromInjectedCollection = c.base.kind === 'name' && i === 1 && !!this.index.findField(t, c.segments[0].name);
        for (const l of lambdas) {
          if (recv.name === 'Map' && seg.name === 'forEach' && l.params.length === 2) {
            scope.lambdaParams.set(l.params[0], recv.args[0]);
            scope.lambdaParams.set(l.params[1], recv.args[1]);
          } else scope.lambdaParams.set(l.params[0], elem);
          if (fromInjectedCollection) for (const p of l.params) scope.collectionParams.add(p);
        }
      }
    }
    return scope;
  }

  analyzeMethod(t: JType, m: JMethod) {
    const owner = this.methodNode(t, m);
    const scope = this.scopeFor(t, m);
    for (const c of m.chains) {
      if (!c.segments.some((s) => s.call) && c.base.kind !== 'new') continue;
      if (this.tryExternal(c, scope, owner)) continue;
      this.resolveChainCalls(c, scope, owner);
    }
  }

  private resolveChainCalls(c: Chain, scope: Scope, owner: GraphNode) {
    // constructor call
    if (c.base.kind === 'new') {
      const t = this.index.resolveType(c.base.type.name, scope.type);
      const arity = c.base.args.length;
      if (t) {
        const ctor = t.methods.find((m) => m.isConstructor && m.params.length === arity) ?? t.methods.find((m) => m.isConstructor);
        this.edges.add(owner.id, ctor ? this.methodNode(t, ctor).id : this.classNode(t).id, 'calls', c.line);
      } else this.libraryCall(c.base.type.name, '<init>', scope, owner, c.line, true);
    }
    let start = 0;
    let curRef: JTypeRef | undefined;
    let viaInjection: Injection | undefined;
    let staticRef = false;
    if (c.base.kind === 'this') curRef = { name: scope.type.name, args: [], dims: 0, raw: '' };
    else if (c.base.kind === 'super') curRef = scope.type.superclass;
    else if (c.base.kind === 'new') curRef = c.base.type;
    else if (c.base.kind === 'expr') curRef = c.base.expr.kind === 'chain' ? this.chainResultRef(c.base.expr, scope) : undefined;
    else {
      const first = c.segments[0];
      if (first.call) {
        // unqualified call: own / inherited method, static import, or lambda-local
        const fm = this.index.findMethod(scope.type, first.name, first.call.args.length);
        if (fm) this.edges.add(owner.id, this.methodNode(fm.type, fm.method).id, 'calls', c.line);
        else if (first.name !== '<this>' && first.name !== '<super>' && first.name !== '<call>') {
          const st = this.staticImportTarget(first.name, scope.type);
          if (st) this.edges.add(owner.id, this.methodNode(st.type, st.method).id, 'calls', c.line);
          else this.unresolved++;
        } else if (first.name === '<super>' || first.name === '<this>') {
          const target = first.name === '<super>' ? this.index.resolveType(scope.type.superclass?.name, scope.type) : scope.type;
          const ctor = target?.methods.find((mm) => mm.isConstructor && mm.params.length === first.call!.args.length);
          if (target && ctor) this.edges.add(owner.id, this.methodNode(target, ctor).id, 'calls', c.line);
        }
        curRef = fm?.method.returnType;
        start = 1;
      } else {
        const info = this.typeOfName(first.name, scope);
        if (info) {
          curRef = info.ref;
          staticRef = !!info.isStatic;
          if (info.field && info.ref) {
            const inj = this.index.resolveInjection(info.ref, scope.type, JavaIndex.qualifierOf(info.field.annotations));
            if (inj?.via) viaInjection = inj;
          }
          start = 1;
        } else {
          // package-qualified static call a.b.C.m()
          let i = 0;
          while (i < c.segments.length && /^[a-z]/.test(c.segments[i].name) && !c.segments[i].call) i++;
          const t = i < c.segments.length && !c.segments[i].call ? this.index.resolveType(c.segments[i].name, scope.type) : undefined;
          if (t) {
            curRef = { name: t.name, args: [], dims: 0, raw: '' };
            staticRef = true;
            start = i + 1;
          } else {
            // unknown receiver (e.g. field from Lombok builder, untyped lambda param): count once
            if (c.segments.some((s) => s.call)) {
              this.unresolved++;
              this.noteUnresolvedClient(c, scope, owner, undefined, 'receiver not declared in scope');
            }
            return;
          }
        }
      }
    }
    for (let i = start; i < c.segments.length; i++) {
      const seg = c.segments[i];
      if (!seg.call) {
        // field access step
        const t = curRef ? this.index.resolveType(curRef.name, scope.type) : undefined;
        const f = t ? this.index.findField(t, seg.name) : undefined;
        curRef = f?.field.type;
        staticRef = false;
        if (f) {
          const inj = this.index.resolveInjection(f.field.type, f.type, JavaIndex.qualifierOf(f.field.annotations));
          viaInjection = inj?.via ? inj : undefined;
        } else viaInjection = undefined;
        continue;
      }
      if (!curRef) {
        this.unresolved++;
        this.noteUnresolvedClient(c, scope, owner, undefined, 'receiver type could not be inferred');
        return;
      }
      // unwrap wrappers before dispatch: Optional<X>.get()/orElse, Mono<X>.block(), List<X>.get(i) -> X
      let recvRef = curRef;
      const recvType = this.index.resolveType(recvRef.name, scope.type);
      if (!recvType && OPTIONAL_LIKE.has(recvRef.name) && UNWRAP_METHODS.has(seg.name) && recvRef.args.length) {
        curRef = recvRef.args[0];
        continue;
      }
      if (!recvType) {
        // library receiver
        if (recvRef.name === 'Map' && /^(get|getOrDefault|remove)$/.test(seg.name) && recvRef.args.length === 2) curRef = recvRef.args[1];
        else if (/^(getBody|block|join|get|orElse|orElseThrow|orElseGet|toList|stream|findFirst)$/.test(seg.name) && recvRef.args.length) curRef = recvRef.args[0];
        else {
          this.libraryCall(recvRef.name, seg.name, scope, owner, c.line, false);
          if (i === start) this.noteUnresolvedClient(c, scope, owner, recvRef.name, `library type ${recvRef.name} (not in project, no external rule matched)`);
          curRef = recvRef.name === 'String' ? recvRef : undefined;
          if (!curRef) return;
        }
        continue;
      }
      // project receiver: DI expansion for interface / abstract receivers
      let targets: JType[] = [recvType];
      let label: string | undefined;
      if (this.index.isAbstractLike(recvType) && !staticRef) {
        const inj = viaInjection?.via === recvType ? viaInjection : this.index.resolveInjection(recvRef, scope.type);
        const impls = inj?.targets.filter((x) => x !== recvType) ?? this.index.beanImplementations(recvType);
        const fanOut = inj?.collection || (i === 1 && c.base.kind === 'name' && scope.collectionParams.has(c.segments[0].name));
        if (impls.length) {
          targets = impls;
          label = `via ${recvType.name}${fanOut ? ' (all)' : inj?.ambiguous ? ' (ambiguous)' : ''}`;
        }
      }
      let returned: JTypeRef | undefined;
      let any = false;
      for (const tt of targets) {
        const fm = this.index.findMethod(tt, seg.name, seg.call.args.length);
        if (!fm) continue;
        any = true;
        this.edges.add(owner.id, this.methodNode(fm.type, fm.method).id, 'calls', c.line, label);
        returned ??= fm.method.returnType;
      }
      if (!any) {
        // method declared on a library supertype (e.g. JpaRepository.save) or Lombok-generated accessor
        const lombok = this.lombokAccessor(recvType, seg.name);
        if (lombok) returned = lombok;
        else {
          const libSuper = this.index.allSupertypeRefs(recvType).find((r) => !this.index.resolveType(r.name, recvType));
          if (libSuper) this.libraryCall(libSuper.name, seg.name, scope, owner, c.line, false);
          else this.unresolved++;
          returned = undefined;
        }
      }
      curRef = returned;
      staticRef = false;
      viaInjection = undefined;
      if (!curRef) return;
    }
  }

  /** Remember call sites on receivers that look like HTTP/RPC clients but were not understood (for `xsa seams --explain`). */
  private noteUnresolvedClient(c: Chain, scope: Scope, owner: GraphNode, typeName: string | undefined, reason: string) {
    const first = c.segments.findIndex((s) => s.call);
    if (first < 0 || this.unresolvedClientCalls.length >= 500) return;
    const receiver = c.base.kind === 'name' ? c.segments.slice(0, Math.max(first, 1)).map((s) => s.name).join('.') : c.base.kind;
    const method = c.segments[first].name;
    const looksClient = /client|api|template|rest|http|gateway|proxy|service|feign|stub|engine|bpmn|process|workflow|connector/i.test(receiver + ' ' + (typeName ?? ''));
    if (!looksClient) return;
    this.unresolvedClientCalls.push({ project: this.project, node: owner.id, file: owner.file, line: c.line, receiver, receiverType: typeName, method, reason });
  }

  /** Lombok @Getter/@Setter/@Data/@Builder generated accessors: return the field type for getters. */
  private lombokAccessor(t: JType, name: string): JTypeRef | undefined {
    const m = name.match(/^(get|is|set|with)([A-Z]\w*)$/);
    if (!m) return name === 'builder' || name === 'build' || name === 'toBuilder' ? { name: t.name, args: [], dims: 0, raw: t.name } : undefined;
    const prop = m[2][0].toLowerCase() + m[2].slice(1);
    const f = this.index.findField(t, prop);
    if (!f) return t.kind === 'record' ? undefined : undefined;
    return m[1] === 'get' || m[1] === 'is' ? f.field.type : { name: t.name, args: [], dims: 0, raw: t.name };
  }

  private staticImportTarget(name: string, from: JType): { type: JType; method: JMethod } | undefined {
    const file = this.index.fileOf.get(from.fqn);
    for (const imp of file?.imports ?? []) {
      if (!imp.isStatic) continue;
      const fqn = imp.wildcard ? imp.name : imp.name.endsWith('.' + name) ? imp.name.slice(0, -name.length - 1) : undefined;
      if (!fqn) continue;
      const t = this.index.types.get(fqn);
      const m = t?.methods.find((x) => x.name === name);
      if (t && m) return { type: t, method: m };
    }
    return undefined;
  }

  private libraryCall(typeName: string, method: string, scope: Scope, owner: GraphNode, line: number, isCtor: boolean) {
    const pkg = this.index.libraryPackage(typeName, scope.type);
    if (!pkg) {
      this.unresolved++;
      return;
    }
    if (BUILTIN_PKG.test(pkg)) {
      if (!this.opts.includeBuiltins) return;
      this.edges.add(owner.id, this.registry.builtinNode(`${typeName}.${isCtor ? 'new' : method}`).id, 'calls', line);
      return;
    }
    const group = pkg.split('.').slice(0, 3).join('.');
    if ((this.opts.ignorePackages ?? []).some((p) => (p.endsWith('*') ? group.startsWith(p.slice(0, -1)) : p === group || p === pkg))) return;
    this.edges.add(owner.id, this.registry.packageNode(group, `${typeName}.${isCtor ? 'new' : method}`).id, 'calls', line);
  }

  /* ----- external calls ----- */

  private beanBaseUrl(typeName: string, fieldName?: string, qualifier?: string): string | undefined {
    const candidates = this.index.beanMethods.filter((b) => b.returnType.name === typeName || b.returnType.name === typeName + 'Builder');
    if (!candidates.length) return undefined;
    const pick = candidates.find((b) => b.name === (qualifier ?? fieldName)) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!pick) return undefined;
    const scope = this.scopeFor(pick.config, pick.method);
    for (const c of pick.method.chains) {
      for (const seg of c.segments) {
        if (seg.call && /^(baseUrl|rootUri|create|defaultUriVariables|uriTemplateHandler)$/.test(seg.name) && seg.call.args.length) {
          const v = this.evalString(seg.call.args[0], scope);
          if (v && v !== '{?}') return v;
        }
      }
    }
    return undefined;
  }

  private addExternal(owner: GraphNode, line: number, category: ExternalCategory, protocol: string, callee: string, details: { method?: string; target?: string; service?: string; operationId?: string; rule: string }) {
    const call: ExternalCall = {
      id: `ext:${this.project}:${this.counter.n++}`,
      category,
      protocol,
      callee,
      method: details.method,
      target: details.target,
      service: details.service,
      operationId: details.operationId,
      file: owner.file,
      line,
      caller: owner.id,
      project: this.project,
      rule: details.rule,
    };
    call.node = attachExternalNode(call, this.registry, this.edges, this.openapi).id;
    this.externalCalls.push(call);
  }

  /** Try to interpret a chain as a call leaving the process. Returns true when handled. */
  private tryExternal(c: Chain, scope: Scope, owner: GraphNode): boolean {
    const segs = c.segments;
    if (c.base.kind === 'new') {
      // new RestTemplate().getForObject(...) / HttpRequest.newBuilder(...) style handled below via type name
      const t = c.base.type.name;
      if (/^(WebSocket|Socket)$/.test(t)) {
        this.addExternal(owner, c.line, 'websocket', t, `new ${t}`, { target: this.evalString(c.base.args[0], scope), rule: 'java-socket' });
        return true;
      }
      if (!segs.some((s) => s.call)) return false;
    }
    const firstCallIdx = segs.findIndex((s) => s.call);
    if (firstCallIdx < 0) return false;
    // receiver: everything before the first call
    let recvRef: JTypeRef | undefined;
    let recvType: JType | undefined;
    let recvName: string | undefined;
    let fieldQualifier: string | undefined;
    if (c.base.kind === 'new') recvRef = c.base.type;
    else if (c.base.kind === 'name' && firstCallIdx > 0) {
      recvName = segs[firstCallIdx - 1].name;
      recvRef = this.chainResultRef(c, scope, firstCallIdx);
      const info = firstCallIdx === 1 ? this.typeOfName(segs[0].name, scope) : undefined;
      if (info?.field) fieldQualifier = JavaIndex.qualifierOf(info.field.annotations);
      if (!recvRef && firstCallIdx === 1) {
        // unresolvable declared type (generated client not present): use the declared name
        const f = this.index.findField(scope.type, segs[0].name);
        const p = scope.method.params.find((x) => x.name === segs[0].name);
        const l = scope.method.locals.find((x) => x.name === segs[0].name);
        recvRef = f?.field.type ?? p?.type ?? l?.type;
      }
    } else if (c.base.kind === 'this' && firstCallIdx > 0) {
      recvName = segs[firstCallIdx - 1].name;
      recvRef = this.chainResultRef(c, scope, firstCallIdx);
    }
    if (recvRef) recvType = this.index.resolveType(recvRef.name, scope.type);
    let typeName = recvRef?.name ?? '';
    // WebClient.Builder / RestClient.Builder / RestTemplateBuilder receivers behave like the client they build
    if (recvRef && /^(WebClient|RestClient)\.Builder$/.test(recvRef.raw.replace(/\s/g, ''))) typeName = recvRef.raw.split('.')[0];
    if (typeName === 'RestTemplateBuilder') typeName = 'RestTemplate';
    const call = segs[firstCallIdx];
    const callee = segs.slice(0, firstCallIdx + 1).map((s) => s.name).join('.');
    const argStr = (i: number) => this.evalString(call.call!.args[i], scope);

    // ---- Spring RestTemplate ----
    if (/^(RestTemplate|TestRestTemplate|RestOperations|AsyncRestTemplate)$/.test(typeName)) {
      const m = call.name.match(/^(get|post|put|delete|patch|head|options)(For\w+)?$/);
      let method = m ? m[1].toUpperCase() : undefined;
      if (/^(exchange|execute)$/.test(call.name)) method = (argStr(1) ?? 'HttpMethod.?').split('.').pop()?.toUpperCase();
      if (!method) return false;
      let target = argStr(0);
      const base = this.beanBaseUrl('RestTemplate', recvName, fieldQualifier);
      if (base && target && !/^https?:\/\//.test(target)) target = base.replace(/\/$/, '') + '/' + target.replace(/^\//, '');
      this.addExternal(owner, c.line, 'http', 'RestTemplate', callee, { method, target, rule: 'java-resttemplate' });
      return true;
    }
    // ---- WebClient / RestClient fluent chains ----
    if (/^(WebClient|RestClient)$/.test(typeName) || (c.base.kind === 'name' && /^(WebClient|RestClient)$/.test(segs[0].name))) {
      const builderBase = segs.find((s) => s.call && /^(baseUrl|rootUri)$/.test(s.name));
      const verb = segs.find((s) => s.call && /^(get|post|put|delete|patch|head|options|method)$/.test(s.name));
      const uri = segs.find((s) => s.call && s.name === 'uri');
      if (!verb) return false;
      let method = verb.name === 'method' ? (this.evalString(verb.call!.args[0], scope) ?? 'HttpMethod.?').split('.').pop()!.toUpperCase() : verb.name.toUpperCase();
      let target: string | undefined;
      if (uri) {
        const a0 = uri.call!.args[0];
        if (a0?.kind === 'lambda') {
          // uriBuilder -> uriBuilder.path("/x").queryParam(...).build(...)
          const inner = a0.body.find((b): b is Chain => b.kind === 'chain');
          target = inner ? this.applyStringSegmentsPublic(inner, scope) : undefined;
        } else target = this.evalString(a0, scope);
      }
      let base: string | undefined;
      if (builderBase?.call?.args[0]) base = this.evalString(builderBase.call.args[0], scope);
      else if (c.base.kind === 'name' && /^(WebClient|RestClient)$/.test(segs[0].name)) {
        const create = segs.find((s) => s.call && /^(create|baseUrl)$/.test(s.name));
        base = create?.call?.args[0] ? this.evalString(create.call.args[0], scope) : undefined;
      } else base = this.beanBaseUrl(typeName, recvName, fieldQualifier);
      if (base && target && !/^https?:\/\//.test(target)) target = base.replace(/\/$/, '') + '/' + target.replace(/^\//, '');
      else if (base && !target) target = base;
      this.addExternal(owner, c.line, 'http', typeName || segs[0].name, callee, { method, target, rule: 'java-webclient' });
      return true;
    }
    // ---- java.net.http HttpRequest builder ----
    if (c.base.kind === 'name' && segs[0].name === 'HttpRequest' && segs[1]?.name === 'newBuilder') {
      const uri = segs.find((s) => s.call && s.name === 'uri');
      const verb = segs.find((s) => s.call && /^(GET|POST|PUT|DELETE|PATCH|method)$/.test(s.name));
      const target = uri?.call?.args[0] ? this.evalString(uri.call.args[0], scope) : segs[1].call?.args[0] ? this.evalString(segs[1].call.args[0], scope) : undefined;
      const method = verb ? (verb.name === 'method' ? (this.evalString(verb.call!.args[0], scope) ?? '?').toUpperCase() : verb.name) : 'GET';
      this.addExternal(owner, c.line, 'http', 'java.net.http', callee, { method, target, rule: 'java-httpclient' });
      return true;
    }
    // ---- OkHttp ----
    if (c.base.kind === 'new' && /^(Request\.Builder|Builder)$/.test(c.base.type.raw.replace(/\s/g, '')) && segs.some((s) => s.name === 'url')) {
      const url = segs.find((s) => s.call && s.name === 'url');
      const verb = segs.find((s) => s.call && /^(get|post|put|delete|patch|head|method)$/.test(s.name));
      this.addExternal(owner, c.line, 'http', 'okhttp', callee, { method: verb ? verb.name.toUpperCase() : 'GET', target: url?.call?.args[0] ? this.evalString(url.call.args[0], scope) : undefined, rule: 'java-okhttp' });
      return true;
    }
    // ---- Feign client interface ----
    if (recvType && ann(recvType.annotations, 'FeignClient')) {
      const fc = ann(recvType.annotations, 'FeignClient')!;
      const fm = this.index.findMethod(recvType, call.name, call.call!.args.length);
      const mapping = fm ? methodMapping(fm.method, this.index.props) : undefined;
      const base = this.index.props.resolve(annValue(fc, 'url')[0]) ?? `http://${this.index.props.resolve(annValue(fc, 'name', 'value')[0]) ?? recvType.name}`;
      const prefix = this.index.props.resolve(annValue(fc, 'path')[0]) ?? '';
      const classPrefix = classMapping(recvType, this.index.props)[0] ?? '';
      const target = base.replace(/\/$/, '') + joinPath(prefix, classPrefix, mapping?.paths[0]);
      this.addExternal(owner, c.line, 'http', 'feign', callee, { method: mapping?.methods[0] ?? 'GET', target, service: recvType.name, rule: 'java-feign' });
      return true;
    }
    // ---- Spring Data repositories ----
    if (recvType) {
      const entity = this.index.repositoryEntity(recvType);
      if (entity) {
        this.addExternal(owner, c.line, 'db', 'spring-data', callee, { method: call.name, target: entity.name, service: recvType.name, rule: 'java-spring-data' });
        return true;
      }
    }
    // ---- JDBC / JPA / Mongo / Redis templates ----
    if (/^(JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|SimpleJdbcInsert|JdbcOperations)$/.test(typeName)) {
      const sql = argStr(0);
      this.addExternal(owner, c.line, 'db', 'jdbc', callee, { method: call.name, target: sql ? sql.replace(/\s+/g, ' ').slice(0, 80) : undefined, rule: 'java-jdbc' });
      return true;
    }
    if (/^(EntityManager|Session|SessionFactory|Query|TypedQuery|CriteriaBuilder)$/.test(typeName) && /^(persist|merge|remove|find|createQuery|createNamedQuery|createNativeQuery|getResultList|getSingleResult|executeUpdate|save|delete|get|load)$/.test(call.name)) {
      const q = argStr(0);
      this.addExternal(owner, c.line, 'db', 'jpa', callee, { method: call.name, target: q && /select|update|delete|from/i.test(q) ? q.replace(/\s+/g, ' ').slice(0, 80) : undefined, rule: 'java-jpa' });
      return true;
    }
    if (/^(MongoTemplate|ReactiveMongoTemplate|MongoOperations)$/.test(typeName)) {
      this.addExternal(owner, c.line, 'db', 'mongo', callee, { method: call.name, target: this.evalString(call.call!.args[call.call!.args.length - 1], scope), rule: 'java-mongo' });
      return true;
    }
    if (/^(RedisTemplate|StringRedisTemplate|ReactiveRedisTemplate|Jedis|JedisPool|RedisCommands)$/.test(typeName)) {
      const op = segs.slice(firstCallIdx).map((s) => s.name).join('.');
      this.addExternal(owner, c.line, 'db', 'redis', callee, { method: op, target: this.evalString(segs[segs.length - 1].call?.args[0], scope), rule: 'java-redis' });
      return true;
    }
    if (/^(ElasticsearchClient|RestHighLevelClient|ElasticsearchOperations|ElasticsearchRestTemplate)$/.test(typeName)) {
      this.addExternal(owner, c.line, 'db', 'elasticsearch', callee, { method: call.name, rule: 'java-elasticsearch' });
      return true;
    }
    // ---- messaging ----
    if (/^(KafkaTemplate|ReactiveKafkaProducerTemplate|KafkaOperations)$/.test(typeName) && /^(send|sendDefault|sendOffsetsToTransaction|executeInTransaction)$/.test(call.name)) {
      const topic = call.name === 'sendDefault' ? this.index.props.get('spring.kafka.template.default-topic') : argStr(0);
      this.addExternal(owner, c.line, 'messaging', 'kafka', callee, { method: 'send', target: topic ?? '{topic}', rule: 'java-kafka' });
      return true;
    }
    if (/^(RabbitTemplate|AmqpTemplate|RabbitMessagingTemplate|RabbitOperations)$/.test(typeName) && /^(convertAndSend|send|convertSendAndReceive|sendAndReceive|convertSendAndReceiveAsType)$/.test(call.name)) {
      const n = call.call!.args.length;
      const strings = call.call!.args.map((a) => (a.kind === 'literal' && a.isString) || a.kind === 'binary' || (a.kind === 'chain' && !a.segments.some((s) => s.call)) ? this.evalString(a, scope) : undefined);
      let exchange: string | undefined;
      let key: string | undefined;
      if (n >= 3 && strings[0] !== undefined && strings[1] !== undefined) {
        exchange = strings[0];
        key = strings[1];
      } else if (n >= 2 && strings[0] !== undefined) {
        exchange = this.index.props.get('spring.rabbitmq.template.exchange') ?? '';
        key = strings[0];
      } else {
        exchange = this.index.props.get('spring.rabbitmq.template.exchange') ?? '';
        key = this.index.props.get('spring.rabbitmq.template.routing-key') ?? '{routingKey}';
      }
      this.addExternal(owner, c.line, 'messaging', 'rabbit', callee, { method: 'send', target: `${exchange}/${key}`, rule: 'java-rabbit' });
      return true;
    }
    if (/^(JmsTemplate|JmsMessagingTemplate|JmsOperations)$/.test(typeName) && /^(convertAndSend|send|sendAndReceive)$/.test(call.name)) {
      const dest = call.call!.args.length >= 2 ? argStr(0) : this.index.props.get('spring.jms.template.default-destination');
      this.addExternal(owner, c.line, 'messaging', 'jms', callee, { method: 'send', target: dest ?? '{destination}', rule: 'java-jms' });
      return true;
    }
    if (/^(StreamBridge)$/.test(typeName) && call.name === 'send') {
      this.addExternal(owner, c.line, 'messaging', 'spring-cloud-stream', callee, { method: 'send', target: argStr(0), rule: 'java-stream-bridge' });
      return true;
    }
    if (/^(SqsTemplate|SqsAsyncClient|SqsClient|SnsClient|SnsTemplate|QueueMessagingTemplate|NotificationMessagingTemplate)$/.test(typeName) && /^(send|sendMessage|publish|convertAndSend|sendNotification)$/.test(call.name)) {
      this.addExternal(owner, c.line, 'messaging', typeName.startsWith('Sns') ? 'sns' : 'sqs', callee, { method: call.name, target: argStr(0), rule: 'java-aws-messaging' });
      return true;
    }
    if (/^(PubSubTemplate|Publisher)$/.test(typeName) && /^(publish)$/.test(call.name)) {
      this.addExternal(owner, c.line, 'messaging', 'pubsub', callee, { method: 'publish', target: argStr(0), rule: 'java-pubsub' });
      return true;
    }
    // ---- gRPC stubs ----
    if (/(BlockingStub|FutureStub|AsyncStub|Stub)$/.test(typeName) && !recvType) {
      this.addExternal(owner, c.line, 'grpc', 'grpc-java', callee, { method: call.name, service: typeName.replace(/(Blocking|Future|Async)?Stub$/, ''), target: call.name, rule: 'java-grpc' });
      return true;
    }
    // ---- generated OpenAPI client (present or absent) ----
    if (!recvType || /Api$/.test(recvType.name)) {
      const looksGenerated = /(Api|ApiClient|Client)$/.test(typeName) || (recvName !== undefined && /(api|client)$/i.test(recvName));
      const ops = this.openapi.lookup(call.name).filter((o) => o.explicitId);
      if (ops.length && (looksGenerated || !recvType)) {
        const op = ops[0];
        this.addExternal(owner, c.line, 'http', 'openapi-client', callee, { method: op.method, target: op.path, service: typeName || undefined, operationId: op.operationId, rule: 'java-openapi-client' });
        return true;
      }
      if (looksGenerated && !recvType && typeName && /Api$/.test(typeName) && call.name !== 'getApiClient') {
        this.addExternal(owner, c.line, 'http', 'openapi-client', callee, { method: call.name, service: typeName, rule: 'java-openapi-client' });
        return true;
      }
    }
    return false;
  }

  private applyStringSegmentsPublic(inner: Chain, scope: Scope): string | undefined {
    // uriBuilder.path("/x").queryParam("a", b).build(id): skip the builder identifier
    return this.applyStringSegments('', inner.segments.slice(1), scope, 0);
  }

  /* ----- entry points ----- */

  tagEntries(t: JType) {
    const isController = !!ann(t.annotations, 'RestController', 'Controller', 'Path');
    const prefixes = classMapping(t, this.index.props);
    const projectInterfaces = this.index.supertypes(t).filter((s) => s.kind === 'interface');
    for (const m of t.methods) {
      if (m.isConstructor) continue;
      const node = this.methodNode(t, m);
      let mapping = methodMapping(m, this.index.props);
      // mappings declared on an implemented (generated) interface method
      if (!mapping) {
        for (const iface of projectInterfaces) {
          const im = iface.methods.find((x) => x.name === m.name && x.params.length === m.params.length);
          const mm = im && methodMapping(im, this.index.props);
          if (mm) {
            mapping = mm;
            const ifacePrefix = classMapping(iface, this.index.props);
            if (ifacePrefix.some(Boolean) && !prefixes.some(Boolean)) prefixes.splice(0, prefixes.length, ...ifacePrefix);
            break;
          }
        }
      }
      if (mapping && (isController || projectInterfaces.length || ann(t.annotations, 'RequestMapping'))) {
        const routes = prefixes.flatMap((p) => mapping!.paths.map((mp) => joinPath(this.contextPath, p, mp)));
        node.entry = 'spring:endpoint';
        node.route = routes[0];
        node.httpMethods = mapping.methods;
        if (routes.length > 1) node.tags = [...(node.tags ?? []), ...routes.slice(1).map((r) => `route:${r}`)];
        const op = this.openapi.lookup(m.name).find((o) => o.explicitId && o.method === mapping!.methods[0]);
        if (op) node.operationId = op.operationId;
        continue;
      }
      const listener = listenerOf(m, this.index.props);
      if (listener) {
        node.entry = 'spring:listener';
        node.topics = listener.topics;
        node.route = listener.topics[0];
        node.tags = [...(node.tags ?? []), listener.system];
        continue;
      }
      if (ann(m.annotations, 'Scheduled', 'Schedules')) node.entry = 'spring:scheduled';
      else if (ann(m.annotations, 'EventListener', 'TransactionalEventListener', 'ApplicationModuleListener')) node.entry = 'spring:event';
      else if (m.name === 'main' && m.modifiers.includes('static')) node.entry = 'main';
      else if (m.name === 'run' && this.index.supertypes(t).some((s) => /^(CommandLineRunner|ApplicationRunner)$/.test(s.name)) || t.interfaces.some((i) => /^(CommandLineRunner|ApplicationRunner)$/.test(i.name)) && m.name === 'run') node.entry = 'main';
    }
    if (isController || t.interfaces.some((i) => /(Api|Delegate|Controller)$/.test(i.name)) || ann(t.annotations, 'Component', 'Service')) {
      // generated-server style: `implements UsersApi` with the interface absent -> operationId names
      const absentApi = t.interfaces.some((i) => /(Api|Delegate)$/.test(i.name) && !this.index.resolveType(i.name, t));
      if (absentApi || isController) {
        for (const m of t.methods) {
          const node = this.nodeByMethod.get(m);
          if (!node || node.entry || m.isConstructor || !m.modifiers.includes('public')) continue;
          const op = this.openapi.lookup(m.name).find((o) => o.explicitId);
          if (!op) continue;
          node.entry = 'openapi:operation';
          node.operationId = op.operationId;
          node.route = joinPath(this.contextPath, op.path);
          node.httpMethods = [op.method];
          node.tags = [...(node.tags ?? []), ...op.servers.map((s) => `server:${s}`)];
        }
      }
    }
  }
}

/* ---------- project entry point ---------- */

export function analyzeJava(opts: AnalyzerOptions, shared?: { openapi?: OpenApiIndex }): Analysis {
  const t0 = Date.now();
  const root = path.resolve(opts.root);
  const log = opts.onProgress ?? (() => {});
  const excludeRe = (opts.exclude ?? []).map(globToRegExp);
  const warnings: string[] = [];
  const project = opts.project ?? path.basename(root);
  const props = loadSpringProps(root, excludeRe, opts.profiles ?? [], opts.properties ?? {});
  const openapi = shared?.openapi ?? loadOpenApi(root, opts.openapi, excludeRe, warnings);
  const files = listJavaFiles(root, !!opts.includeTests, excludeRe);
  log(`java: ${files.length} source files, ${props.size} properties from ${props.files.join(', ') || 'no application.yml'}`);
  const parsed: JFile[] = [];
  let done = 0;
  for (const f of files) {
    const rel = normalize(path.relative(root, f));
    let jf: JFile;
    try {
      jf = parseJava(fs.readFileSync(f, 'utf8'), rel);
    } catch (e) {
      jf = { path: rel, package: '', imports: [], types: [], parseError: String((e as Error).message) };
    }
    if (jf.parseError) warnings.push(`java: could not parse ${rel}: ${jf.parseError}`);
    parsed.push(jf);
    done++;
    if (done % 100 === 0 || done === files.length) log(`java: parsed ${done}/${files.length}`);
  }
  const index = new JavaIndex(parsed, props);
  const an = new JavaAnalyzer(root, project, index, openapi, opts);
  // nodes first (so cross references resolve), then calls
  for (const t of index.types.values()) for (const m of t.methods) an.methodNode(t, m);
  for (const t of index.types.values()) an.tagEntries(t);
  for (const t of index.types.values()) {
    for (const m of t.methods) {
      try {
        an.analyzeMethod(t, m);
      } catch (e) {
        warnings.push(`java: failed analyzing ${t.fqn}.${m.name}: ${(e as Error).message}`);
      }
    }
  }
  for (const jf of parsed) {
    an.files.push({ path: jf.path, project, language: 'java', package: jf.package, imports: jf.imports.map((i) => ({ module: i.name, names: [i.wildcard ? '*' : i.name.split('.').pop()!], internal: !!index.types.get(i.name) || [...index.types.keys()].some((k) => k.startsWith(i.name + '.')), resolvedPackage: undefined })) });
  }

  const edgeList = [...an.edges.edges.values()].filter((e) => an.registry.nodes.has(e.from) && an.registry.nodes.has(e.to));
  const referenced = new Set<string>();
  for (const e of edgeList) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  for (const c of an.externalCalls) referenced.add(c.caller);
  const nodes = [...an.registry.nodes.values()].filter((n) => n.internal || referenced.has(n.id));
  const serviceName = props.get('spring.application.name');
  const port = props.get('server.port');
  const hosts = [...new Set([...(opts.hosts ?? []), ...(serviceName ? [serviceName] : []), ...(port ? [`localhost:${port}`, `127.0.0.1:${port}`] : [])])];
  const info: ProjectInfo = {
    name: project,
    root: normalize(root),
    language: 'java',
    serviceName,
    contextPath: props.get('server.servlet.context-path') ?? undefined,
    port,
    hosts,
    files: parsed.length,
    propertyFiles: props.files,
    warnings: warnings.length,
  };
  return {
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    root: normalize(root),
    projects: [info],
    seams: [],
    projectEdges: [],
    packages: [{ name: project, dir: '.', files: parsed.length }],
    files: an.files,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edgeList.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    externalCalls: an.externalCalls,
    machines: [],
    openapi: { specs: openapi.specs, operations: openapi.operations },
    diagnostics: { unresolvedClientCalls: an.unresolvedClientCalls },
    stats: {
      files: parsed.length,
      functions: nodes.filter((n) => n.kind === 'method' || n.kind === 'function').length,
      components: 0,
      hooks: 0,
      edges: edgeList.length,
      machines: 0,
      externalCalls: an.externalCalls.length,
      unresolvedCalls: an.unresolved,
      durationMs: Date.now() - t0,
    },
    warnings,
  };
}

export type { EntryKind };
