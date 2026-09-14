# xsa — static analyzer for React / XState / Next.js and Java / Spring Boot

Builds a **function call graph** (across files, workspace packages and npm packages; Spring DI-aware for Java), extracts **XState machines** into a state tree and Mermaid diagrams, detects **external calls** (HTTP, gRPC, GraphQL, tRPC, WebSocket, DB, Kafka/RabbitMQ, Next.js server actions), and — across **several projects** — links callers to handlers through their **API definitions** (OpenAPI operations, routes, topics), producing a system view of who calls what. Everything lands in JSON, plus a self-contained interactive HTML report built on that JSON.

Runs on Node ≥ 18 (tested on Node 24) and Bun ≥ 1.4 (`bun src/cli.ts …` — no build step needed).

## Quick start

```bash
npm install
npm run build                      # -> dist/  (or skip and use `npx tsx src/cli.ts` / `bun src/cli.ts`)

node dist/cli.js analyze /path/to/monorepo -o ./xsa-out
#  xsa-out/analysis.json        full graph model (nodes, edges, machines, external calls, files, stats)
#  xsa-out/machines.json        XState machines only
#  xsa-out/external-calls.json  external calls only
#  xsa-out/report.html          interactive report (open in a browser)
#  xsa-out/report.md            summary with Mermaid diagrams (renders on GitHub)
#  xsa-out/callgraph.mmd        Mermaid flowchart of the call graph
#  xsa-out/machines/*.mmd       one Mermaid stateDiagram-v2 per machine
```

Try it on the bundled fixtures: `npm run analyze:demo` (a React/XState/Next.js monorepo) or `npm run analyze:workspace` (that frontend plus two Spring Boot services linked through their OpenAPI specs and Kafka topics), then open `examples/demo-out/report.html` / `examples/workspace-out/report.html`.

### Several projects at once (frontend + Spring services)

```bash
# side-by-side repos, described once (see xsa.workspace.schema.json):
cat xsa.workspace.json
# { "projects": [
#     { "name": "web",            "root": "../frontend",        "type": "ts" },
#     { "name": "users-service",  "root": "../users-service",   "type": "java", "hosts": ["api.example.com/v1"] },
#     { "name": "orders-service", "root": "../orders-service",  "type": "java" } ],
#   "openapi": ["../contracts"] }          # optional extra spec folder
xsa analyze --workspace xsa.workspace.json -o ./xsa-out
xsa analyze --project web=../frontend --project users=../users-service -o ./xsa-out   # or ad hoc
xsa seams --workspace xsa.workspace.json --unlinked      # endpoints nobody calls / calls nobody handles
```

A root containing `xsa.workspace.json` is picked up automatically. Node ids are prefixed with the project name (`users-service::src/main/java/...#UsersController.getUserById`); endpoint / topic nodes are shared, which is what makes the seams.

### Other commands

```bash
xsa machines <root>                       # Mermaid state diagrams to stdout (--json for models)
xsa external <root> -c http db            # list external calls (--json)
xsa graph <root> --focus fetchUser --depth 2   # Mermaid of a function's neighbourhood (--dot for Graphviz)
xsa graph <root> --focus UserCard --callees-only
```

Common options: `--ignore-packages react react-dom` (drop noisy edges), `--include-builtins` (keep `console.log`/`JSON.parse`… edges), `--include`/`--exclude` globs, `--tsconfig`, `--rules rules.json`, `-q`.

## What it understands

