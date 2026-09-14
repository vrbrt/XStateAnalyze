import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project, ts } from 'ts-morph';
import type { AnalyzerOptions, WorkspacePackage } from './model.js';

export interface LoadedPackage extends WorkspacePackage {
  project: Project;
  tsconfig?: string;
}

export interface LoadedWorkspace {
  root: string;
  rootPackageName: string;
  packages: LoadedPackage[];
  /** absolute file path -> owning package name */
  fileOwner: Map<string, string>;
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', '.cache',
  'storybook-static', '.vercel', '.output', '__generated__', '.yarn', '.pnpm',
]);

export function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

export function toRel(root: string, abs: string): string {
  const rel = normalize(path.relative(root, abs));
  return rel.startsWith('..') ? normalize(abs) : rel;
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Minimal glob expansion for workspace patterns like `packages/*`, `apps/**`, `libs/foo`. */
function expandWorkspaceGlob(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (clean.startsWith('!')) return [];
  const parts = clean.split('/');
  let dirs = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part === '*' || part === '**') {
        if (!fs.existsSync(d)) continue;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            next.push(path.join(d, e.name));
            if (part === '**') next.push(...expandWorkspaceGlob(path.join(d, e.name), '**'));
          }
        }
      } else if (part.includes('*')) {
        const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (!fs.existsSync(d)) continue;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory() && re.test(e.name)) next.push(path.join(d, e.name));
        }
      } else {
        next.push(path.join(d, part));
      }
    }
    dirs = next;
  }
  return dirs.filter((d) => fs.existsSync(path.join(d, 'package.json')));
}

/** Discover workspace packages via package.json workspaces, pnpm-workspace.yaml or lerna.json. */
export function discoverWorkspaces(root: string): { name: string; dir: string }[] {
  const patterns: string[] = [];
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.workspaces) {
    if (Array.isArray(pkg.workspaces)) patterns.push(...pkg.workspaces);
    else if (Array.isArray(pkg.workspaces.packages)) patterns.push(...pkg.workspaces.packages);
  }
  const pnpmFile = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmFile)) {
    const yaml = fs.readFileSync(pnpmFile, 'utf8');
    const m = yaml.match(/packages:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (m) {
      for (const line of m[1].split('\n')) {
        const item = line.match(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/);
        if (item) patterns.push(item[1].trim());
      }
    }
  }
  const lerna = readJson(path.join(root, 'lerna.json'));
  if (Array.isArray(lerna?.packages)) patterns.push(...lerna.packages);

  const seen = new Map<string, { name: string; dir: string }>();
  for (const p of patterns) {
    for (const dir of expandWorkspaceGlob(root, p)) {
      const name = readJson(path.join(dir, 'package.json'))?.name ?? path.basename(dir);
      seen.set(normalize(dir), { name, dir });
    }
  }
  // most specific (deepest) packages first so file ownership resolves correctly
  return [...seen.values()].sort((a, b) => b.dir.length - a.dir.length);
}

function isExcludedDir(name: string, extra: Set<string>): boolean {
  return DEFAULT_EXCLUDE_DIRS.has(name) || extra.has(name);
}

/** Recursively list source files under `dir`, skipping other workspace package dirs and build output. */
function listSourceFiles(dir: string, stopDirs: Set<string>, extraExclude: Set<string>, excludeRe: RegExp[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const n = normalize(full);
      if (e.isDirectory()) {
        if (isExcludedDir(e.name, extraExclude)) continue;
        if (stopDirs.has(n)) continue; // another workspace package owns this
        if (excludeRe.some((r) => r.test(n))) continue;
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!SOURCE_EXT.has(ext)) continue;
        if (e.name.endsWith('.d.ts')) continue;
        if (excludeRe.some((r) => r.test(n))) continue;
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = glob
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(re + '(?:/|$)');
}

const FALLBACK_COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  resolveJsonModule: true,
  strict: false,
};

