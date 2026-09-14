import * as fs from 'node:fs';
import * as path from 'node:path';
import { EdgeSet, analyzeCalls, type CallContext } from './analyzers/calls.js';
import { detectExternalCalls } from './analyzers/external.js';
import { NodeRegistry } from './analyzers/functions.js';
import { analyzeNextFile, linkNextBoundaries } from './analyzers/next.js';
import { findMachineUsages, findMachines, linkMachines, type MachineUsage } from './analyzers/xstate.js';
import type { Analysis, AnalyzerOptions, ExternalRule, FileInfo, MachineModel, ProjectInfo } from './model.js';
import { loadOpenApi, type OpenApiIndex } from './openapi.js';
import { loadWorkspace, normalize } from './project.js';
import { DEFAULT_RULES } from './rules.js';
import type { GraphNode } from './model.js';

export const VERSION = '0.1.0';

export function loadRules(opts: AnalyzerOptions): ExternalRule[] {
  const extra = opts.rules ?? [];
  return opts.replaceRules ? extra : [...extra, ...DEFAULT_RULES];
}

/** Read a rules JSON file: either an array of rules or `{ "rules": [...], "replace": bool }`. */
export function readRulesFile(file: string): { rules: ExternalRule[]; replace: boolean } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return { rules: raw, replace: false };
  return { rules: raw.rules ?? [], replace: !!raw.replace };
}

export function analyze(opts: AnalyzerOptions, shared?: { openapi?: OpenApiIndex }): Analysis {
  const t0 = Date.now();
  const log = opts.onProgress ?? (() => {});
  const ws = loadWorkspace(opts);
  const project = opts.project ?? ws.rootPackageName;
  const registry = new NodeRegistry(ws.root, ws.fileOwner, ws.rootPackageName);
  const edges = new EdgeSet();
  const warnings: string[] = [];
  const ctx: CallContext = {
    registry,
    edges,
    includeBuiltins: !!opts.includeBuiltins,
    ignorePackages: opts.ignorePackages ?? [],
    unresolved: 0,
  };
  const rules = loadRules(opts);
  const counter = { n: 0 };
  const openapi = shared?.openapi ?? loadOpenApi(ws.root, opts.openapi, (opts.exclude ?? []).map(globToRegExpLoose), warnings);
  if (openapi.size) log(`indexed ${openapi.size} OpenAPI operations from ${openapi.specs.map((s) => s.file).join(', ')}`);
  const files: FileInfo[] = [];
  const machines: MachineModel[] = [];
  const usages: MachineUsage[] = [];
  const externalCalls: Analysis['externalCalls'] = [];

  let done = 0;
  const total = ws.packages.reduce((s, p) => s + p.files, 0);
  for (const pkg of ws.packages) {
    for (const sf of pkg.project.getSourceFiles()) {
      const abs = normalize(sf.getFilePath());
      if (ws.fileOwner.get(abs) !== pkg.name) continue; // dependency file loaded by resolution; owned elsewhere or external
      try {
        const fns = registry.collectFunctions(sf);
        const sites = analyzeCalls(sf, ctx);
        files.push(analyzeNextFile(sf, fns, registry));
        machines.push(...findMachines(sites, { registry, edges, warnings }));
        usages.push(...findMachineUsages(sites, registry));
        externalCalls.push(...detectExternalCalls(sites, rules, counter, { registry, edges, openapi }));
      } catch (e) {
        warnings.push(`failed to analyze ${registry.relPath(sf)}: ${(e as Error).message}`);
      }
      done++;
      if (done % 50 === 0 || done === total) log(`analyzed ${done}/${total} files`);
    }
  }

  linkMachines(machines, usages, edges);
  remapDeclarationFiles(registry, edges, warnings);
  tagOpenApiHandlers(registry, openapi, opts.openapiHandlers);
  linkNextBoundaries(registry.nodes, edges, externalCalls, counter, !shared);
  for (const op of openapi.operations) {
    op.callers = [...new Set(externalCalls.filter((c) => c.operationId === op.operationId).map((c) => c.caller))];
    op.handlers = [...registry.nodes.values()].filter((n) => n.entry === 'openapi:operation' && n.operationId === op.operationId && n.route === op.path).map((n) => n.id);
  }

  // Drop edges pointing at nodes we never registered (should not happen, but keep the graph consistent)
  let edgeList = [...edges.edges.values()].filter((e) => registry.nodes.has(e.from) && registry.nodes.has(e.to));

  // Prune inline callbacks (`input: () => ...`, `assign({ x: () => ... })`) that call nothing: pure data mappers
  const hasOutgoing = new Set(edgeList.map((e) => e.from));
  const hasExternal = new Set(externalCalls.map((c) => c.caller));
  const pruned = new Set<string>();
  for (const n of registry.nodes.values()) {
    if (n.tags?.includes('inline') && !hasOutgoing.has(n.id) && !hasExternal.has(n.id)) {
      const incoming = edgeList.filter((e) => e.to === n.id);
      if (incoming.every((e) => e.kind === 'implements')) pruned.add(n.id);
    }
  }
  for (const id of pruned) registry.nodes.delete(id);
  edgeList = edgeList.filter((e) => !pruned.has(e.from) && !pruned.has(e.to));
  for (const m of machines) {
    for (const [k, v] of Object.entries(m.implementationNodes)) if (pruned.has(v)) delete m.implementationNodes[k];
  }
  // Prune leaf package/builtin nodes with no edges
  const referenced = new Set<string>();
  for (const e of edgeList) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  for (const c of externalCalls) referenced.add(c.caller);
  const nodes = [...registry.nodes.values()].filter((n) => n.internal || referenced.has(n.id));
  // Module nodes only matter when something happens at module scope
  const finalNodes = nodes.filter((n) => n.kind !== 'module' || referenced.has(n.id));

  const stats = {
    files: files.length,
    functions: finalNodes.filter((n) => n.kind === 'function' || n.kind === 'method').length,
    components: finalNodes.filter((n) => n.kind === 'component').length,
    hooks: finalNodes.filter((n) => n.kind === 'hook').length,
    edges: edgeList.length,
    machines: machines.length,
    externalCalls: externalCalls.length,
    unresolvedCalls: ctx.unresolved,
    durationMs: Date.now() - t0,
  };

  for (const n of finalNodes) if (n.internal) n.project = project;
  for (const c of externalCalls) c.project = project;
  for (const f of files) {
    f.project = project;
    f.language = 'ts';
  }
  const info: ProjectInfo = { name: project, root: normalize(ws.root), language: 'ts', serviceName: ws.rootPackageName, hosts: opts.hosts ?? [], files: files.length, warnings: warnings.length };
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root: normalize(ws.root),
    projects: [info],
    seams: [],
    projectEdges: [],
    packages: ws.packages.map((p) => ({ name: p.name, dir: p.dir, files: p.files })),
    files,
    nodes: finalNodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edgeList.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    externalCalls,
    machines,
    openapi: { specs: openapi.specs, operations: openapi.operations },
    stats,
    warnings,
  };
}

