import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { analyze } from '../src/analyze.js';
import type { Analysis } from '../src/model.js';
import { callGraphDot } from '../src/output/dot.js';
import { htmlReport } from '../src/output/html.js';
import { callGraphFlowchart } from '../src/output/mermaid.js';
import { subgraph } from '../src/query.js';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../examples/demo');

let a: Analysis;
before(() => {
  a = analyze({ root: ROOT });
});

const edge = (kind: string, from: RegExp, to: RegExp) => a.edges.find((e) => e.kind === kind && from.test(e.from) && to.test(e.to));
const node = (re: RegExp) => a.nodes.find((n) => re.test(n.id));

describe('workspace loading', () => {
  it('discovers workspace packages', () => {
    assert.deepEqual(a.packages.map((p) => p.name).sort(), ['@demo/api-client', '@demo/machines', '@demo/web']);
  });
  it('never emits nodes from node_modules as internal', () => {
    assert.ok(a.nodes.every((n) => !n.internal || !n.file.includes('node_modules')));
  });
});

describe('call graph', () => {
  it('resolves calls across workspace packages', () => {
    assert.ok(edge('calls', /route\.ts#GET$/, /api-client\/src\/index\.ts#fetchUser$/));
  });
  it('resolves calls into npm packages by type', () => {
    assert.ok(edge('calls', /#UserCard$/, /^pkg:xstate#MachineSnapshotBase\.hasTag$/));
  });
  it('resolves methods via `this`', () => {
    assert.ok(edge('calls', /NotificationClient\.sendMany$/, /NotificationClient\.send$/));
  });
  it('classifies components and hooks and records JSX renders', () => {
    assert.equal(node(/UserCard\.tsx#UserCard$/)?.kind, 'component');
    assert.equal(node(/UserCard\.tsx#useOrders$/)?.kind, 'hook');
    assert.ok(edge('renders', /#UsersPage$/, /#UserCard$/));
  });
  it('folds anonymous callbacks into their owner', () => {
    assert.ok(!a.nodes.some((n) => n.internal && /useEffect|onClick/.test(n.name)));
    assert.ok(edge('calls', /#useOrders$/, /^pkg:react#useEffect$/));
  });
  it('names useCallback-wrapped functions', () => {
    assert.ok(node(/#UserCard\.handleSave$/));
  });
  it('drops pure inline data mappers', () => {
    assert.ok(!node(/userMachine\.input/), 'input mapper should be pruned');
    assert.ok(!node(/userMachine\.context/), 'context factory should be pruned');
  });
  it('falls back to import bindings for uninstalled packages', () => {
    assert.equal(a.externalCalls.find((c) => c.callee === 'prisma.user.findMany')?.package, '@prisma/client');
    assert.equal(a.externalCalls.find((c) => c.callee === 'kyApi.get')?.package, 'ky');
    assert.ok(edge('calls', /data\.ts#<module>$/, /^pkg:@prisma\/client#PrismaClient$/));
  });
  it('supports focus queries', () => {
    const ids = subgraph(a, 'fetchUser', 1);
    assert.ok(ids.size >= 3);
  });
});

describe('Next.js', () => {
  it('tags route handlers with routes and methods', () => {
    const get = node(/route\.ts#GET$/)!;
    assert.equal(get.entry, 'next:route');
    assert.equal(get.route, '/api/users/[id]');
    assert.deepEqual(get.httpMethods, ['GET']);
  });
  it('tags pages and pages/api handlers', () => {
    assert.equal(node(/users\/page\.tsx#UsersPage$/)?.route, '/users');
    assert.equal(node(/pages\/api\/health\.ts#handler$/)?.entry, 'next:api');
  });
  it('detects server actions and the client boundary', () => {
    assert.equal(node(/actions\/user\.ts#saveUserAction$/)?.entry, 'next:server-action');
    assert.equal(node(/#UserCard$/)?.boundary, 'client');
    assert.ok(edge('server-action', /#UserCard\.handleSave$/, /#saveUserAction$/));
    assert.ok(a.externalCalls.some((c) => c.category === 'server-action' && c.callee === 'saveUserAction'));
  });
  it('links fetch("/api/...") to the matching route handler through the endpoint node', () => {
    assert.ok(edge('external', /#useOrders$/, /^ext:http\|fetch\|GET\|\/api\/users\/\{userId\}$/));
    assert.ok(edge('http-route', /^ext:http\|fetch\|GET\|\/api\/users/, /route\.ts#GET$/));
  });
});

describe('XState', () => {
  const m = (name: string) => a.machines.find((x) => x.name === name)!;
  it('finds v5 setup, v5 createMachine and v4 Machine definitions', () => {
    assert.equal(m('userMachine').api, 'setup().createMachine');
    assert.equal(m('userMachine').version, 5);
    assert.equal(m('trafficLight').version, 4);
    assert.equal(m('notifierMachine').api, 'createMachine');
  });
  it('parses the state tree', () => {
    const root = m('userMachine').root;
    assert.equal(root.initial, 'idle');
    assert.deepEqual(root.states.map((s) => s.key), ['idle', 'loading', 'retrying', 'loaded', 'failed']);
    const loaded = root.states.find((s) => s.key === 'loaded')!;
    assert.equal(loaded.type, 'compound');
    assert.equal(root.states.find((s) => s.key === 'failed')!.type, 'final');
    assert.equal(m('trafficLight').root.states.find((s) => s.key === 'red')!.type, 'parallel');
  });
  it('resolves transition targets (#id, .child, sibling, nested)', () => {
    const um = m('userMachine');
    const rootRetry = um.root.transitions.find((t) => t.event === 'RETRY')!;
    assert.deepEqual(rootRetry.targets, ['loading']);
    assert.equal(rootRetry.guard, 'canRetry');
    const loaded = um.root.states.find((s) => s.key === 'loaded')!;
    assert.deepEqual(loaded.transitions.find((t) => t.event === 'FETCH')!.targets, ['loaded.viewing']);
    const editing = loaded.states.find((s) => s.key === 'editing')!;
    assert.deepEqual(editing.transitions.find((t) => t.event === 'SAVE')!.targets, ['loaded.saving']);
    const w = m('wizardMachine');
    const step3 = w.root.states[0].states.find((s) => s.key === 'step3')!;
    assert.deepEqual(step3.transitions[0].targets, ['submitting']);
    const submitting = w.root.states.find((s) => s.key === 'submitting')!;
    assert.deepEqual(submitting.transitions.map((t) => t.targets[0]), ['done', 'form.hist']);
  });
  it('parses invoke with onDone / onError arrays and guards', () => {
    const loading = m('userMachine').root.states.find((s) => s.key === 'loading')!;
    assert.equal(loading.invoke[0].src, 'loadUser');
    assert.equal(loading.invoke[0].onError.length, 2);
    assert.equal(loading.invoke[0].onError[0].guard, 'canRetry');
    assert.deepEqual(loading.invoke[0].onDone[0].actions, ['setUser']);
  });
  it('collects implementations from setup(), options and .provide()', () => {
    assert.deepEqual(m('userMachine').implementations.guards, ['canRetry', 'hasUser']);
    assert.ok(m('userMachine').implementations.actors.includes('loadUser'));
    assert.deepEqual(m('trafficLight').implementations.actions, ['beep']);
    assert.deepEqual(m('notifierMachine').implementations.actions, ['deliverNow']);
    assert.ok(edge('implements', /#userMachine$/, /userMachine\.loadUser$/));
    assert.ok(edge('calls', /userMachine\.loadUser$/, /#fetchUser$/), 'actor implementation calls through to the API client');
  });
  it('connects the defining scope to the machine and drops factory-call noise', () => {
    assert.ok(edge('defines', /notifierMachine\.ts#<module>$/, /#notifierMachine$/));
    assert.ok(edge('defines', /userMachine\.ts#<module>$/, /#userMachine$/));
    assert.ok(!a.edges.some((e) => /^pkg:xstate#(createMachine|setup|SetupReturn\.createMachine|StateMachine\.provide|Machine)$/.test(e.to)));
  });
  it('links machine usage and machine-to-machine references', () => {
    assert.ok(m('userMachine').usedBy.some((u) => u.endsWith('#UserCard')));
    assert.ok(edge('uses-machine', /#UserCard$/, /#userMachine$/));
    assert.ok(edge('invokes', /#userMachine$/, /#notifierMachine$/));
    assert.ok(edge('invokes', /#wizardMachine$/, /#notifierMachine$/), 'spawnChild("notifier") resolves via setup actors');
    assert.ok(m('wizardMachine').usedBy.some((u) => u.endsWith('#Wizard')), 'createActorContext(...).useSelector counts as usage');
  });
  it('emits mermaid with nested composites, parallel regions and notes', () => {
    const mm = m('trafficLight').mermaid;
    assert.match(mm, /^stateDiagram-v2$/m);
    assert.match(mm, /state s_red \{/);
    assert.match(mm, /^\s+--$/m);
    assert.match(m('userMachine').mermaid, /note right of s_loading/);
    assert.match(m('userMachine').mermaid, /s_loading --> s_retrying : error: loadUser \[canRetry\] \/ setError, incrementRetries/);
  });
});

describe('external calls', () => {
  const find = (pred: (c: Analysis['externalCalls'][number]) => boolean) => a.externalCalls.find(pred);
  it('detects fetch with template URLs and methods', () => {
    const c = find((x) => x.protocol === 'fetch' && x.method === 'DELETE')!;
    assert.equal(c.target, 'https://api.example.com/v1/users/{id}');
  });
  it('detects axios instances and resolves baseURL', () => {
    const c = find((x) => x.callee === 'api.post')!;
    assert.equal(c.method, 'POST');
    assert.equal(c.target, 'https://api.example.com/v1/notifications');
    assert.equal(c.caller, 'packages/api-client/src/index.ts#NotificationClient.send');
  });
  it('detects WebSocket constructors', () => {
    assert.equal(find((x) => x.category === 'websocket' && x.callee === 'new WebSocket')?.target, 'wss://live.example.com/feed/{userId}');
  });
  it('detects Prisma, Apollo, tRPC, socket.io and ky via import bindings', () => {
    assert.equal(find((x) => x.protocol === 'prisma')?.target, 'user');
    assert.equal(find((x) => x.protocol === '@apollo/client')?.target, 'GetProfile');
    assert.equal(find((x) => x.category === 'trpc')?.target, 'settings.get');
    assert.equal(find((x) => x.protocol === 'socket.io' && x.method === 'io')?.target, 'wss://rt.example.com');
    assert.equal(find((x) => x.protocol === 'ky')?.target, 'https://ky.example.com/health');
  });
});

describe('external nodes in the graph', () => {
  it('materializes one node per distinct target and attaches callers', () => {
    const ep = node(/^ext:http\|axios\|POST\|https:\/\/api\.example\.com\/v1\/notifications$/)!;
    assert.equal(ep.kind, 'external');
    assert.equal(ep.name, 'POST api.example.com/v1/notifications');
    assert.equal(ep.external?.category, 'http');
    assert.ok(a.edges.some((e) => e.kind === 'external' && /NotificationClient\.send$/.test(e.from) && e.to === ep.id));
  });
  it('replaces the package-member edge for the same call site', () => {
    assert.ok(!edge('calls', /NotificationClient\.send$/, /^pkg:axios#Axios\.post$/), 'axios.post edge should be subsumed by the endpoint node');
    assert.ok(edge('calls', /api-client\/src\/index\.ts#<module>$/, /^pkg:axios#AxiosInstance\.create$/), 'non-external axios usage stays');
  });
  it('labels db / graphql / trpc / websocket targets', () => {
    const names = a.nodes.filter((n) => n.kind === 'external').map((n) => n.name);
    for (const expected of ['prisma user.findMany', 'query GetProfile', 'trpc settings.get', 'WebSocket wss://live.example.com/feed/{userId}']) assert.ok(names.includes(expected), expected);
  });
  it('back-references the node from each external call', () => {
    assert.ok(a.externalCalls.filter((c) => c.category !== 'server-action').every((c) => c.node && a.nodes.some((n) => n.id === c.node)));
  });
});

describe('OpenAPI without generated code', () => {
  const op = (id: string) => a.openapi.operations.find((o) => o.operationId === id)!;
  it('indexes specs discovered in the repo', () => {
    assert.deepEqual(a.openapi.specs.map((s) => s.file), ['apps/web/openapi.yaml']);
    assert.equal(a.openapi.operations.length, 5);
    assert.equal(op('getOrdersIdItems').explicitId, false);
  });
  it('resolves generated-client method calls by operationId (generator / orval / hey-api / NestJS ids)', () => {
    const byCallee = (c: string) => a.externalCalls.find((x) => x.callee === c)!;
    assert.deepEqual([byCallee('usersApi.getUserById').method, byCallee('usersApi.getUserById').target], ['GET', '/users/{id}']);
    assert.deepEqual([byCallee('listUsers').method, byCallee('listUsers').target, byCallee('listUsers').rule], ['GET', '/users', 'openapi-operation']);
    assert.deepEqual([byCallee('UsersService.createUser').method, byCallee('UsersService.createUser').target], ['POST', '/users']);
    assert.equal(byCallee('usersApi.usersControllerDeleteUser').operationId, 'UsersController_deleteUser');
  });
  it('reads literal paths from openapi-fetch and matches them to the spec', () => {
    const c = a.externalCalls.find((x) => x.callee === 'client.GET')!;
    assert.equal(c.operationId, 'getOrdersIdItems');
  });
  it('merges fetch/axios calls to the same endpoint into one operation node', () => {
    const n = node(/^ext:openapi\|GET\|\/users\/\{id\}$/)!;
    assert.equal(n.external?.calls, 2);
    assert.ok(a.edges.some((e) => e.kind === 'external' && /#fetchUser$/.test(e.from) && e.to === n.id), 'axios call via server URL');
    assert.ok(a.edges.some((e) => e.kind === 'external' && /#loadUserProfile$/.test(e.from) && e.to === n.id), 'generated client call');
    assert.ok(!node(/^ext:http\|axios\|GET\|https:\/\/api\.example\.com\/v1\/users\/\{id\}$/), 'no duplicate raw-URL node');
  });
  it('tags server handlers named after operationIds and links endpoint nodes to them', () => {
    const h = node(/handlers\/users\.ts#getUserById$/)!;
    assert.equal(h.entry, 'openapi:operation');
    assert.equal(h.route, '/users/{id}');
    assert.deepEqual(h.httpMethods, ['GET']);
    assert.ok(edge('http-route', /^ext:openapi\|GET\|\/users\/\{id\}$/, /handlers\/users\.ts#getUserById$/));
    assert.notEqual(node(/handlers\/users\.ts#createUser$/)?.entry, 'openapi:operation', 'plain helper with non-server signature is not a handler');
  });
  it('cross-references callers and handlers per operation', () => {
    assert.equal(op('getUserById').callers?.length, 2);
    assert.deepEqual(op('getUserById').handlers, ['apps/web/src/server/handlers/users.ts#getUserById']);
    assert.deepEqual(op('createUser').handlers, []);
  });
  it('treats unresolved path-alias imports as internal, not npm packages', () => {
    assert.ok(!a.nodes.some((n) => n.kind === 'package' && n.file.startsWith('@/')));
  });
});

describe('outputs', () => {
  it('renders a flowchart, DOT and HTML without throwing', () => {
    assert.match(callGraphFlowchart(a), /^flowchart LR/);
    assert.match(callGraphDot(a), /^digraph callgraph/);
    const html = htmlReport(a);
    assert.ok(html.includes('<script id="data" type="application/json">'));
    assert.ok(!/<\/script>[\s\S]*<\/script>[\s\S]*"nodes"/.test(html.split('id="data"')[1].split('</script>')[0]));
  });
  it('produces no warnings on the demo', () => {
    assert.deepEqual(a.warnings, []);
  });
});
