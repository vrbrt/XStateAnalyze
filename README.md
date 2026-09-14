# xsa — static analyzer for React / XState / Next.js

Builds a **function call graph** (across files, workspace packages and npm packages), extracts **XState machines** into a state tree and Mermaid diagrams, and detects **external calls** (HTTP, gRPC, GraphQL, tRPC, WebSocket, DB, Next.js server actions). Everything lands in JSON, plus a self-contained interactive HTML report built on that JSON.

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

Try it on the bundled fixture: `npm run analyze:demo` then open `examples/demo-out/report.html`.

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
- `window.xsa` exposes `{ data, showTab, focusNode, selectMachine, getCy }` for scripting the page.
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
- Machine configs must be object literals (or constants / spreads that resolve to them); configs built by arbitrary functions produce a warning.
- Type-driven resolution is only as good as the types available; run `npm install` in the analyzed repo for best results.

## Development

```bash
npm test              # node --test over examples/demo (40 assertions: graph, Next.js, XState, external calls, OpenAPI)
npm run test:render   # opens examples/demo-out/report.html in Edge/Chrome (puppeteer-core) and renders every diagram + the graph
npm run test:all      # both, regenerating the demo output in between
npm run dev -- analyze examples/demo -o examples/demo-out
```

`test:render` exists because Mermaid's parser accepts things its renderer rejects (e.g. a state literally named `root`, which Mermaid reserves — the first version of this tool hit exactly that).