**Call graph**
- Resolves callees through the TypeScript type checker (`this.foo()`, `api.get()` on an `axios.create()` instance, class methods, re-exports, path aliases like `@/…`). When types are unavailable (untyped JS, package not installed) it falls back to import bindings and follows variable initializers (`const prisma = new PrismaClient()`).
- Monorepos: workspace packages (npm/yarn/pnpm workspaces, lerna) are discovered; each package is loaded with its own `tsconfig.json`, so per-package `paths` work. Cross-package calls resolve into the other package's *source*; if a package's `main` points at `dist/*.d.ts` the node is remapped to the source function.
- Node kinds: `function`, `method`, `component` (PascalCase + JSX), `hook` (`useX`), `module` (top-level code), `machine`, `package` (npm member, e.g. `axios.get`), `builtin`.
- Anonymous callbacks (`useEffect(() => …)`, `arr.map(x => …)`, `onClick={() => …}`) fold into the enclosing named function. Wrapped definitions keep their name (`const Foo = memo(() => …)`, `const cb = useCallback(…)`, `loadUser: fromPromise(…)`).
- Edge kinds: `calls`, `renders` (JSX), `uses-machine`, `defines` (the scope evaluating `createMachine` → machine), `invokes` (machine→machine), `implements` (machine→action/guard/actor fn), `external` (function → endpoint/DB/socket node), `server-action`, `http-route` (endpoint node → route handler).
- External calls are first-class **`external` nodes** in the graph — one per distinct target (`GET /users/{id}`, `prisma user.findMany`, `query GetProfile`, `trpc settings.get`, `WebSocket wss://…`). Calls from several functions to the same endpoint share the node; the raw `axios.get`-style package edge for that call site is dropped so the endpoint replaces it.

**Next.js**
- App router (`app/**/page|layout|route.tsx`), pages router (`pages/**`, `pages/api/**`), `middleware.ts`. Route handlers get `route` and `httpMethods`; pages get `route`.
- `'use client'` / `'use server'` boundaries; file-level and inline server actions. A client→server-action call becomes a `server-action` edge *and* an external call.
- `fetch('/api/users/${id}')` is linked to the matching route handler (`http-route` edge).

**XState (v5 first, v4 supported)**
- `setup({ actions, guards, actors, delays }).createMachine(cfg)`, `createMachine(cfg, options)`, `Machine(cfg, options)`, `.provide({...})`.
- State tree: `initial`, `states`, `type` (compound/parallel/final/history), `on`, `always`, `after`, `invoke` (`src`, `id`, `onDone`, `onError`, `onSnapshot`), `entry`/`exit`, `tags`, `description`. Guarded transition arrays, `reenter`/`internal`, `#id.path`, `.child` and sibling targets are resolved to full state paths.
- Action summaries: `assign(user, error)`, `sendTo(notifierRef, NOTIFY)`, `raise(X)`, `spawnChild(notifier)`, inline functions by name.
- Cross-references: `useMachine`/`useActor`/`useActorRef`/`createActor`/`interpret`/`createActorContext(m)` + `Ctx.useSelector()`, `invoke.src`/`spawnChild` pointing at another machine (through `setup({ actors })` or v4 `services`).
- Output: `MachineModel` JSON and a Mermaid `stateDiagram-v2` per machine (nested composites, parallel regions, notes for entry/exit/invoke/tags). Diagrams are validated against Mermaid's parser in the test suite.

**Java / Spring Boot** (pure-JS parser — no JDK needed; Maven or Gradle layouts, `src/main/java`, `src/test/java` with `--include-tests`)
- Classes, interfaces, records, enums; fields, methods, constructors; call chains with light type inference (declared field/param/local types, project method return types, `Optional`/`Mono`/`ResponseEntity` unwrapping, Lombok accessors, lambda parameters over collections).
- **Spring DI**: beans from `@Component/@Service/@Repository/@Controller/@RestController/@Configuration` and `@Bean` methods (including the concrete class a `@Bean` factory returns). A call through an interface resolves to its implementation bean — `@Primary` wins, `@Qualifier`/`@Resource(name)` select by bean name, `List<X>`/`Map<String,X>` injection fans out to every implementation (`via X (all)`), several candidates without a tie-breaker are kept and labelled `(ambiguous)`.
- **Configuration**: `application.yml`/`.properties` (+ `bootstrap.*`; profile documents are skipped) resolve `@Value("${…}")`, `@ConfigurationProperties` getters, `Environment.getProperty`, constructor-injected values and string concatenation / `String.format` / `UriComponentsBuilder` chains into concrete URLs and topic names. `spring.application.name`, `server.port` and `server.servlet.context-path` identify the service and prefix its routes.
- **Entry points**: `@RequestMapping`/`@GetMapping`… handlers (also mappings inherited from an implemented interface), controllers implementing an *absent* generated `XxxApi` (matched by operationId), `@KafkaListener`/`@RabbitListener`/`@JmsListener`/`@SqsListener` (topics resolved from properties, RabbitMQ `@QueueBinding` keys), `@Scheduled`, `@EventListener`, `main`.
- **Outbound**: `RestTemplate` (`getForObject`… `exchange(HttpMethod)`), `WebClient`/`RestClient` fluent chains (`get().uri(…)`, `uri(b -> b.path(…))`, `@Bean` `baseUrl`), `java.net.http` `HttpRequest`, OkHttp, OpenFeign interfaces, generated OpenAPI clients (`usersApi.getUserById()` — present or not), Spring Data repositories (entity from the generic argument), `JdbcTemplate`/`EntityManager`/Mongo/Redis/Elasticsearch, `KafkaTemplate`, `RabbitTemplate` (exchange/routing key), `JmsTemplate`, `StreamBridge`, SQS/SNS, gRPC stubs.

