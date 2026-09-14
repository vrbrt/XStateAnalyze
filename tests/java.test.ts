import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { analyzeJava } from '../src/java/analyze.js';
import { parseJava } from '../src/java/parse.js';
import type { Analysis } from '../src/model.js';
import { analyzeWorkspace, loadWorkspaceConfig } from '../src/workspace.js';

const EX = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../examples');

describe('java parser', () => {
  it('extracts types, annotations, generics, chains and locals', () => {
    const f = parseJava(
      `package a.b;
import java.util.*;
@RestController @RequestMapping(value = {"/x", "/y"}, method = RequestMethod.POST)
public class C implements Runnable, Comparable<C> {
  private static final String BASE = "http://h" + "/api";
  private Map<String, List<Integer>> m;
  @Value("\${k}") private String v;
  public C(Repo repo) { this.repo = repo; }
  public List<String> run(int n, String... rest) {
    var u = repo.findById(n).orElseThrow();
    for (String s : rest) s.length();
    handlers.forEach(h -> h.handle(n));
    return String.format("%s/%d", u, n);
  }
}`,
      'C.java',
    );
    assert.equal(f.package, 'a.b');
    const t = f.types[0];
    assert.equal(t.fqn, 'a.b.C');
    assert.deepEqual(t.interfaces.map((i) => i.name), ['Runnable', 'Comparable']);
    assert.deepEqual(t.annotations[1].args, { value: ['/x', '/y'], method: 'RequestMethod.POST' });
    assert.equal(t.fields.find((x) => x.name === 'BASE')?.constValue, 'http://h/api');
    assert.equal(t.fields.find((x) => x.name === 'm')?.type.args[1].args[0].name, 'Integer');
    assert.equal(t.fields.find((x) => x.name === 'v')?.annotations[0].args.value, '${k}');
    const ctor = t.methods.find((m) => m.isConstructor)!;
    assert.deepEqual(ctor.assignments, [{ field: 'repo', from: 'repo' }]);
    const run = t.methods.find((m) => m.name === 'run')!;
    assert.equal(run.returnType?.name, 'List');
    assert.deepEqual(run.params.map((p) => p.name), ['n', 'rest']);
    const chain = run.chains.find((c) => c.segments[0].name === 'repo')!;
    assert.deepEqual(chain.segments.map((s) => s.name + (s.call ? '()' : '')), ['repo', 'findById()', 'orElseThrow()']);
    assert.ok(run.locals.some((l) => l.name === 'u' && !l.type && l.init));
    assert.ok(run.locals.some((l) => l.name === 's' && l.type?.name === 'String'));
    const fe = run.chains.find((c) => c.segments[1]?.name === 'forEach')!;
    assert.equal(fe.segments[1].call!.args[0].kind, 'lambda');
  });
  it('never throws on unparsable input', () => {
    const f = parseJava('class { this is not java', 'Bad.java');
    assert.ok(f.parseError);
  });
});

