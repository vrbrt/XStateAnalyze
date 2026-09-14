import { Node } from 'ts-morph';
import type { ExternalCall, ExternalRule, GraphNode } from '../model.js';
import type { OpenApiIndex } from '../openapi.js';
import { packageMatches } from '../rules.js';
import type { CallSite, EdgeSet } from './calls.js';
import type { NodeRegistry } from './functions.js';
import { unwrapExpr } from './functions.js';
import { resolveIdentifierInitializer } from './xstate.js';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Literal-ish text of an expression: strings, templates (`${x}` -> `{x}`), constants. */
export function literalText(n: Node | undefined, depth = 0): string | undefined {
  if (!n || depth > 4) return undefined;
  const u = unwrapExpr(n);
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return u.getLiteralText();
  if (Node.isTemplateExpression(u)) {
    let out = u.getHead().getLiteralText();
    for (const span of u.getTemplateSpans()) {
      const e = span.getExpression();
      const lit = literalText(e, depth + 1);
      out += lit !== undefined ? lit : `{${e.getText().replace(/\s+/g, '').slice(0, 30)}}`;
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(u) && u.getOperatorToken().getText() === '+') {
    const l = literalText(u.getLeft(), depth + 1);
    const r = literalText(u.getRight(), depth + 1);
    return `${l ?? `{${u.getLeft().getText().slice(0, 30)}}`}${r ?? `{${u.getRight().getText().slice(0, 30)}}`}`;
  }
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const init = resolveIdentifierInitializer(u, depth);
    if (init && init !== u && !Node.isCallExpression(init) && !Node.isObjectLiteralExpression(init)) return literalText(init, depth + 1);
    if (Node.isPropertyAccessExpression(u) && /^process\.env\./.test(u.getText())) return `{${u.getText()}}`;
    return undefined;
  }
  if (Node.isNewExpression(u) && u.getExpression().getText() === 'URL') return literalText(u.getArguments()[0], depth + 1);
  if (Node.isCallExpression(u)) {
    // `${base}/x`.replace(...) or url.toString()
    const e = unwrapExpr(u.getExpression());
    if (Node.isPropertyAccessExpression(e) && /^(toString|trim)$/.test(e.getName())) return literalText(e.getExpression(), depth + 1);
    return undefined;
  }
  return undefined;
}

function objProp(obj: Node | undefined, name: string): Node | undefined {
  if (!obj) return undefined;
  let u = unwrapExpr(obj);
  if (Node.isIdentifier(u)) u = resolveIdentifierInitializer(u) ?? u;
  if (!Node.isObjectLiteralExpression(u)) return undefined;
  const p = u.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

function gqlOperation(n: Node | undefined, depth = 0): { type: string; name?: string } | undefined {
  if (!n || depth > 4) return undefined;
  const u = unwrapExpr(n);
  if (Node.isTaggedTemplateExpression(u)) {
    const text = u.getTemplate().getText();
    const m = text.match(/\b(query|mutation|subscription|fragment)\b\s*([A-Za-z_][\w]*)?/);
    if (m) return { type: m[1], name: m[2] };
    return { type: 'query' };
  }
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) {
    const m = u.getLiteralText().match(/\b(query|mutation|subscription)\b\s*([A-Za-z_][\w]*)?/);
    if (m) return { type: m[1], name: m[2] };
  }
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const init = resolveIdentifierInitializer(u, depth);
    if (init && init !== u) return gqlOperation(init, depth + 1);
    return { type: 'query', name: u.getText() };
  }
  if (Node.isCallExpression(u)) {
    // graphql(`query ...`) codegen helper
    const arg = u.getArguments()[0];
    return gqlOperation(arg, depth + 1);
  }
  if (Node.isObjectLiteralExpression(u)) {
    for (const k of ['query', 'mutation', 'subscription', 'document']) {
      const p = objProp(u, k);
      if (p) return gqlOperation(p, depth + 1);
    }
  }
  return undefined;
}

function segments(callee: string): string[] {
  return callee.split('.').filter(Boolean);
}

type Details = Pick<ExternalCall, 'target' | 'method' | 'service' | 'operationId'>;