**Seams (multi-project)**
- Every endpoint/topic is one shared node; callers in any project attach to it. Handlers are found by operationId (spec-owning project and `servers` hosts preferred), by host → project (`hosts` in the workspace file, `spring.application.name`, `localhost:<server.port>`) plus route template with context path, or by topic/queue name (RabbitMQ binding keys with `*`/`#`).
- `analysis.seams` lists each seam with `callers`, `handlers` and a status — `linked`, `no-handler` (third-party or missing implementation), `no-caller` (unused endpoint/listener), `ambiguous` (several projects match without a host hint); `analysis.projectEdges` aggregates them per project pair. The HTML report shows them as a **Projects** system diagram (click an edge for its seams) and a filterable **Seams** table; the Markdown report includes a Mermaid project-dependency graph.

**External calls** (rule-driven, see `src/rules.ts`)
- HTTP: `fetch`, `axios` (+ instances with `baseURL`), `ky`, `got`, `superagent`, `XMLHttpRequest`, `sendBeacon`, `EventSource`.
- gRPC: `@grpc/grpc-js`, Connect (`createClient`/`createPromiseClient`), `nice-grpc`, `grpc-web`, plus a generic rule for generated stubs (`*_pb`, `*_grpc_pb`, `*_connect` receiver types).
- GraphQL: Apollo, urql, graphql-request, Relay (operation type + name extracted from `gql` templates). tRPC (`trpc.a.b.useQuery` → `a.b`).
- WebSockets: `WebSocket`, `ws`, socket.io, Pusher, Ably. DB/BaaS: Prisma, Drizzle, Mongoose, pg/mysql/sqlite, knex, Supabase, Firebase, Redis, MongoDB. Messaging/SDKs: AWS SDK, KafkaJS, amqplib, Stripe, OpenAI/AI SDK.
- URLs are extracted from literals, templates (`/users/${id}` → `/users/{id}`), concatenations and constants.

**OpenAPI-generated clients/servers — even when the generated code is absent**
- Specs (`openapi.*`, `swagger.*`, or any JSON/YAML starting with `openapi:`/`swagger:`) are auto-discovered (`--openapi a.yaml b.json` to pin, `--openapi none` to disable) and indexed by `operationId`.
- A call whose method/function name matches an operationId through an unresolved or generated-looking import (`usersApi.getUserById()`, orval's `listUsers()`, hey-api's `UsersService.createUser()`, NestJS `UsersController_deleteUser` → `usersControllerDeleteUser`) becomes an `http` external call with the spec's method + path. `openapi-fetch` / `@hey-api/client-*` calls carry literal paths and are matched too.
- Any HTTP call (`fetch`, `axios`…) whose URL matches an operation (honouring `servers` base URLs and `{param}` templates) is attributed to the same operation node, so hand-written and generated clients converge.
- Server side: exported functions named after an operationId with a server-style signature (`(req, res)`, `ctx`, `event`, destructured `{ params, body }`), or in files matched by `--openapi-handlers <globs>`, are tagged `openapi:operation` entry points with the route, and endpoint nodes link to them (`http-route`). Operations with their callers and handlers are listed in the JSON (`analysis.openapi`), the HTML overview and the Markdown report.

Add your own with `--rules`: a JSON array (merged before the defaults) or `{ "replace": true, "rules": [...] }`. See `xsa.rules.example.json`. A rule matches on any of `packages` (glob `@scope/*`), `globals`, `importModule` (regex on the module the callee/receiver was imported from — works for missing generated modules), `receiverType`/`receiverTypeFile` (regex), `callee` (regex on the call text), `isConstructor`; `extract` picks how target/method are derived (`http`, `axios-style`, `rpc`, `graphql`, `orm`, `ws`, `openapi`, `none`).

