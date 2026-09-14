import type { JField, JFile, JMethod, JType, JTypeRef } from './model.js';
import { STEREOTYPES, SpringProps, ann, annValue, beanName, isBeanClass } from './spring.js';

const JAVA_LANG = new Set(['String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte', 'Short', 'Math', 'System', 'Thread', 'Exception', 'RuntimeException', 'Throwable', 'StringBuilder', 'StringBuffer', 'Iterable', 'Comparable', 'Runnable', 'Class', 'Enum', 'Record', 'Void', 'Number', 'CharSequence']);
const COLLECTION_WRAPPERS = new Set(['List', 'Set', 'Collection', 'Iterable', 'ObjectProvider', 'Provider', 'Optional', 'Stream', 'Mono', 'Flux', 'CompletableFuture', 'Future', 'Supplier', 'ObjectFactory', 'Lazy']);

export interface BeanMethod {
  config: JType;
  method: JMethod;
  returnType: JTypeRef;
  name: string;
  /** concrete class instantiated in the body (`return new FooImpl()`), when the declared return type is an interface */
  concrete?: JType;
}

export interface Injection {
  targets: JType[];
  /** the declared (interface / abstract) type when targets are implementations of it */
  via?: JType;
  ambiguous: boolean;
  /** collection injection (List<X>) — all implementations intentionally */
  collection: boolean;
}

/**
 * Index of all types in a Java project with name resolution, inheritance
 * lookups and Spring dependency-injection resolution.
 */
export class JavaIndex {
  readonly types = new Map<string, JType>();
  readonly bySimple = new Map<string, JType[]>();
  readonly fileOf = new Map<string, JFile>(); // fqn -> file
  readonly beanMethods: BeanMethod[] = [];
  private implCache = new Map<string, JType[]>();
  private superCache = new Map<string, JType[]>();
  private injectionCache = new Map<string, Injection>();

  constructor(
    readonly files: JFile[],
    readonly props: SpringProps,
  ) {
    for (const f of files) {
      for (const t of f.types) {
        this.types.set(t.fqn, t);
        this.fileOf.set(t.fqn, f);
        const list = this.bySimple.get(t.name) ?? [];
        list.push(t);
        this.bySimple.set(t.name, list);
      }
    }
    for (const t of this.types.values()) {
      if (!ann(t.annotations, 'Configuration', 'SpringBootApplication', 'TestConfiguration', 'AutoConfiguration')) continue;
      for (const m of t.methods) {
        if (!ann(m.annotations, 'Bean') || !m.returnType) continue;
        const name = annValue(ann(m.annotations, 'Bean'), 'value', 'name')[0] ?? m.name;
        this.beanMethods.push({ config: t, method: m, returnType: m.returnType, name });
      }
    }
    // second pass (needs the full type map): concrete types of @Bean factory methods
    for (const bm of this.beanMethods) {
      const declared = this.resolveType(bm.returnType.name, bm.config);
      if (!declared || !this.isAbstractLike(declared)) continue;
      for (const c of bm.method.chains) {
        if (c.base.kind !== 'new') continue;
        const t = this.resolveType(c.base.type.name, bm.config);
        if (t && !this.isAbstractLike(t) && (t === declared || this.supertypes(t).includes(declared))) {
          bm.concrete = t;
          break;
        }
      }
    }
  }

