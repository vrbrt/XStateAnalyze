import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION, analyze } from './analyze.js';
import { analyzeJava, isJavaProject } from './java/analyze.js';
import type { Analysis, AnalyzerOptions, GraphEdge, GraphNode, OpenApiOperation, ProjectEdge, ProjectInfo, Seam, SeamKind, SeamParty, UnresolvedClientCall } from './model.js';
import { OpenApiIndex, findSpecFiles, loadOpenApi } from './openapi.js';
import { normalize } from './project.js';

/* ---------- configuration ---------- */

export interface ProjectConfig {
  name: string;
  root: string;
  type?: 'ts' | 'java' | 'auto';
  /** host names / base URLs identifying this project as a call target (`users-service`, `api.example.com/v1`) */
  hosts?: string[];
  openapi?: string[];
  tsconfig?: string;
  include?: string[];
  exclude?: string[];
  includeTests?: boolean;
  openapiHandlers?: string[];
  ignorePackages?: string[];
  /** Spring profiles to merge (application-<profile>.*) */
  profiles?: string[];
  /** Extra / overriding Spring properties, e.g. values that only exist in the deployment environment */
  properties?: Record<string, string>;
}

export interface WorkspaceConfig {
  projects: ProjectConfig[];
  /** extra OpenAPI documents (files or directories) shared by all projects, e.g. a contracts repo */
  openapi?: string[];
}

export function loadWorkspaceConfig(file: string): WorkspaceConfig {
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as WorkspaceConfig;
  const dir = path.dirname(abs);
  if (!Array.isArray(raw.projects) || !raw.projects.length) throw new Error(`${file}: "projects" must be a non-empty array`);
  const names = new Set<string>();
  for (const p of raw.projects) {
    if (!p.name || !p.root) throw new Error(`${file}: every project needs "name" and "root"`);
    if (names.has(p.name)) throw new Error(`${file}: duplicate project name "${p.name}"`);
    names.add(p.name);
    p.root = path.resolve(dir, p.root);
    if (p.openapi) p.openapi = p.openapi.map((o) => path.resolve(dir, o));
  }
  if (raw.openapi) raw.openapi = raw.openapi.map((o) => path.resolve(dir, o));
  return raw;
}

/** `name=path` CLI pairs -> config */
export function projectsFromArgs(pairs: string[]): WorkspaceConfig {
  return {
    projects: pairs.map((p) => {
      const idx = p.indexOf('=');
      if (idx < 0) return { name: path.basename(path.resolve(p)), root: path.resolve(p) };
      return { name: p.slice(0, idx), root: path.resolve(p.slice(idx + 1)) };
    }),
  };
}

export function detectLanguage(root: string): 'ts' | 'java' | 'mixed' {
  const java = isJavaProject(root);
  const ts = fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'tsconfig.json'));
  if (java && ts) return 'mixed';
  return java ? 'java' : 'ts';
}

/* ---------- per-project analysis + merge ---------- */

function prefixId(project: string, id: string): string {
  if (id.startsWith('ext:') || id.startsWith('pkg:') || id.startsWith('builtin:')) return id;
  return `${project}::${id}`;
}

/** Namespace every internal id with the project name so results of several projects can coexist. */
export function prefixAnalysis(a: Analysis, project: string): Analysis {
  const map = (id: string) => prefixId(project, id);
  for (const n of a.nodes) {
    n.id = map(n.id);
    if (n.internal) n.project = project;
  }
  for (const e of a.edges) {
    e.from = map(e.from);
    e.to = map(e.to);
  }
  for (const c of a.externalCalls) {
    c.caller = map(c.caller);
    c.project = project;
  }
    for (const d of a.diagnostics?.unresolvedClientCalls ?? []) {
      d.node = map(d.node);
      d.project = project;
    }
  for (const m of a.machines) {
    m.id = map(m.id);
    m.usedBy = m.usedBy.map(map);
    m.invokes = m.invokes.map(map);
    for (const k of Object.keys(m.implementationNodes)) m.implementationNodes[k] = map(m.implementationNodes[k]);
  }
  for (const f of a.files) f.project = project;
  for (const op of a.openapi.operations) {
    op.callers = op.callers?.map(map);
    op.handlers = op.handlers?.map(map);
  }
  a.warnings = a.warnings.map((w) => `[${project}] ${w}`);
  return a;
}