describe('java / spring analysis', () => {
  let a: Analysis;
  before(() => {
    a = analyzeJava({ root: path.join(EX, 'services/users-service') });
  });
  const node = (re: RegExp) => a.nodes.find((n) => re.test(n.id));
  const edge = (kind: string, from: RegExp, to: RegExp) => a.edges.find((e) => e.kind === kind && from.test(e.from) && to.test(e.to));

  it('reads application.yml (profile documents excluded) and project identity', () => {
    const p = a.projects[0];
    assert.equal(p.serviceName, 'users-service');
    assert.equal(p.contextPath, '/v1');
    assert.equal(p.port, '8081');
    assert.ok(p.hosts.includes('users-service') && p.hosts.includes('localhost:8081'));
  });
  it('tags @RestController methods with context-path routes and methods', () => {
    const get = node(/UsersController\.getUserById$/)!;
    assert.equal(get.entry, 'spring:endpoint');
    assert.equal(get.route, '/v1/users/{id}');
    assert.deepEqual(get.httpMethods, ['GET']);
    assert.equal(get.operationId, 'getUserById', 'matched to the committed spec');
    assert.equal(node(/UsersController\.createUser$/)?.httpMethods?.[0], 'POST');
  });
  it('resolves interface calls to the @Primary implementation (Spring DI)', () => {
    assert.ok(edge('calls', /UserServiceImpl\.create$/, /EmailNotificationGateway\.notify$/));
    assert.ok(!edge('calls', /UserServiceImpl\.create$/, /SmsNotificationGateway\.notify$/), '@Primary excludes the other bean');
    const e = edge('calls', /UsersController\.getUserById$/, /UserServiceImpl\.findById$/)!;
    assert.equal(e.label, 'via UserService');
  });
  it('fans out List<Interface> injection to every implementation', () => {
    const e1 = edge('calls', /UserServiceImpl\.create$/, /EmailValidator\.validate$/)!;
    const e2 = edge('calls', /UserServiceImpl\.create$/, /NameValidator\.validate$/)!;
    assert.equal(e1.label, 'via UserValidator (all)');
    assert.equal(e2.label, 'via UserValidator (all)');
  });
  it('resolves @Value properties into RestTemplate / WebClient URLs (incl. @Bean baseUrl)', () => {
    const rt = a.externalCalls.find((c) => c.callee === 'restTemplate.getForObject' && /countOrders/.test(c.caller))!;
    assert.deepEqual([rt.method, rt.target], ['GET', 'http://orders-service/api/orders?user={userId}']);
    const wc = a.externalCalls.find((c) => c.protocol === 'WebClient')!;
    assert.deepEqual([wc.method, wc.target], ['GET', 'http://orders-service/api/orders/{id}']);
  });
  it('detects Spring Data repository calls as db externals with the entity', () => {
    const save = a.externalCalls.find((c) => c.callee === 'repository.save')!;
    assert.deepEqual([save.category, save.protocol, save.target, save.method], ['db', 'spring-data', 'UserEntity', 'save']);
  });
  it('detects Kafka sends with the topic from properties and @KafkaListener entries', () => {
    const send = a.externalCalls.find((c) => c.protocol === 'kafka')!;
    assert.equal(send.target, 'users.updated');
    const l = node(/OrderEventsListener\.onOrderCreated$/)!;
    assert.equal(l.entry, 'spring:listener');
    assert.deepEqual(l.topics, ['orders.created']);
  });
  it('treats calls on an absent generated client as openapi calls', () => {
    const c = a.externalCalls.find((c) => c.callee === 'billingApi.createInvoice')!;
    assert.equal(c.protocol, 'openapi-client');
  });
  it('registers main and constructor / class nodes', () => {
    assert.equal(node(/UsersApplication\.main$/)?.entry, 'main');
    assert.ok(edge('calls', /EmailNotificationGateway\.notify$/, /MailRequest\.java#MailRequest$/), 'new Record(...) -> class node');
  });
});

describe('workspace: multi-project seams', () => {
  let a: Analysis;
  before(() => {
    a = analyzeWorkspace(loadWorkspaceConfig(path.join(EX, 'xsa.workspace.json')));
  });
  const seam = (re: RegExp) => a.seams.find((s) => re.test(s.label));
  const parties = (list: { project?: string; node: string }[]) => list.map((p) => `${p.project}:${a.nodes.find((n) => n.id === p.node)?.name}`).sort();

  it('analyzes ts and java projects with prefixed ids and shared endpoint nodes', () => {
    assert.deepEqual(a.projects.map((p) => `${p.name}:${p.language}`), ['web:ts', 'users-service:java', 'orders-service:java', 'bpmn-engine:java']);
    assert.ok(a.nodes.some((n) => n.id.startsWith('web::')) && a.nodes.some((n) => n.id.startsWith('users-service::')));
    assert.ok(a.machines.every((m) => m.id.startsWith('web::')));
  });
  it('links frontend calls to the Spring implementation through the shared spec', () => {
    const s = seam(/^GET \/users\/\{id\}$/)!;
    assert.equal(s.status, 'linked');
    assert.deepEqual(parties(s.handlers), ['users-service:UsersController.getUserById']);
    assert.ok(parties(s.callers).includes('web:fetchUser'));
    assert.ok(parties(s.callers).includes('orders-service:OrderService.place'), 'RestTemplate via host users-service + context path');
  });
  it('links Java service-to-service calls (RestTemplate, WebClient, absent generated client)', () => {
    assert.deepEqual(parties(seam(/^GET \/orders$/)!.handlers), ['orders-service:OrdersController.listOrdersForUser']);
    assert.deepEqual(parties(seam(/^GET \/orders\/\{id\}$/)!.handlers), ['orders-service:OrdersController.getOrder']);
    const inv = seam(/^POST \/invoices$/)!;
    assert.deepEqual(parties(inv.callers), ['users-service:OrdersClient.invoice']);
    assert.deepEqual(parties(inv.handlers), ['orders-service:InvoiceController.createInvoice']);
    assert.equal(inv.operationId, 'createInvoice');
  });
  it('links Kafka topics between producers and listeners', () => {
    const s = seam(/orders\.created/)!;
    assert.equal(s.kind, 'kafka');
    assert.deepEqual(parties(s.callers), ['orders-service:OrderService.place']);
    assert.deepEqual(parties(s.handlers), ['users-service:OrderEventsListener.onOrderCreated']);
  });
  it('reports unused endpoints and unhandled calls', () => {
    assert.equal(seam(/POST \/api\/orders/)?.status, 'no-caller');
    assert.equal(seam(/mailer\.example\.com/)?.status, 'no-handler');
  });
  it('links BFF-style calls to an engine whose application name differs from the host used in URLs', () => {
    // RestTemplate + unknown host (bpmn-engine vs spring.application.name workflow-engine) + gateway prefix /engine
    const start = seam(/POST .*bpmn-engine:8090\/engine\/runtime\/process-instances$/)!;
    assert.ok(start, 'seam for the RestTemplate call exists');
    assert.equal(start.status, 'linked');
    assert.deepEqual(parties(start.handlers), ['bpmn-engine:RuntimeController.startProcessInstance']);
    // WebClient.Builder receiver
    const status = seam(/GET .*process-instances\/\{id\}$/)!;
    assert.deepEqual(parties(status.callers), ['users-service:WorkflowClient.status']);
    assert.deepEqual(parties(status.handlers), ['bpmn-engine:RuntimeController.getProcessInstance']);
    // absent generated client, *WithHttpInfo variant, spec whose `openapi:` key is not first
    const complete = seam(/^POST \/runtime\/tasks\/\{id\}\/complete$/)!;
    assert.equal(complete.operationId, 'completeTask');
    assert.deepEqual(parties(complete.callers), ['users-service:WorkflowClient.completeTask']);
    assert.deepEqual(parties(complete.handlers), ['bpmn-engine:RuntimeController.completeTask']);
    const e = a.projectEdges.find((x) => x.from === 'users-service' && x.to === 'bpmn-engine' && x.kind === 'http');
    assert.equal(e?.count, 3);
  });
  it('explains unlinked calls', async () => {
    const { explainSeams } = await import('../src/workspace.js');
    const text = explainSeams(a);
    assert.match(text, /# Unlinked HTTP calls/);
    assert.match(text, /mailer\.example\.com -> not mapped to any project/);
    assert.match(text, /different HTTP method/);
  });
  it('aggregates project edges', () => {
    const e = (from: string, to: string, kind: string) => a.projectEdges.find((x) => x.from === from && x.to === to && x.kind === kind);
    assert.ok(e('web', 'users-service', 'http'));
    assert.ok(e('users-service', 'orders-service', 'http'));
    assert.ok(e('orders-service', 'users-service', 'kafka'));
    assert.ok(e('users-service', 'orders-service', 'kafka'));
  });
});