function findTsconfig(dir: string): string | undefined {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

export function loadWorkspace(opts: AnalyzerOptions): LoadedWorkspace {
  const root = path.resolve(opts.root);
  const rootPkgJson = readJson(path.join(root, 'package.json'));
  const rootPackageName = rootPkgJson?.name ?? path.basename(root);
  const extraExclude = new Set<string>();
  const excludeRe = (opts.exclude ?? []).map(globToRegExp);
  const includeRe = (opts.include ?? []).map(globToRegExp);

  const workspaces = discoverWorkspaces(root);
  const pkgDirs = new Set(workspaces.map((w) => normalize(w.dir)));
  const log = opts.onProgress ?? (() => {});

  const packages: LoadedPackage[] = [];
  const fileOwner = new Map<string, string>();

  const makeProject = (dir: string, tsconfig: string | undefined): Project => {
    if (tsconfig) {
      try {
        return new Project({
          tsConfigFilePath: tsconfig,
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: false,
          compilerOptions: { noEmit: true, skipLibCheck: true, allowJs: true },
        });
      } catch (e) {
        log(`warn: failed to read ${tsconfig}: ${(e as Error).message}; using defaults`);
      }
    }
    return new Project({ compilerOptions: { ...FALLBACK_COMPILER_OPTIONS, baseUrl: dir } });
  };

  const addPackage = (name: string, dir: string) => {
    const stop = new Set([...pkgDirs].filter((d) => d !== normalize(dir)));
    let files = listSourceFiles(dir, stop, extraExclude, excludeRe);
    if (includeRe.length) files = files.filter((f) => includeRe.some((r) => r.test(normalize(f))));
    if (!files.length) return;
    const tsconfig = opts.tsconfig ? path.resolve(opts.tsconfig) : findTsconfig(dir);
    const project = makeProject(dir, tsconfig);
    project.addSourceFilesAtPaths(files);
    for (const f of files) fileOwner.set(normalize(f), name);
    packages.push({ name, dir: toRel(root, dir) || '.', files: files.length, project, tsconfig: tsconfig ? toRel(root, tsconfig) : undefined });
    log(`loaded ${name} (${files.length} files${tsconfig ? ', ' + toRel(root, tsconfig) : ''})`);
  };

  for (const w of workspaces) addPackage(w.name, w.dir);
  // root itself (files not owned by any workspace package)
  if (!pkgDirs.has(normalize(root))) addPackage(rootPackageName, root);

  return { root, rootPackageName, packages, fileOwner };
}

/** npm package name from an absolute path inside node_modules, or undefined. */
export function packageNameFromPath(absPath: string): string | undefined {
  const p = normalize(absPath);
  const idx = p.lastIndexOf('/node_modules/');
  if (idx < 0) return undefined;
  const rest = p.slice(idx + '/node_modules/'.length).split('/');
  let name = rest[0];
  if (name.startsWith('@') && rest.length > 1) name = `${rest[0]}/${rest[1]}`;
  if (name.startsWith('@types/')) {
    const n = name.slice('@types/'.length);
    name = n.includes('__') ? '@' + n.replace('__', '/') : n;
  }
  return name;
}

export function isTsLibFile(absPath: string): boolean {
  const p = normalize(absPath);
  return /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(p) || /\/node_modules\/@types\/node\//.test(p);
}

/** Find the nearest package.json name for an absolute path (cached). */
const pkgNameCache = new Map<string, string | undefined>();
export function nearestPackageName(absPath: string, stopAt: string): string | undefined {
  let dir = path.dirname(absPath);
  const visited: string[] = [];
  while (true) {
    const key = normalize(dir);
    if (pkgNameCache.has(key)) {
      const v = pkgNameCache.get(key);
      for (const d of visited) pkgNameCache.set(d, v);
      return v;
    }
    visited.push(key);
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const name = readJson(pj)?.name ?? path.basename(dir);
      for (const d of visited) pkgNameCache.set(d, name);
      return name;
    }
    if (normalize(dir) === normalize(stopAt)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of visited) pkgNameCache.set(d, undefined);
  return undefined;
}