function mergeAnalyses(parts: Analysis[], root: string, openapi: OpenApiIndex): Analysis {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const out: Analysis = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root: normalize(root),
    projects: [],
    seams: [],
    projectEdges: [],
    packages: [],
    files: [],
    nodes: [],
    edges: [],
    externalCalls: [],
    machines: [],
    openapi: { specs: openapi.specs, operations: openapi.operations },
    stats: { files: 0, functions: 0, components: 0, hooks: 0, edges: 0, machines: 0, externalCalls: 0, unresolvedCalls: 0, durationMs: 0 },
    warnings: [],
  };
  for (const a of parts) {
    for (const n of a.nodes) {
      const existing = nodes.get(n.id);
      if (existing) {
        if (existing.external && n.external) existing.external.calls += n.external.calls;
        continue;
      }
      nodes.set(n.id, n);
    }
    for (const e of a.edges) {
      const key = `${e.from}|${e.to}|${e.kind}`;
      const ex = edges.get(key);
      if (ex) ex.count += e.count;
      else edges.set(key, e);
    }
    out.projects.push(...a.projects);
    out.packages.push(...a.packages.map((p) => ({ ...p, name: a.projects[0] && parts.length > 1 ? `${a.projects[0].name}/${p.name}` : p.name })));
    out.files.push(...a.files);
    out.externalCalls.push(...a.externalCalls);
    out.machines.push(...a.machines);
    out.warnings.push(...a.warnings);
    if (a.diagnostics?.unresolvedClientCalls.length) {
      out.diagnostics ??= { unresolvedClientCalls: [] };
      out.diagnostics.unresolvedClientCalls.push(...a.diagnostics.unresolvedClientCalls);
    }
    for (const k of Object.keys(out.stats) as (keyof Analysis['stats'])[]) out.stats[k] += a.stats[k];
  }
  out.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  out.edges = [...edges.values()];
  return out;
}

/* ---------- cross-project linking ---------- */

