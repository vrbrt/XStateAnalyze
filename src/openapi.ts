import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { OpenApiOperation, OpenApiSpecInfo } from './model.js';
import { normalize, toRel } from './project.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', '.cache', '.yarn', '.pnpm']);

/**
 * Index of OpenAPI operations found in the workspace. Lets the analyzer
 * understand clients/servers generated from a spec even when the generated
 * code is absent: a call `usersApi.getUserById()` or a handler named
 * `getUserById` is matched to `GET /users/{id}` by operationId.
 */
export class OpenApiIndex {
  readonly operations: OpenApiOperation[] = [];
  readonly specs: OpenApiSpecInfo[] = [];
  private byName = new Map<string, OpenApiOperation[]>();

  add(op: OpenApiOperation) {
    this.operations.push(op);
    for (const key of nameKeys(op.operationId)) {
      const list = this.byName.get(key) ?? [];
      list.push(op);
      this.byName.set(key, list);
    }
  }

  /** Operations whose operationId matches a method/function name (case-insensitive, camelCase / snake / Controller_op variants). */
  lookup(name: string | undefined): OpenApiOperation[] {
    if (!name) return [];
    const n = norm(name);
    if (!n) return [];
    const direct = this.byName.get(n);
    if (direct?.length) return direct;
    // generated-client variants: fooWithHttpInfo, fooAsync, fooCall, fooWithResponseSpec, fooUsingPOST, fooRequestCreation
    const stripped = name.replace(/(WithHttpInfo|WithResponseSpec|RequestCreation|Async|Call|Using(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\d*|_\d+)$/, '');
    if (stripped !== name) return this.lookup(stripped);
    return [];
  }

  /**
   * Match an HTTP method + URL/path (possibly with `{expr}` placeholders from template
   * literals) against operation path templates, honouring `servers` base paths.
   */
  match(method: string | undefined, url: string | undefined): OpenApiOperation | undefined {
    if (!method || !url) return undefined;
    const m = method.toUpperCase();
    let p = url.replace(/^\{[^}]*\}/, '').replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
    if (!p.startsWith('/')) return undefined;
    const host = url.match(/^[a-z]+:\/\/([^/]+)/i)?.[1]?.toLowerCase();
    for (const op of this.operations) {
      if (op.method !== m) continue;
      // candidate paths for this operation: the raw path, and the path with this spec's own server base stripped
      const candidates = new Set<string>([p]);
      let hostMatches = !host;
      for (const s of op.servers) {
        const sh = s.match(/^[a-z]+:\/\/([^/]+)/i)?.[1]?.toLowerCase();
        if (host && sh === host) hostMatches = true;
        const base = s.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/$/, '');
        if (base && p.startsWith(base + '/')) candidates.add(p.slice(base.length));
      }
      if (!hostMatches && op.servers.some((s) => /^[a-z]+:\/\//i.test(s))) {
        // absolute URL to a host this spec does not declare: only accept when the host is not any other spec's host either
        const knownHosts = new Set(this.operations.flatMap((o) => o.servers).map((s) => s.match(/^[a-z]+:\/\/([^/]+)/i)?.[1]?.toLowerCase()).filter(Boolean));
        if (knownHosts.has(host!)) continue;
      }
      const tmpl = op.path.split('/').filter(Boolean);
      for (const c of candidates) {
        const segs = c.split('/').filter(Boolean);
        if (segs.length !== tmpl.length) continue;
        if (tmpl.every((t, i) => /^\{.*\}$/.test(t) || /^\{.*\}$/.test(segs[i]) || t === segs[i])) return op;
      }
    }
    return undefined;
  }

  get size() {
    return this.operations.length;
  }
}

function norm(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** Keys an operationId is reachable by: full id, and the part after the last `_`/`.`/`-` (NestJS `UsersController_getUser`, `users.get`). */
function nameKeys(operationId: string): string[] {
  const keys = new Set<string>([norm(operationId)]);
  const parts = operationId.split(/[_.\-:/]+/).filter(Boolean);
  if (parts.length > 1) keys.add(norm(parts[parts.length - 1]));
  return [...keys].filter(Boolean);
}

/** Does this file look like an OpenAPI / Swagger document? Cheap check on name and first bytes. */
function looksLikeSpec(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (!/\.(json|ya?ml)$/.test(base)) return false;
  if (base === 'package.json' || base === 'tsconfig.json' || base.endsWith('.lock')) return false;
  if (/openapi|swagger|api-?spec|apidoc/.test(base)) return true;
  try {
    const st = fs.statSync(file);
    if (st.size > 20 * 1024 * 1024) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    return /("openapi"\s*:|^\s*openapi\s*:|"swagger"\s*:|^\s*swagger\s*:)/m.test(head);
  } catch {
    return false;
  }
}

export function findSpecFiles(root: string, exclude: RegExp[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (exclude.some((r) => r.test(normalize(full)))) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && looksLikeSpec(full)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function parseSpec(file: string): any | undefined {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  } catch {
    try {
      return YAML.parse(text);
    } catch {
      return undefined;
    }
  }
}

/** Load and index OpenAPI 2/3 documents. `files` overrides discovery. */
export function loadOpenApi(root: string, files?: string[], exclude: RegExp[] = [], warnings: string[] = []): OpenApiIndex {
  const index = new OpenApiIndex();
  const specFiles = files?.length ? files.map((f) => path.resolve(root, f)) : findSpecFiles(root, exclude);
  for (const file of specFiles) {
    const doc = parseSpec(file);
    if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || typeof doc.paths !== 'object') {
      if (files?.length) warnings.push(`openapi: ${toRel(root, file)} is not an OpenAPI document`);
      continue;
    }
    const rel = toRel(root, file);
    const basePath: string = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/$/, '') : '';
    const servers: string[] = Array.isArray(doc.servers) ? doc.servers.map((s: any) => String(s?.url ?? '')).filter(Boolean) : [];
    let count = 0;
    for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
      if (!item || typeof item !== 'object') continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== 'object') continue;
        const operationId: string | undefined = op.operationId;
        const fullPath = basePath + p;
        const operation: OpenApiOperation = {
          operationId: operationId ?? syntheticId(method, fullPath),
          method: method.toUpperCase(),
          path: fullPath,
          tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
          summary: typeof op.summary === 'string' ? op.summary : undefined,
          spec: rel,
          servers,
          explicitId: !!operationId,
        };
        index.add(operation);
        count++;
      }
    }
    index.specs.push({ file: rel, title: doc.info?.title, version: doc.info?.version, operations: count });
  }
  return index;
}

/** Deterministic name for operations without operationId, following the common generator convention (`getUsersId`). */
function syntheticId(method: string, p: string): string {
  const segs = p.split('/').filter(Boolean).map((s) => s.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim());
  return method + segs.map((s) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('');
}