/** Fill method/path from an indexed OpenAPI operation matching a method name. */
function fromOpenApi(name: string, openapi: OpenApiIndex | undefined, out: Details): boolean {
  const ops = openapi?.lookup(name) ?? [];
  if (!ops.length) return false;
  const op = ops[0];
  out.method = op.method;
  out.target = op.path;
  out.operationId = op.operationId;
  if (!out.service && op.tags[0]) out.service = op.tags[0];
  return true;
}

function extract(site: CallSite, rule: ExternalRule, openapi?: OpenApiIndex): Details {
  const args = Node.isTaggedTemplateExpression(site.call) ? [] : site.call.getArguments();
  const segs = segments(site.calleeText);
  const last = segs[segs.length - 1] ?? site.calleeText;
  const out: Details = {};
  switch (rule.extract ?? 'rpc') {
    case 'openapi': {
      out.service = site.receiver?.typeName && site.receiver.typeName !== 'any' ? site.receiver.typeName : segs.length > 1 ? segs[segs.length - 2] : undefined;
      if (!fromOpenApi(last, openapi, out)) {
        out.method = last;
        out.target = undefined;
      }
      break;
    }
    case 'http': {
      out.target = literalText(args[0]) ?? args[0]?.getText().replace(/\s+/g, ' ').slice(0, 60);
      const m = literalText(objProp(args[1], 'method'));
      out.method = (m ?? 'GET').toUpperCase();
      break;
    }
    case 'axios-style': {
      if (HTTP_VERBS.has(last.toLowerCase())) {
        out.method = last.toUpperCase();
        // axios.get(url, opts) | client.get({ url }) (hey-api) | client.GET('/path', { params })
        out.target = literalText(objProp(args[0], 'url')) ?? literalText(args[0]) ?? args[0]?.getText().replace(/\s+/g, ' ').slice(0, 60);
        const base = extractBaseUrl(site);
        if (base && out.target && !/^https?:/.test(out.target)) out.target = joinUrl(base, out.target);
      } else {
        // axios(config) / axios(url, config) / got(url, opts)
        const first = args[0];
        const urlFromObj = literalText(objProp(first, 'url'));
        out.target = urlFromObj ?? literalText(first) ?? first?.getText().slice(0, 60);
        out.method = (literalText(objProp(first, 'method')) ?? literalText(objProp(args[1], 'method')) ?? 'GET').toUpperCase();
      }
      out.service = site.receiver?.typeName;
      break;
    }
    case 'graphql': {
      const op = args.map((a) => gqlOperation(a)).find(Boolean);
      out.method = op?.type ?? last;
      out.target = op?.name ?? args[0]?.getText().slice(0, 60);
      out.service = site.receiver?.typeName;
      break;
    }
    case 'orm': {
      out.method = last;
      out.target = segs.length >= 3 ? segs.slice(1, -1).join('.') : segs.length === 2 ? segs[0] : undefined;
      if (Node.isTaggedTemplateExpression(site.call)) out.target = site.call.getTemplate().getText().slice(1, 60).replace(/\s+/g, ' ');
      out.service = site.receiver?.typeName;
      break;
    }
    case 'ws': {
      out.target = literalText(args[0]) ?? args[0]?.getText().slice(0, 60);
      out.method = last;
      break;
    }
    case 'none':
      break;
    case 'rpc':
    default: {
      if (site.isNew) {
        out.method = 'new';
        out.service = site.calleeText;
        out.target = literalText(args[0]);
      } else {
        out.method = last;
        out.service = site.receiver?.typeName;
        // trpc.user.getById.useQuery -> user.getById ; client.getUser -> getUser
        out.target = segs.length >= 3 ? segs.slice(1, -1).join('.') : segs.length === 2 ? `${segs[0]}.${last}` : last;
        if (rule.category === 'trpc' && segs.length >= 3) out.target = segs.slice(1, -1).join('.');
      }
      break;
    }
  }
  return out;
}