## HTML report

`report.html` embeds the analysis JSON (same shape as `analysis.json`) and loads Cytoscape, dagre and Mermaid from CDNs.

- **Call graph**: search, click a node for details (file:line with `vscode://` links, badges for entry/boundary, external calls, in/out edges), *Focus* (neighbourhood with adjustable depth), *Trace callers / callees* (transitive), filters by node kind / edge kind / package, "collapse packages", several layouts. External endpoint nodes are coloured by category (http / db / graphql / …) and show their call sites. Graphs over 400 nodes start empty — search and focus, or click "Show whole graph".
- **Large graphs** (thousands of nodes): the page renders at most *Max nodes* (default 1500, adjustable) nearest to the focus, picks the layout automatically (dagre up to 400 nodes, breadth-first above — dagre is never run on thousands of nodes), switches to compact node rendering, and hides package/builtin members by default above 1500 nodes. Cytoscape and Mermaid are loaded only when the Graph / Machines tabs are opened, so Overview, Seams and External calls appear immediately.
- `--offline` inlines cytoscape, dagre and mermaid into `report.html` (they are optional dependencies; if missing, `npm i cytoscape cytoscape-dagre dagre mermaid`) so the report needs no network at all (+~3 MB).
- The embedded data is `analysis.json` minus `files`, with edges stored as index tuples; `window.xsa.data` has the normal shape again after load. `window.xsa` exposes `{ data, showTab, focusNode, selectMachine, getCy, getProjectsCy, lib }` for scripting the page.
- **Machines**: rendered state diagram, implementations (linked to their graph nodes), used-by / invokes, events, and a collapsible state tree. "Copy Mermaid" for pasting into docs.
- **External calls**: sortable, filterable table by category chips and free text, with links to the calling function.

## Programmatic use

```ts
import { analyze, stateDiagram, subgraph, callGraphFlowchart } from 'xstate-analyzer';

const a = analyze({ root: '/path/to/repo', ignorePackages: ['react'] });
for (const m of a.machines) console.log(stateDiagram(m, { direction: 'LR' }));
const around = subgraph(a, 'checkoutMachine', 2);
console.log(callGraphFlowchart(a, { nodeIds: around }));
```

`Analysis` (see `src/model.ts`): `nodes: GraphNode[]`, `edges: GraphEdge[]`, `machines: MachineModel[]`, `externalCalls: ExternalCall[]`, `files: FileInfo[]`, `packages`, `stats`, `warnings`. Node ids are stable: `<relative file>#<Qualified.name>`, `pkg:<package>#<Member>`, `machine:<file>#<name>`.

## Limitations

- Static only: dynamic dispatch (`props.onClick()`, callbacks passed as parameters, `obj[key]()`) is counted in `stats.unresolvedCalls` rather than guessed.
- Java resolution is name-based (no compiler): calls on receivers whose type cannot be inferred (raw generics, untyped lambda parameters outside collections, reflection, AOP proxies) are unresolved; library return types are only known for common wrappers. Kotlin is not parsed.
- Spring: bean selection follows `@Primary`/`@Qualifier`/collection rules; `@Profile`/`@Conditional*` beans are not excluded, and `application-<profile>.*` files are listed but not merged.
- Machine configs must be object literals (or constants / spreads that resolve to them); configs built by arbitrary functions produce a warning.
- Type-driven resolution is only as good as the types available; run `npm install` in the analyzed repo for best results.

## Development

```bash
npm test              # node --test: 57 assertions over examples/demo (TS) and examples/services + xsa.workspace.json (Java, seams)
npm run test:render   # opens examples/demo-out/report.html in Edge/Chrome (puppeteer-core) and renders every diagram + the graph
npm run test:all      # both, regenerating the demo output in between
npm run dev -- analyze examples/demo -o examples/demo-out
```

`test:render` exists because Mermaid's parser accepts things its renderer rejects (e.g. a state literally named `root`, which Mermaid reserves — the first version of this tool hit exactly that).