function globToRegExpLoose(glob: string): RegExp {
  return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
}

const SERVERISH_PATH = /(^|\/)(server|api|apis|controllers?|handlers?|routes?|routers?|backend|services?|resolvers?|endpoints?)(\/|\.)/i;
const SERVERISH_PARAMS = new Set(['req', 'request', 'res', 'response', 'reply', 'ctx', 'context', 'event', 'h']);

/**
 * Server handlers generated-and-implemented from an OpenAPI spec are plain
 * functions named after the operationId (`export async function getUserById(req, res)`).
 * Tag them as entry points so client calls to the operation link to them.
 */
function tagOpenApiHandlers(registry: NodeRegistry, openapi: OpenApiIndex, handlerGlobs?: string[]) {
  if (!openapi.size) return;
  const globs = (handlerGlobs ?? []).map(globToRegExpLoose);
  for (const n of registry.nodes.values()) {
    if (!n.internal || n.entry || (n.kind !== 'function' && n.kind !== 'method')) continue;
    const last = n.name.split('.').pop() ?? n.name;
    const ops = openapi.lookup(last).filter((o) => o.explicitId);
    if (!ops.length) continue;
    const params = n.params ?? [];
    const serverSignature = params.some((p) => SERVERISH_PARAMS.has(p) || /(params|body|query|request|headers|pathParams)/.test(p));
    const viaGlob = globs.some((g) => g.test(n.file));
    // heuristic: a server-style signature anywhere, or a server-ish file where the signature does not contradict it
    const viaHeuristic = !globs.length && (n.exported || n.kind === 'method') && (serverSignature || (SERVERISH_PATH.test(n.file) && params.length === 0));
    if (!viaGlob && !viaHeuristic) continue;
    const op = ops[0];
    n.entry = 'openapi:operation';
    n.operationId = op.operationId;
    n.route = op.path;
    n.httpMethods = [op.method];
    n.tags = [...(n.tags ?? []), ...op.servers.map((s) => `server:${s}`)];
  }
}

export type { GraphNode };

/**
 * Workspace packages whose `main`/`exports` point at built output resolve to
 * `dist/*.d.ts` declarations. Redirect those nodes to the exported source
 * function of the same name in the same package, when we analyzed one.
 */
function remapDeclarationFiles(registry: NodeRegistry, edges: EdgeSet, warnings: string[]) {
  const dts = [...registry.nodes.values()].filter((n) => n.internal && /\.d\.(ts|mts|cts)$/.test(n.file));
  if (!dts.length) return;
  const sourceIndex = new Map<string, string>(); // package|name -> node id
  const candidates = [...registry.nodes.values()].filter((n) => n.internal && n.package && !/\.d\.(ts|mts|cts)$/.test(n.file) && n.kind !== 'module');
  for (const n of candidates.sort((x, y) => Number(!!y.exported) - Number(!!x.exported))) {
    const key = `${n.package}|${n.name}`;
    if (!sourceIndex.has(key)) sourceIndex.set(key, n.id);
  }
  const redirect = new Map<string, string>();
  for (const n of dts) {
    const target = n.package ? sourceIndex.get(`${n.package}|${n.name}`) : undefined;
    if (target) redirect.set(n.id, target);
    else if (!n.package) warnings.push(`declaration-only node kept: ${n.id}`);
  }
  if (!redirect.size) return;
  const old = [...edges.edges.values()];
  edges.edges.clear();
  for (const e of old) {
    const from = redirect.get(e.from) ?? e.from;
    const to = redirect.get(e.to) ?? e.to;
    for (let i = 0; i < e.count; i++) edges.add(from, to, e.kind, e.line, e.label);
  }
  for (const id of redirect.keys()) registry.nodes.delete(id);
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFile(file: string, content: string) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}