  /** Resolve a simple or qualified type name as seen from `from` (nested, same package, imports, unique simple name). */
  resolveType(name: string | undefined, from?: JType): JType | undefined {
    if (!name) return undefined;
    if (name.includes('.')) {
      const direct = this.types.get(name) ?? this.types.get(name.replace(/\.(?=[^.]*$)/, '$'));
      if (direct) return direct;
      name = name.split('.').pop()!;
    }
    if (from) {
      // nested in this type or in its outer types
      let outer: JType | undefined = from;
      while (outer) {
        const nested = this.types.get(`${outer.fqn}$${name}`);
        if (nested) return nested;
        const idx = outer.fqn.lastIndexOf('$');
        outer = idx > 0 ? this.types.get(outer.fqn.slice(0, idx)) : undefined;
      }
      const same = this.types.get(from.package ? `${from.package}.${name}` : name);
      if (same) return same;
      const file = this.fileOf.get(from.fqn);
      for (const imp of file?.imports ?? []) {
        if (imp.isStatic) continue;
        if (!imp.wildcard && imp.name.endsWith('.' + name)) return this.types.get(imp.name) ?? this.types.get(imp.name.replace(/\.(?=[^.]*$)/, '$'));
        if (imp.wildcard) {
          const t = this.types.get(`${imp.name}.${name}`) ?? this.types.get(`${imp.name}$${name}`);
          if (t) return t;
        }
      }
    }
    const candidates = this.bySimple.get(name) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** Package a non-project type comes from, according to the file's imports (`RestTemplate` -> `org.springframework.web.client`). */
  libraryPackage(name: string, from: JType): string | undefined {
    if (JAVA_LANG.has(name)) return 'java.lang';
    const file = this.fileOf.get(from.fqn);
    for (const imp of file?.imports ?? []) {
      if (!imp.wildcard && !imp.isStatic && imp.name.endsWith('.' + name)) return imp.name.slice(0, -name.length - 1);
    }
    const wildcards = (file?.imports ?? []).filter((i) => i.wildcard && !i.isStatic);
    if (wildcards.length === 1) return wildcards[0].name;
    return undefined;
  }

  /** Project supertypes (class + interfaces), transitive, nearest first. */
  supertypes(t: JType): JType[] {
    const cached = this.superCache.get(t.fqn);
    if (cached) return cached;
    const out: JType[] = [];
    const seen = new Set<string>([t.fqn]);
    const queue: JType[] = [t];
    while (queue.length) {
      const cur = queue.shift()!;
      const refs = [...(cur.superclass ? [cur.superclass] : []), ...cur.interfaces];
      for (const r of refs) {
        const st = this.resolveType(r.name, cur);
        if (st && !seen.has(st.fqn)) {
          seen.add(st.fqn);
          out.push(st);
          queue.push(st);
        }
      }
    }
    this.superCache.set(t.fqn, out);
    return out;
  }

  /** Names of all supertypes including library ones (for `extends JpaRepository<...>` checks). */
  allSupertypeRefs(t: JType): JTypeRef[] {
    const out: JTypeRef[] = [];
    const seen = new Set<string>();
    const visit = (x: JType) => {
      for (const r of [...(x.superclass ? [x.superclass] : []), ...x.interfaces]) {
        out.push(r);
        const st = this.resolveType(r.name, x);
        if (st && !seen.has(st.fqn)) {
          seen.add(st.fqn);
          visit(st);
        }
      }
    };
    visit(t);
    return out;
  }

  isAbstractLike(t: JType): boolean {
    return t.kind === 'interface' || t.modifiers.includes('abstract');
  }

  /** Concrete project classes implementing / extending `t` (transitively). */
  implementations(t: JType): JType[] {
    const cached = this.implCache.get(t.fqn);
    if (cached) return cached;
    const out: JType[] = [];
    for (const c of this.types.values()) {
      if (c === t || c.kind === 'interface' || c.kind === 'annotation' || c.modifiers.includes('abstract')) continue;
      if (this.supertypes(c).includes(t)) out.push(c);
    }
    this.implCache.set(t.fqn, out);
    return out;
  }

  /** Bean classes among implementations, plus classes produced by @Bean methods whose return type is `t` or a subtype. */
  beanImplementations(t: JType): JType[] {
    const impls = this.implementations(t).filter((c) => isBeanClass(c));
    for (const bm of this.beanMethods) {
      const rt = bm.concrete ?? this.resolveType(bm.returnType.name, bm.config);
      if (rt && rt !== t && !this.isAbstractLike(rt) && this.supertypes(rt).includes(t) && !impls.includes(rt)) impls.push(rt);
    }
    return impls;
  }

  /** Find a method by name (and arity when given) on a type or its project supertypes. */
  findMethod(t: JType, name: string, arity?: number): { type: JType; method: JMethod } | undefined {
    const chain = [t, ...this.supertypes(t)];
    let loose: { type: JType; method: JMethod } | undefined;
    for (const ty of chain) {
      for (const m of ty.methods) {
        if (m.name !== name) continue;
        if (arity === undefined || m.params.length === arity || (m.params.length < arity && m.params.some((p) => p.type.raw.includes('...')))) return { type: ty, method: m };
        loose ??= { type: ty, method: m };
      }
    }
    return loose;
  }

  /** Field by name on a type or its project superclasses. */
  findField(t: JType, name: string): { type: JType; field: JField } | undefined {
    for (const ty of [t, ...this.supertypes(t)]) {
      const f = ty.fields.find((x) => x.name === name);
      if (f) return { type: ty, field: f };
    }
    return undefined;
  }

  /** Constructor of `t` with the highest arity (Spring picks the single/@Autowired one; good enough). */
  constructorOf(t: JType): JMethod | undefined {
    const ctors = t.methods.filter((m) => m.isConstructor);
    return ctors.find((c) => ann(c.annotations, 'Autowired', 'Inject')) ?? ctors.sort((a, b) => b.params.length - a.params.length)[0];
  }

  /**
   * Resolve what an injected reference of declared type `ref` points to under
   * Spring DI: the implementation bean(s) of an interface / abstract class,
   * honouring @Qualifier, @Primary and collection injection.
   */
  resolveInjection(ref: JTypeRef, from: JType, qualifier?: string): Injection | undefined {
    const key = `${from.fqn}|${ref.raw}|${qualifier ?? ''}`;
    const cached = this.injectionCache.get(key);
    if (cached) return cached;
    let target = ref;
    let collection = false;
    if (COLLECTION_WRAPPERS.has(ref.name) && ref.args.length) {
      collection = ['List', 'Set', 'Collection', 'Iterable', 'Stream'].includes(ref.name);
      target = ref.args[ref.args.length - 1];
    } else if (ref.name === 'Map' && ref.args.length === 2) {
      collection = true;
      target = ref.args[1];
    }
    const declared = this.resolveType(target.name, from);
    if (!declared) return undefined;
    let result: Injection;
    if (this.isAbstractLike(declared)) {
      let impls = this.beanImplementations(declared);
      if (!impls.length) impls = this.implementations(declared);
      if (collection) result = { targets: impls.length ? impls : [declared], via: declared, ambiguous: false, collection: true };
      else if (qualifier) {
        const q = impls.filter((c) => beanName(c) === qualifier || c.name === qualifier || c.name.toLowerCase() === qualifier.toLowerCase());
        result = { targets: q.length ? q : impls.length ? impls : [declared], via: declared, ambiguous: !q.length && impls.length > 1, collection: false };
      } else {
        const primary = impls.filter((c) => ann(c.annotations, 'Primary'));
        const chosen = primary.length === 1 ? primary : impls;
        result = { targets: chosen.length ? chosen : [declared], via: declared, ambiguous: chosen.length > 1, collection: false };
      }
    } else {
      result = { targets: [declared], ambiguous: false, collection };
    }
    this.injectionCache.set(key, result);
    return result;
  }

  /** Qualifier of a field / parameter (`@Qualifier("x")`, `@Resource(name="x")`). */
  static qualifierOf(annotations: { name: string; args: Record<string, string | string[]> }[]): string | undefined {
    const q = annotations.find((a) => a.name === 'Qualifier');
    if (q) return (Array.isArray(q.args.value) ? q.args.value[0] : q.args.value) as string | undefined;
    const r = annotations.find((a) => a.name === 'Resource');
    if (r) return (Array.isArray(r.args.name) ? r.args.name[0] : r.args.name) as string | undefined;
    return undefined;
  }

  /** Stereotype annotations of a type (for tags). */
  static stereotypes(t: JType): string[] {
    return t.annotations.filter((a) => STEREOTYPES.includes(a.name)).map((a) => a.name);
  }

  /** Is this type a Spring Data repository (project interface extending a *Repository from spring-data)? */
  repositoryEntity(t: JType): JTypeRef | undefined {
    if (t.kind !== 'interface' && !ann(t.annotations, 'Repository')) return undefined;
    for (const r of this.allSupertypeRefs(t)) {
      if (/^(Jpa|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Mongo|Reactive\w*|Cassandra|Neo4j|Elasticsearch|R2dbc|Coroutine\w*|Jdbc|Keyvalue|Redis|Couchbase|Query\w*|JpaSpecificationExecutor)?Repository$/.test(r.name) && !this.resolveType(r.name, t)) {
        return r.args[0] ?? { name: '?', args: [], dims: 0, raw: '' };
      }
    }
    return undefined;
  }
}

export { SpringProps };
