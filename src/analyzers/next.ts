import { Node, SourceFile } from 'ts-morph';
import type { EntryKind, ExternalCall, FileInfo, GraphEdge, GraphNode } from '../model.js';
import type { EdgeSet } from './calls.js';
import { FunctionLike, NodeRegistry } from './functions.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function directive(statements: Node[]): 'client' | 'server' | undefined {
  for (const s of statements.slice(0, 3)) {
    if (!Node.isExpressionStatement(s)) break;
    const e = s.getExpression();
    if (!Node.isStringLiteral(e)) break;
    const t = e.getLiteralText();
    if (t === 'use client') return 'client';
    if (t === 'use server') return 'server';
  }
  return undefined;
}

/** Route path from an app-router or pages-router file path. */
export function routeFromPath(rel: string): { route: string; kind: 'app' | 'pages' | 'pages-api' | 'middleware'; file: string } | undefined {
  const p = rel.replace(/\\/g, '/');
  let m = p.match(/(?:^|\/)(?:src\/)?app\/(.*?)(?:^|\/)?(page|layout|route|loading|error|template|default|not-found|global-error)\.(?:tsx?|jsx?|mjs)$/);
  if (m) {
    const segs = m[1]
      .split('/')
      .filter(Boolean)
      .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    return { route: '/' + segs.join('/'), kind: 'app', file: m[2] };
  }
  m = p.match(/(?:^|\/)(?:src\/)?pages\/(.*)\.(?:tsx?|jsx?|mjs)$/);
  if (m) {
    const rest = m[1];
    if (/^_(app|document|error)$/.test(rest)) return undefined;
    const segs = rest.split('/').filter(Boolean);
    if (segs[segs.length - 1] === 'index') segs.pop();
    const route = '/' + segs.join('/');
    return { route, kind: segs[0] === 'api' ? 'pages-api' : 'pages', file: 'page' };
  }
  if (/(?:^|\/)(?:src\/)?middleware\.(?:tsx?|jsx?|mjs)$/.test(p)) return { route: '/*', kind: 'middleware', file: 'middleware' };
  return undefined;
}

function fnHasUseServer(fn: FunctionLike): boolean {
  const body = (fn as any).getBody?.() as Node | undefined;
  if (!body || !Node.isBlock(body)) return false;
  return directive(body.getStatements()) === 'server';
}

/**
 * Tag nodes of a file with Next.js entry kinds and client/server boundaries.
 * Returns the FileInfo record for the analysis output.
 */
export function analyzeNextFile(sf: SourceFile, fns: { node: GraphNode; fn: FunctionLike }[], registry: NodeRegistry): FileInfo {
  const rel = registry.relPath(sf);
  const boundary = directive(sf.getStatements());
  const info: FileInfo = { path: rel, package: registry.packageOf(sf), boundary, imports: [] };
  for (const imp of sf.getImportDeclarations()) {
    let internal = false;
    let resolvedPackage: string | undefined;
    try {
      const t = imp.getModuleSpecifierSourceFile();
      if (t) {
        internal = registry.isInternalFile(t);
        resolvedPackage = registry.packageOf(t);
      }
    } catch {
      /* ignore */
    }
    info.imports.push({
      module: imp.getModuleSpecifierValue(),
      names: [
        ...(imp.getDefaultImport() ? ['default'] : []),
        ...(imp.getNamespaceImport() ? ['*'] : []),
        ...imp.getNamedImports().map((n) => n.getNameNode().getText()),
      ],
      resolvedPackage,
      internal,
    });
  }

  const topLevel = fns.filter((f) => !f.node.name.includes('.') || f.node.name === 'default');
  const byName = new Map(topLevel.map((f) => [f.node.name, f]));
  const mark = (node: GraphNode, entry: EntryKind, route?: string, methods?: string[]) => {
    node.entry = entry;
    if (route) node.route = route;
    if (methods) node.httpMethods = methods;
  };

  for (const f of fns) {
    if (boundary) f.node.boundary = boundary;
    if (boundary === 'server' && f.node.exported && !f.node.name.includes('.')) mark(f.node, 'next:server-action');
    else if (fnHasUseServer(f.fn)) {
      f.node.boundary = 'server';
      mark(f.node, 'next:server-action');
    }
  }

  const r = routeFromPath(rel);
  if (r) {
    info.route = r.route;
    if (r.kind === 'app') {
      if (r.file === 'route') {
        info.entry = 'next:route';
        const methods: string[] = [];
        for (const m of HTTP_METHODS) {
          const f = byName.get(m);
          if (f && f.node.exported) {
            mark(f.node, 'next:route', r.route, [m]);
            methods.push(m);
          }
        }
        // also `export const GET = handler` style re-exports are covered by exportedDeclarations naming
      } else {
        const entry: EntryKind = r.file === 'layout' ? 'next:layout' : 'next:page';
        info.entry = entry;
        const def = byName.get('default') ?? topLevel.find((f) => f.node.exported && f.node.kind === 'component');
        if (def) mark(def.node, entry, r.route);
        for (const name of ['generateMetadata', 'generateStaticParams', 'generateViewport']) {
          const f = byName.get(name);
          if (f) mark(f.node, 'next:data-fn', r.route);
        }
      }
    } else if (r.kind === 'pages-api') {
      info.entry = 'next:api';
      const def = byName.get('default') ?? topLevel.find((f) => f.node.exported);
      if (def) mark(def.node, 'next:api', r.route, HTTP_METHODS);
    } else if (r.kind === 'pages') {
      info.entry = 'next:page';
      const def = byName.get('default') ?? topLevel.find((f) => f.node.exported && f.node.kind === 'component');
      if (def) mark(def.node, 'next:page', r.route);
      for (const name of ['getServerSideProps', 'getStaticProps', 'getStaticPaths', 'getInitialProps']) {
        const f = byName.get(name);
        if (f) mark(f.node, 'next:data-fn', r.route);
      }
    } else if (r.kind === 'middleware') {
      info.entry = 'next:middleware';
      const def = byName.get('middleware') ?? byName.get('default');
      if (def) mark(def.node, 'next:middleware', '/*');
    }
  }
  return info;
}