const HTTP_ENTRIES = new Set(['next:route', 'next:api', 'openapi:operation', 'spring:endpoint']);
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function routeRegExp(route: string): RegExp {
  return new RegExp(
    '^' +
      route
        .split('/')
        .map((s) => (/^\[\.\.\..*\]$/.test(s) || /^\[\[\.\.\..*\]\]$/.test(s) || s === '**' ? '.*' : /^(\[.*\]|\{.*\}|:\w+|\*)$/.test(s) ? '[^/]+' : s.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('/') +
      '/?$',
  );
}

interface HandlerRoute {
  node: GraphNode;
  re: RegExp;
  methods: string[];
}

function splitUrl(target: string): { host?: string; path: string } {
  let t = target.replace(/^\{[^}]*\}/, ''); // `${BASE}/x` -> `/x`
  const m = t.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/i);
  if (m) return { host: m[1].toLowerCase(), path: (m[2] ?? '/').replace(/[?#].*$/, '') };
  if (t.startsWith('//')) {
    const mm = t.match(/^\/\/([^/]+)(\/.*)?$/);
    if (mm) return { host: mm[1].toLowerCase(), path: (mm[2] ?? '/').replace(/[?#].*$/, '') };
  }
  return { path: t.replace(/[?#].*$/, '') };
}

/**
 * Link external nodes to the handlers that serve them, across all projects:
 * HTTP by operationId, then by host -> project and route template; messaging by topic/queue.
 */
export function linkSeams(a: Analysis) {
  const nodeById = new Map(a.nodes.map((n) => [n.id, n]));
  const projectByName = new Map(a.projects.map((p) => [p.name, p]));
  const edgeKeys = new Set(a.edges.map((e) => `${e.from}|${e.to}|${e.kind}`));
  const addEdge = (from: string, to: string, kind: GraphEdge['kind'], label?: string) => {
    const key = `${from}|${to}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    a.edges.push({ from, to, kind, count: 1, label });
  };

  // host -> project
  const hostToProject = new Map<string, string>();
  for (const p of a.projects) {
    for (const h of p.hosts) {
      const clean = h.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '').toLowerCase();
      hostToProject.set(clean, p.name);
      hostToProject.set(clean.split('/')[0], p.name);
    }
  }

  // handlers
  const handlers: HandlerRoute[] = [];
  const byOperation = new Map<string, GraphNode[]>();
  for (const n of a.nodes) {
    if (!n.entry || !HTTP_ENTRIES.has(n.entry)) continue;
    if (n.operationId) (byOperation.get(n.operationId) ?? byOperation.set(n.operationId, []).get(n.operationId)!).push(n);
    if (!n.route) continue;
    const routes = [n.route, ...(n.tags ?? []).filter((t) => t.startsWith('route:')).map((t) => t.slice(6))];
    const prefixes = new Set<string>(['']);
    for (const t of n.tags ?? []) {
      if (!t.startsWith('server:')) continue;
      const prefix = t.slice(7).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/$/, '');
      if (prefix) prefixes.add(prefix);
    }
    for (const r of routes) for (const pre of prefixes) handlers.push({ node: n, re: routeRegExp(pre + r), methods: n.httpMethods ?? ALL_METHODS });
  }

  // listeners
  const listeners = a.nodes.filter((n) => n.entry === 'spring:listener' && n.topics?.length);

  for (const ext of a.nodes) {
    if (ext.kind !== 'external' || !ext.external) continue;
    const x = ext.external;
    if (x.category === 'http') {
      const method = (x.method ?? 'GET').toUpperCase();
      let targets: GraphNode[] = [];
      if (ext.operationId) targets = byOperation.get(ext.operationId) ?? [];
      const { host, path: p } = x.target ? splitUrl(x.target) : { host: undefined, path: '' };
      let hostProject = host ? hostToProject.get(host) ?? hostToProject.get(host.split(':')[0]) : undefined;
      if (!hostProject && ext.operationId) {
        // operation nodes lose the URL host; use the spec's declared servers (+ the spec-owning project) instead
        const ops = a.openapi.operations.filter((o) => o.operationId === ext.operationId);
        const projects = new Set<string>();
        for (const o of ops) {
          for (const sv of o.servers) {
            const h = sv.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '').toLowerCase();
            const pj = hostToProject.get(h) ?? hostToProject.get(h.split('/')[0]);
            if (pj) projects.add(pj);
          }
        }
        if (projects.size === 1) hostProject = [...projects][0];
      }
      // the caller's own project also owns the path when the URL is relative (same-origin fetch)
      const callerProjects = new Set(a.edges.filter((e) => e.kind === 'external' && e.to === ext.id).map((e) => nodeById.get(e.from)?.project).filter(Boolean) as string[]);
      let how = 'operation';
      if (!targets.length && p.startsWith('/')) {
        const probe = p.replace(/\{[^}]*\}/g, '__param__');
        const matching = (loose: boolean) =>
          handlers.filter((h) => {
            if (!h.methods.includes(method)) return false;
            const src = h.re.source.replace(/\[\^\/\]\+/g, '(?:[^/]+|__param__)');
            // loose: the caller URL may carry an extra prefix (ingress path, servlet path, unknown context path)
            const re = new RegExp(loose ? src.replace(/^\^/, '^(?:/[^/]+){1,3}') : src);
            return re.test(probe);
          });
        let candidates = matching(false);
        if (!candidates.length) {
          candidates = matching(true).filter((h) => (h.node.route ?? '').split('/').filter(Boolean).length >= 2);
          if (candidates.length) how = 'route-suffix';
          else how = 'route';
        } else how = 'route';
        let scoped = candidates;
        if (hostProject) scoped = candidates.filter((h) => h.node.project === hostProject);
        else if (!host && callerProjects.size) {
          // relative URL: prefer the caller's project, fall back to any
          const same = candidates.filter((h) => callerProjects.has(h.node.project ?? ''));
          scoped = same.length ? same : candidates;
        } else if (host && !hostProject) {
          // unknown host (k8s DNS name, gateway, ...): the path decides; other projects' handlers are still legitimate targets
          scoped = candidates.filter((h) => !callerProjects.has(h.node.project ?? '')).length ? candidates.filter((h) => !callerProjects.has(h.node.project ?? '')) : candidates;
          how += ' (host ' + host + ' not mapped to a project)';
        }
        targets = [...new Set(scoped.map((h) => h.node))];
      } else if (targets.length && hostProject) {
        const scoped = targets.filter((t) => t.project === hostProject);
        if (scoped.length) targets = scoped;
      }
      const ambiguous = targets.length > 1 && new Set(targets.map((t) => t.project)).size > 1 && !hostProject;
      for (const t of targets) addEdge(ext.id, t.id, 'http-route', ambiguous ? 'ambiguous' : `${method} ${p || x.target} [${how}]`);
    } else if (x.category === 'messaging') {
      const topic = x.target;
      if (!topic || topic.startsWith('{')) continue;
      for (const l of listeners) {
        if (!listenerMatches(l, x.protocol, topic)) continue;
        addEdge(ext.id, l.id, 'message-route', topic);
      }
    }
  }
  void projectByName;
}

function listenerMatches(listener: GraphNode, protocol: string, topic: string): boolean {
  const topics = listener.topics ?? [];
  const system = (listener.tags ?? []).find((t) => /^(kafka|rabbit|jms|sqs|pubsub)$/.test(t));
  if (system && protocol !== system && !(protocol === 'spring-cloud-stream')) return false;
  for (const t of topics) {
    if (t === topic) return true;
    if (protocol === 'rabbit') {
      // sender: exchange/routingKey ; listener: queue name or exchange/bindingKey (with * / # wildcards)
      const [ex, key] = topic.includes('/') ? [topic.slice(0, topic.indexOf('/')), topic.slice(topic.indexOf('/') + 1)] : ['', topic];
      if (!t.includes('/')) {
        if (t === key) return true;
        continue;
      }
      const [lex, lkey] = [t.slice(0, t.indexOf('/')), t.slice(t.indexOf('/') + 1)];
      if (lex !== ex) continue;
      const re = new RegExp('^' + lkey.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\\\*|\*/g, '[^.]+').replace(/#/g, '.*') + '$');
      if (re.test(key)) return true;
    } else if (t.endsWith('*') && topic.startsWith(t.slice(0, -1))) return true;
    else if (/^\^|\.\*/.test(t)) {
      try {
        if (new RegExp(t).test(topic)) return true;
      } catch {
        /* not a regex */
      }
    }
  }
  return false;
}

/* ---------- seams ---------- */

function seamKindOf(ext: GraphNode): SeamKind | undefined {
  const x = ext.external;
  if (!x) return undefined;
  if (x.category === 'http') return 'http';
  if (x.category === 'grpc') return 'grpc';
  if (x.category === 'messaging') {
    if (/kafka|spring-cloud-stream/.test(x.protocol)) return 'kafka';
    if (/rabbit|amqp/.test(x.protocol)) return 'rabbit';
    if (/jms/.test(x.protocol)) return 'jms';
    if (/sqs|sns/.test(x.protocol)) return 'sqs';
  }
  return undefined;
}

export function computeSeams(a: Analysis) {
  const nodeById = new Map(a.nodes.map((n) => [n.id, n]));
  const party = (id: string, line?: number): SeamParty => ({ project: nodeById.get(id)?.project, node: id, line });
  const inbound = new Map<string, GraphEdge[]>();
  const outbound = new Map<string, GraphEdge[]>();
  for (const e of a.edges) {
    (inbound.get(e.to) ?? inbound.set(e.to, []).get(e.to)!).push(e);
    (outbound.get(e.from) ?? outbound.set(e.from, []).get(e.from)!).push(e);
  }
  const seams: Seam[] = [];
  const handled = new Set<string>();
  for (const ext of a.nodes) {
    if (ext.kind !== 'external') continue;
    const kind = seamKindOf(ext);
    if (!kind) continue;
    const callers = (inbound.get(ext.id) ?? []).filter((e) => e.kind === 'external').map((e) => party(e.from, e.line));
    const routes = (outbound.get(ext.id) ?? []).filter((e) => e.kind === 'http-route' || e.kind === 'message-route');
    const handlers = routes.map((e) => party(e.to));
    for (const h of handlers) handled.add(h.node);
    const op = ext.operationId ? a.openapi.operations.find((o) => o.operationId === ext.operationId) : undefined;
    seams.push({
      id: `seam:${ext.id}`,
      kind,
      label: ext.name,
      method: ext.external?.method,
      target: ext.external?.target,
      operationId: ext.operationId,
      spec: op?.spec,
      node: ext.id,
      callers,
      handlers,
      status: handlers.length ? (routes.some((e) => e.label === 'ambiguous') ? 'ambiguous' : 'linked') : 'no-handler',
    });
  }
  // server actions
  for (const e of a.edges) {
    if (e.kind !== 'server-action') continue;
    const to = nodeById.get(e.to);
    seams.push({ id: `seam:server-action:${e.from}->${e.to}`, kind: 'server-action', label: `server action ${to?.name ?? e.to}`, method: 'POST', target: to?.name, callers: [party(e.from, e.line)], handlers: [party(e.to)], status: 'linked' });
    handled.add(e.to);
  }
  // endpoints / listeners nobody calls
  for (const n of a.nodes) {
    if (!n.entry || handled.has(n.id)) continue;
    if (HTTP_ENTRIES.has(n.entry) && n.route) {
      const method = n.httpMethods && n.httpMethods.length < 7 ? n.httpMethods.join('|') : 'ANY';
      seams.push({ id: `seam:handler:${n.id}`, kind: 'http', label: `${method} ${n.route}`, method, target: n.route, operationId: n.operationId, callers: [], handlers: [party(n.id)], status: 'no-caller' });
    } else if (n.entry === 'spring:listener' && n.topics?.length) {
      const system = ((n.tags ?? []).find((t) => /^(kafka|rabbit|jms|sqs)$/.test(t)) ?? 'kafka') as SeamKind;
      seams.push({ id: `seam:handler:${n.id}`, kind: system, label: `${system} ${n.topics.join(', ')}`, target: n.topics[0], callers: [], handlers: [party(n.id)], status: 'no-caller' });
    }
  }
  a.seams = seams.sort((x, y) => x.kind.localeCompare(y.kind) || x.label.localeCompare(y.label));

  // project-level aggregation
  const agg = new Map<string, ProjectEdge>();
  const bump = (from: string, to: string, kind: SeamKind, seam: string) => {
    const key = `${from}|${to}|${kind}`;
    const e = agg.get(key) ?? { from, to, kind, seams: [], count: 0 };
    if (!e.seams.includes(seam)) e.seams.push(seam);
    e.count++;
    agg.set(key, e);
  };
  for (const s of seams) {
    const callerProjects = [...new Set(s.callers.map((c) => c.project ?? '(unknown)'))];
    const handlerProjects = [...new Set(s.handlers.map((h) => h.project ?? '(unknown)'))];
    if (!callerProjects.length) continue; // unused endpoint: not an edge
    for (const cp of callerProjects) {
      if (!handlerProjects.length) bump(cp, '(unhandled)', s.kind, s.id);
      for (const hp of handlerProjects) bump(cp, hp, s.kind, s.id);
    }
  }
  a.projectEdges = [...agg.values()].sort((x, y) => y.count - x.count);
}

/* ---------- entry point ---------- */

export interface WorkspaceOptions extends Omit<AnalyzerOptions, 'root'> {
  onProgress?: (msg: string) => void;
}

export function analyzeWorkspace(cfg: WorkspaceConfig, base: WorkspaceOptions = {}): Analysis {
  const t0 = Date.now();
  const log = base.onProgress ?? (() => {});
  const warnings: string[] = [];
  // shared OpenAPI index: every project's specs (tagged with the owning project) + workspace-level documents
  const openapi = new OpenApiIndex();
  const addIndex = (idx: OpenApiIndex, project?: string) => {
    for (const op of idx.operations) openapi.add({ ...op, project } as OpenApiOperation);
    for (const s of idx.specs) openapi.specs.push({ ...s, project } as typeof s & { project?: string });
  };
  for (const p of cfg.projects) {
    const excl = (p.exclude ?? base.exclude ?? []).map((g) => new RegExp(g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')));
    addIndex(loadOpenApi(p.root, p.openapi, excl, warnings), p.name);
  }
  for (const extra of cfg.openapi ?? []) {
    const files = fs.existsSync(extra) && fs.statSync(extra).isDirectory() ? findSpecFiles(extra) : [extra];
    addIndex(loadOpenApi(path.dirname(extra), files, [], warnings));
  }
  if (openapi.size) log(`indexed ${openapi.size} OpenAPI operations from ${openapi.specs.length} spec(s)`);

  const parts: Analysis[] = [];
  for (const p of cfg.projects) {
    const lang = p.type && p.type !== 'auto' ? p.type : detectLanguage(p.root);
    const opts: AnalyzerOptions = {
      ...base,
      root: p.root,
      project: p.name,
      hosts: p.hosts,
      tsconfig: p.tsconfig ?? base.tsconfig,
      include: p.include ?? base.include,
      exclude: p.exclude ?? base.exclude,
      includeTests: p.includeTests ?? base.includeTests,
      openapiHandlers: p.openapiHandlers ?? base.openapiHandlers,
      ignorePackages: p.ignorePackages ?? base.ignorePackages,
      profiles: p.profiles ?? base.profiles,
      properties: { ...(base.properties ?? {}), ...(p.properties ?? {}) },
      openapi: [],
      onProgress: (m) => log(`[${p.name}] ${m}`),
    };
    log(`project ${p.name} (${lang}) at ${p.root}`);
    const runs: Analysis[] = [];
    if (lang === 'java' || lang === 'mixed') runs.push(analyzeJava(opts, { openapi }));
    if (lang === 'ts' || lang === 'mixed') runs.push(analyze(opts, { openapi }));
    for (const r of runs) parts.push(prefixAnalysis(r, p.name));
    if (runs.length === 2) {
      // one project, two analyzers: merge the project records
      const [j, t] = runs;
      j.projects[0].language = 'mixed';
      j.projects[0].files += t.projects[0].files;
      t.projects = [];
    }
  }
  const merged = mergeAnalyses(parts, path.resolve(cfg.projects[0].root, '..'), openapi);
  merged.warnings.unshift(...warnings);
  linkSeams(merged);
  computeSeams(merged);
  for (const op of merged.openapi.operations) {
    op.callers = [...new Set(merged.externalCalls.filter((c) => c.operationId === op.operationId).map((c) => c.caller))];
    op.handlers = merged.nodes.filter((n) => n.operationId === op.operationId && n.entry).map((n) => n.id);
  }
  merged.stats.durationMs = Date.now() - t0;
  return merged;
}

/* ---------- diagnostics ---------- */

/** Human-readable explanation of why calls are unlinked, with the nearest handler routes and hints. */
export function explainSeams(a: Analysis): string {
  const nodeById = new Map(a.nodes.map((n) => [n.id, n]));
  const name = (id: string) => nodeById.get(id)?.name ?? id;
  const tag = (p?: string) => (a.projects.length > 1 && p ? `${p}:` : '');
  const out: string[] = [];
  const hostToProject = new Map<string, string>();
  for (const p of a.projects) {
    for (const h of p.hosts) {
      const clean = h.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '').toLowerCase();
      hostToProject.set(clean, p.name);
      hostToProject.set(clean.split('/')[0], p.name);
    }
  }
  const handlers = a.nodes.filter((n) => n.entry && HTTP_ENTRIES.has(n.entry) && n.route);
  const isParam = (x: string) => /^[\[{:].*/.test(x) || x === '*';
  /** handlers whose trailing route segments match the path's trailing segments (literals must agree; at least one literal in common) */
  const similar = (method: string, p: string) => {
    const segs = p.split('/').filter(Boolean);
    return handlers
      .map((h) => {
        const hs = (h.route ?? '').split('/').filter(Boolean);
        let score = 0;
        let literal = 0;
        for (let i = 1; i <= Math.min(segs.length, hs.length); i++) {
          const x = segs[segs.length - i], y = hs[hs.length - i];
          if (isParam(x) && isParam(y)) score++;
          else if (isParam(y) && !isParam(x)) score++; // handler param accepts a concrete caller segment
          else if (x === y) { score++; literal++; }
          else break;
        }
        return { h, score: literal ? score : 0, methodOk: (h.httpMethods ?? ALL_METHODS).includes(method) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || Number(y.methodOk) - Number(x.methodOk))
      .slice(0, 3);
  };

  out.push(`# Projects`);
  for (const p of a.projects) out.push(`- ${p.name} (${p.language})${p.serviceName ? ` service=${p.serviceName}` : ''}${p.contextPath ? ` context-path=${p.contextPath}` : ''}${p.port ? ` port=${p.port}` : ''} hosts=[${p.hosts.join(', ')}] ${p.propertyFiles?.length ? `properties=${p.propertyFiles.join(',')}` : '(no application.yml/properties found)'}`);
  const specs = a.openapi.specs;
  out.push('', `# OpenAPI documents indexed: ${specs.length}`);
  for (const s of specs) out.push(`- ${(s as { project?: string }).project ? (s as { project?: string }).project + ':' : ''}${s.file} (${s.operations} operations${s.title ? `, ${s.title}` : ''})`);

  const unlinked = a.seams.filter((s) => s.status === 'no-handler' && s.kind === 'http');
  out.push('', `# Unlinked HTTP calls: ${unlinked.length}`);
  for (const s of unlinked) {
    const { host, path: p } = s.target ? splitUrl(s.target) : { host: undefined, path: '' };
    const hp = host ? hostToProject.get(host) ?? hostToProject.get(host.split(':')[0]) : undefined;
    out.push('', `## ${s.label}`);
    out.push(`  callers: ${s.callers.map((c) => tag(c.project) + name(c.node) + (c.line ? ':' + c.line : '')).join(', ')}`);
    out.push(`  target:  ${s.target ?? '(dynamic - could not evaluate the URL expression)'}`);
    const unresolvedProps = [...(s.target ?? '').matchAll(/\{([A-Za-z0-9_.-]*[.:][A-Za-z0-9_.-]*|[A-Z][A-Z0-9_]+)\}/g)].map((m) => m[1]);
    if (unresolvedProps.length) out.push(`  note:    unresolved configuration in the URL: ${unresolvedProps.join(', ')} (define it in application.yml, --profile <name>, or "properties" in xsa.workspace.json)`);
    if (host) out.push(`  host:    ${host} -> ${hp ? `project ${hp}` : 'not mapped to any project (add it to that project\'s "hosts" in xsa.workspace.json)'}`);
    if (s.operationId) out.push(`  operationId ${s.operationId}: no handler with this operationId (controller method names differ from the spec?) and no route match`);
    const near = p ? similar((s.method ?? 'GET').toUpperCase(), p) : [];
    if (near.length) {
      out.push(`  nearest handler routes:`);
      for (const { h, score, methodOk } of near) out.push(`    ${(h.httpMethods ?? ['ANY']).join('/')} ${h.route}  -> ${tag(h.project)}${h.name}  (${score} trailing segment${score === 1 ? '' : 's'} match${methodOk ? '' : ', different HTTP method'})`);
      const best = near[0].h;
      if (!hp && host) out.push(`  hint:    if ${best.route} is the intended endpoint, add "${host}" to hosts of project ${best.project} (route prefixes may differ by context-path / gateway path)`);
      else if (p !== best.route) out.push(`  hint:    path differs from ${best.route}: check server.servlet.context-path / gateway prefix in the caller URL`);
    } else if (p) out.push(`  no handler route shares a trailing segment with ${p}; is the target service part of the workspace and are its controllers @RestController/@RequestMapping (or a committed spec with matching operationIds)?`);
  }

  const diag = a.diagnostics?.unresolvedClientCalls ?? [];
  if (diag.length) {
    out.push('', `# Calls on client-like receivers the analyzer did not understand: ${diag.length}`);
    const byType = new Map<string, UnresolvedClientCall[]>();
    for (const d of diag) (byType.get(d.receiverType ?? d.receiver) ?? byType.set(d.receiverType ?? d.receiver, []).get(d.receiverType ?? d.receiver)!).push(d);
    for (const [k, list] of [...byType.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 25)) {
      out.push(`- ${k}: ${list.length} call(s), e.g. ${tag(list[0].project)}${name(list[0].node)}:${list[0].line} ${list[0].receiver}.${list[0].method}() — ${list[0].reason}`);
    }
    out.push(`  hint: generated clients are recognised when a spec with matching operationIds is indexed; hand-written wrappers around RestTemplate/WebClient are followed only when the URL is built inside the called method.`);
  }
  return out.join('\n');
}

/** Single-root convenience: detect language, run, link, compute seams. */
export function analyzeRoot(opts: AnalyzerOptions): Analysis {
  const lang = opts.language ?? detectLanguage(opts.root);
  if (lang === 'mixed') {
    const name = opts.project ?? path.basename(path.resolve(opts.root));
    return analyzeWorkspace({ projects: [{ name, root: path.resolve(opts.root), type: 'auto', hosts: opts.hosts }] }, opts);
  }
  const a = lang === 'java' ? analyzeJava(opts) : analyze(opts);
  linkSeams(a);
  computeSeams(a);
  return a;
}

export type { ProjectInfo };