/** For `api.get(...)` where `const api = axios.create({ baseURL })`, return the baseURL literal. */
function extractBaseUrl(site: CallSite): string | undefined {
  const expr = Node.isTaggedTemplateExpression(site.call) ? site.call.getTag() : site.call.getExpression();
  const u = unwrapExpr(expr);
  if (!Node.isPropertyAccessExpression(u)) return undefined;
  const recv = unwrapExpr(u.getExpression());
  if (!Node.isIdentifier(recv) && !Node.isPropertyAccessExpression(recv)) return undefined;
  const init = resolveIdentifierInitializer(recv);
  if (!init || !Node.isCallExpression(init)) return undefined;
  return literalText(objProp(init.getArguments()[0], 'baseURL') ?? objProp(init.getArguments()[0], 'prefixUrl') ?? objProp(init.getArguments()[0], 'baseUrl'));
}

function joinUrl(base: string, p: string): string {
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

function ruleMatches(site: CallSite, rule: ExternalRule): boolean {
  if (!!rule.isConstructor !== site.isNew) return false;
  const pkg = site.resolution.package ?? site.receiver?.typePackage ?? site.originPackage;
  const hasLib = !!(rule.packages || rule.globals || rule.importModule);
  if (hasLib) {
    const byPkg = rule.packages ? packageMatches(pkg, rule.packages) || packageMatches(site.receiver?.typePackage, rule.packages) : false;
    const mod = site.importedFrom ?? site.originModule;
    const byModule = rule.importModule ? site.resolution.kind !== 'internal' && !!mod && new RegExp(rule.importModule).test(mod) : false;
    const globalName = site.calleeText.replace(/^(window|globalThis|self)\./, '');
    // a global is anything not declared in the project and not imported (lib types, or packages augmenting globals)
    const byGlobal = rule.globals ? site.resolution.kind !== 'internal' && !site.importedFrom && rule.globals.includes(globalName) : false;
    if (!byPkg && !byGlobal && !byModule) return false;
  }
  if (rule.receiverTypeFile && !(site.receiver?.typeFile && new RegExp(rule.receiverTypeFile).test(site.receiver.typeFile))) return false;
  if (rule.receiverType && !(site.receiver?.typeName && new RegExp(rule.receiverType).test(site.receiver.typeName))) return false;
  if (!hasLib && !rule.receiverTypeFile && !rule.receiverType && !rule.callee) return false;
  if (rule.callee && rule.extract === 'openapi' && new RegExp(rule.callee).test(site.calleeText) && /\.(then|catch|finally|json|text|toString|map|filter|forEach)$/.test(site.calleeText)) return false;
  if (rule.callee && !new RegExp(rule.callee).test(site.calleeText)) return false;
  return true;
}

/** Short display name for an external node. */
export function externalLabel(c: Pick<ExternalCall, 'category' | 'protocol' | 'method' | 'target' | 'callee' | 'service'>): string {
  const t = c.target;
  switch (c.category) {
    case 'http': {
      const short = t ? t.replace(/^(https?|wss?):\/\//, '') : `${c.callee}(?)`;
      return `${c.method ?? 'GET'} ${short}`;
    }
    case 'graphql':
      return `${c.method ?? 'query'} ${t ?? c.callee}`;
    case 'db':
      return `${c.protocol} ${t ? t + '.' : ''}${c.method ?? ''}`.trim();
    case 'trpc':
      return `trpc ${t ?? c.callee}`;
    case 'grpc':
      return `${c.service ?? c.protocol}.${c.method ?? t ?? c.callee}`;
    case 'websocket':
      return `${c.protocol}${c.method && c.method !== c.protocol ? ' ' + c.method : ''} ${t ?? ''}`.trim();
    default:
      return `${c.protocol} ${t ?? c.method ?? c.callee}`.trim();
  }
}

/**
 * Create (or reuse) the graph node standing for an external call's target and
 * connect the caller to it. The package-member edge for the same call site
 * (`api.get`) is dropped so the endpoint node replaces it in the graph.
 */
export function attachExternalNode(c: ExternalCall, registry: NodeRegistry, edges: EdgeSet, openapi?: OpenApiIndex, subsumed?: { to: string; kind: 'calls' }): GraphNode {
  // HTTP calls that hit a spec'd operation share one node per operation, whatever client made the call
  if (c.category === 'http' && openapi?.size && !c.operationId) {
    const op = openapi.match(c.method, c.target);
    if (op) {
      c.operationId = op.operationId;
      if (!c.service && op.tags[0]) c.service = op.tags[0];
    }
  }
  const op = c.operationId ? openapi?.lookup(c.operationId).find((o) => o.operationId === c.operationId) : undefined;
  const id = op ? `ext:openapi|${op.method}|${op.path}` : `ext:${c.category}|${c.protocol}|${c.method ?? ''}|${c.target ?? c.callee}`;
  let n = registry.nodes.get(id);
  if (!n) {
    n = {
      id,
      kind: 'external',
      name: op ? `${op.method} ${op.path}` : externalLabel(c),
      file: '(external)',
      package: c.package,
      internal: false,
      operationId: op?.operationId,
      external: { category: c.category, protocol: op ? 'openapi' : c.protocol, method: op?.method ?? c.method, target: op?.path ?? c.target, service: c.service, calls: 0 },
      tags: op ? [`spec:${op.spec}`, ...(op.tags.map((t) => `tag:${t}`))] : undefined,
    };
    registry.nodes.set(id, n);
  }
  n.external!.calls++;
  edges.add(c.caller, id, 'external', c.line, c.protocol);
  if (subsumed) edges.remove(c.caller, subsumed.to, subsumed.kind);
  return n;
}

/** Package/builtin edge a call site produced, to be replaced by its external node. */
export function subsumedEdge(site: CallSite): { to: string; kind: 'calls' } | undefined {
  if (site.resolution.kind === 'package' && site.resolution.package && site.resolution.member) return { to: `pkg:${site.resolution.package}#${site.resolution.member}`, kind: 'calls' };
  if (site.resolution.kind === 'builtin' && site.resolution.member) return { to: `builtin:${site.resolution.member}`, kind: 'calls' };
  return undefined;
}

const OPENAPI_FALLBACK_RULE: ExternalRule = { name: 'openapi-operation', category: 'http', protocol: 'openapi', extract: 'openapi' };

export function detectExternalCalls(sites: CallSite[], rules: ExternalRule[], counter: { n: number }, graph?: { registry: NodeRegistry; edges: EdgeSet; openapi?: OpenApiIndex }): ExternalCall[] {
  const out: ExternalCall[] = [];
  const openapi = graph?.openapi;
  for (const site of sites) {
    let matched: ExternalRule | undefined = rules.find((r) => ruleMatches(site, r));
    if (!matched && openapi?.size && !site.isNew && site.resolution.kind !== 'internal' && !Node.isTaggedTemplateExpression(site.call)) {
      // No library rule matched: a bare function / method whose name is an operationId of an indexed spec
      // (orval `listUsers()`, generated `usersApi.getUserById()`) is a call to that operation.
      const last = site.calleeText.split('.').pop() ?? '';
      const ops = openapi.lookup(last);
      if (ops.length && ops.some((o) => o.explicitId)) matched = OPENAPI_FALLBACK_RULE;
    }
    if (matched) {
      const rule = matched;
      const details = extract(site, rule, openapi);
      // enrich other http detections (e.g. axios wrapper named after an operation) with the spec when they lack a target
      if (rule.category === 'http' && !details.target && rule.extract !== 'openapi') fromOpenApi(site.calleeText.split('.').pop() ?? '', openapi, details);
      const call: ExternalCall = {
        id: `ext:${counter.n++}`,
        category: rule.category,
        protocol: rule.protocol,
        callee: (site.isNew ? 'new ' : '') + site.calleeText,
        ...details,
        file: site.file,
        line: site.line,
        caller: site.owner.id,
        package: rule.packages && packageMatches(site.receiver?.typePackage, rule.packages) && !packageMatches(site.resolution.package, rule.packages)
          ? site.receiver?.typePackage
          : site.resolution.package ?? site.receiver?.typePackage,
        rule: rule.name,
      };
      if (graph) call.node = attachExternalNode(call, graph.registry, graph.edges, openapi, subsumedEdge(site)).id;
      out.push(call);
    }
  }
  return out;
}