/**
 * Post-pass: turn client -> 'use server' calls into `server-action` edges and
 * external calls, and link `fetch('/api/...')` to matching route handlers.
 */
export function linkNextBoundaries(nodes: Map<string, GraphNode>, edges: EdgeSet, externalCalls: ExternalCall[], counter: { n: number }) {
  // server actions
  for (const e of edges.edges.values()) {
    if (e.kind !== 'calls') continue;
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    if (to.entry === 'next:server-action' && from.boundary !== 'server' && from.file !== to.file) {
      e.kind = 'server-action';
      externalCalls.push({
        id: `ext:${counter.n++}`,
        category: 'server-action',
        protocol: 'next/server-action',
        callee: to.name,
        target: `${to.file}#${to.name}`,
        method: 'POST',
        file: from.file,
        line: e.line ?? 0,
        caller: from.id,
        rule: 'next-server-action',
      });
    }
  }

  // fetch('/api/x') -> route handler
  const routes: { node: GraphNode; re: RegExp; methods: string[] }[] = [];
  const routeRe = (route: string) =>
    new RegExp(
      '^' +
        route
          .split('/')
          .map((s) => (/^\[\.\.\..*\]$/.test(s) || /^\[\[\.\.\..*\]\]$/.test(s) ? '.*' : /^(\[.*\]|\{.*\}|:\w+)$/.test(s) ? '[^/]+' : s.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
          .join('/') +
        '/?$',
    );
  for (const n of nodes.values()) {
    if ((n.entry === 'next:route' || n.entry === 'next:api' || n.entry === 'openapi:operation') && n.route) {
      routes.push({ node: n, re: routeRe(n.route), methods: n.httpMethods ?? HTTP_METHODS });
      // OpenAPI handlers also answer under each server base path (`/api/v1` + path)
      for (const base of n.tags?.filter((t) => t.startsWith('server:')).map((t) => t.slice(7)) ?? []) {
        const prefix = base.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
        if (prefix) routes.push({ node: n, re: routeRe(prefix + n.route), methods: n.httpMethods ?? HTTP_METHODS });
      }
    }
  }
  if (!routes.length) return;
  for (const c of externalCalls) {
    if (c.category !== 'http' || !c.target) continue;
    let pathOnly = c.target.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    if (!pathOnly.startsWith('/')) {
      if (/^\{.*\}\/?/.test(pathOnly)) pathOnly = pathOnly.replace(/^\{[^}]*\}/, ''); // `${BASE}/api/x`
      else continue;
    }
    if (!pathOnly.startsWith('/')) continue;
    // `{id}` placeholders from template literals match any single segment
    const probe = pathOnly.replace(/\{[^}]*\}/g, '__param__');
    const method = (c.method ?? 'GET').toUpperCase();
    for (const r of routes) {
      const re = new RegExp(r.re.source.replace(/\[\^\/\]\+/g, '(?:[^/]+|__param__)'));
      if (!re.test(probe)) continue;
      if (!r.methods.includes(method)) continue;
      edges.add(c.node ?? c.caller, r.node.id, 'http-route', c.line, `${method} ${pathOnly}`);
    }
  }
}

export type { GraphEdge };
