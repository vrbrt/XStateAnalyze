/**
 * Graph model produced by the analyzer. Everything in the JSON output is
 * described here; the HTML report, Mermaid and DOT writers consume this.
 */

export type NodeKind =
  | 'function'   // plain function / arrow / method
  | 'component'  // React component (PascalCase + JSX)
  | 'hook'       // React hook (useXxx)
  | 'method'     // class method
  | 'module'     // top-level scope of a file (module-level calls)
  | 'package'    // a member of an external npm package
  | 'builtin'    // global / TS lib symbol (fetch, setTimeout, ...)
  | 'machine'    // an XState machine definition
  | 'external';  // a remote target: HTTP endpoint, RPC method, GraphQL operation, DB model, socket

export type EntryKind =
  | 'next:page'
  | 'next:layout'
  | 'next:route'
  | 'next:api'
  | 'next:middleware'
  | 'next:server-action'
  | 'next:data-fn'  // getServerSideProps / getStaticProps
  | 'openapi:operation' // server handler named after an OpenAPI operationId
  | 'spring:endpoint'   // @RestController / @Controller handler method
  | 'spring:listener'   // @KafkaListener / @RabbitListener / @JmsListener / @SqsListener
  | 'spring:scheduled'  // @Scheduled
  | 'spring:event'      // @EventListener / @TransactionalEventListener
  | 'main'              // public static void main
  | 'export';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Display name, e.g. `App.handleClick`, `axios.get`, `fetchUserMachine` */
  name: string;
  /** Project-relative file path for internal nodes; package name for package nodes */
  file: string;
  /** Workspace package (monorepo) or npm package the node belongs to */
  package?: string;
  line?: number;
  endLine?: number;
  internal: boolean;
  exported?: boolean;
  async?: boolean;
  entry?: EntryKind;
  /** Route path for Next.js pages/routes, e.g. `/api/users/[id]` */
  route?: string;
  /** HTTP verbs exported by a route handler, or the verb of a route function */
  httpMethods?: string[];
  /** 'use client' / 'use server' boundary of the file the node lives in */
  boundary?: 'client' | 'server';
  tags?: string[];
  /** Parameter names (functions only) */
  params?: string[];
  /** OpenAPI operationId this node implements (entry 'openapi:operation') */
  operationId?: string;
  /** Project this node belongs to (multi-project analyses) */
  project?: string;
  /** Topics / queues a listener consumes (entry 'spring:listener') */
  topics?: string[];
  /** Java: fully-qualified class name of the declaring type */
  className?: string;
  /** For kind 'external': what the node stands for (aggregated over all call sites hitting it) */
  external?: { category: ExternalCategory; protocol: string; method?: string; target?: string; service?: string; calls: number };
}

export type EdgeKind =
  | 'calls'          // function -> function
  | 'renders'        // component -> component (JSX)
  | 'uses-machine'   // function/component -> machine (useMachine, createActor, ...)
  | 'invokes'        // machine -> machine (invoke.src / spawn)
  | 'implements'     // machine -> function (action/guard/actor implementation)
  | 'server-action'  // client function -> 'use server' function
  | 'defines'        // module/function that evaluates createMachine(...) -> machine
  | 'external'       // function -> external node (HTTP endpoint, DB model, ...)
  | 'http-route'     // external HTTP node -> matching route handler (Next.js route, Spring endpoint, OpenAPI handler)
  | 'message-route'; // external topic/queue node -> listener consuming it

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** number of call sites collapsed into this edge */
  count: number;
  /** first call-site line */
  line?: number;
  label?: string;
}

export type ExternalCategory =
  | 'http'
  | 'grpc'
  | 'graphql'
  | 'trpc'
  | 'websocket'
  | 'db'
  | 'server-action'
  | 'messaging'
  | 'other';

export interface ExternalCall {
  id: string;
  category: ExternalCategory;
  /** Library / transport, e.g. `fetch`, `axios`, `@grpc/grpc-js`, `prisma` */
  protocol: string;
  /** Callee text as written, e.g. `api.get`, `client.getUser` */
  callee: string;
  /** URL / RPC / query / model - whatever best identifies the remote target */
  target?: string;
  /** HTTP verb, RPC name, GraphQL operation type... */
  method?: string;
  /** Service or client type for RPC-style calls */
  service?: string;
  file: string;
  line: number;
  /** id of the enclosing GraphNode */
  caller: string;
  package?: string;
  project?: string;
  /** Matched rule name */
  rule: string;
  /** GraphNode id (kind 'external') this call is attached to */
  node?: string;
  /** OpenAPI operationId when the call was matched against a spec */
  operationId?: string;
}

/* ---------- OpenAPI ---------- */

export interface OpenApiOperation {
  operationId: string;
  /** false when the id was synthesized from method + path */
  explicitId: boolean;
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  /** spec file (root-relative) */
  spec: string;
  /** project owning the spec (multi-project analyses) */
  project?: string;
  servers: string[];
  /** GraphNode ids of functions calling this operation (filled by the analyzer) */
  callers?: string[];
  /** GraphNode ids of server handlers implementing it (filled by the analyzer) */
  handlers?: string[];
}

export interface OpenApiSpecInfo {
  file: string;
  project?: string;
  title?: string;
  version?: string;
  operations: number;
}

/* ---------- XState ---------- */

export interface TransitionModel {
  /** Event name; '' for eventless (always), 'done'/'error' for invoke results */
  event: string;
  kind: 'on' | 'always' | 'after' | 'onDone' | 'onError' | 'onSnapshot';
  /** Fully-resolved target state paths (dot paths from the root). Empty = targetless */
  targets: string[];
  /** Raw target strings as written */
  rawTargets: string[];
  guard?: string;
  actions: string[];
  delay?: string;
  reenter?: boolean;
  description?: string;
}

export interface InvokeModel {
  src: string;
  id?: string;
  /** node id of a machine this invoke resolves to (when src is a machine) */
  machineRef?: string;
  onDone: TransitionModel[];
  onError: TransitionModel[];
  onSnapshot: TransitionModel[];
}

export interface StateNodeModel {
  key: string;
  /** dot-separated path from root, '' for root */
  path: string;
  /** explicit id: if set */
  id?: string;
  type: 'atomic' | 'compound' | 'parallel' | 'final' | 'history';
  initial?: string;
  history?: 'shallow' | 'deep';
  entry: string[];
  exit: string[];
  invoke: InvokeModel[];
  transitions: TransitionModel[];
  states: StateNodeModel[];
  tags: string[];
  description?: string;
  meta?: Record<string, unknown>;
}

export interface MachineImplementations {
  actions: string[];
  guards: string[];
  actors: string[];
  delays: string[];
}

export interface MachineModel {
  /** GraphNode id of the machine */
  id: string;
  name: string;
  /** id: from the machine config, if any */
  machineId?: string;
  file: string;
  line: number;
  version: 4 | 5;
  api: 'createMachine' | 'setup().createMachine' | 'Machine';
  root: StateNodeModel;
  /** Names declared in setup({...}) / second createMachine arg / .provide({...}) */
  implementations: MachineImplementations;
  /** GraphNode ids of implementation functions found in the source, keyed by `actions.name` etc. */
  implementationNodes: Record<string, string>;
  /** All event names referenced by the machine */
  events: string[];
  /** GraphNode ids of functions/components that use the machine */
  usedBy: string[];
  /** GraphNode ids of machines this machine invokes/spawns */
  invokes: string[];
  /** Mermaid stateDiagram-v2 source */
  mermaid: string;
}

/* ---------- Top level ---------- */

export interface FileInfo {
  path: string;
  project?: string;
  language?: 'ts' | 'java';
  package?: string;
  boundary?: 'client' | 'server';
  route?: string;
  entry?: EntryKind;
  imports: { module: string; names: string[]; resolvedPackage?: string; internal: boolean }[];
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  files: number;
}

export interface AnalysisStats {
  files: number;
  functions: number;
  components: number;
  hooks: number;
  edges: number;
  machines: number;
  externalCalls: number;
  unresolvedCalls: number;
  durationMs: number;
}

export interface ProjectInfo {
  name: string;
  root: string;
  language: 'ts' | 'java' | 'mixed';
  /** spring.application.name (Java) or package name (TS) */
  serviceName?: string;
  /** server.servlet.context-path prefix applied to Spring routes */
  contextPath?: string;
  port?: string;
  /** Host names / base URLs that identify this project as the target of a call (config + inferred) */
  hosts: string[];
  files: number;
  /** application property files that were read (Java) */
  propertyFiles?: string[];
  warnings?: number;
}

export type SeamKind = 'http' | 'kafka' | 'rabbit' | 'jms' | 'sqs' | 'grpc' | 'server-action';

export interface SeamParty {
  project?: string;
  node: string;
  line?: number;
}

/** An API-level connection between projects: one endpoint / operation / topic, with everyone calling and implementing it. */
export interface Seam {
  id: string;
  kind: SeamKind;
  label: string;
  method?: string;
  /** path (http) or topic / queue (messaging) */
  target?: string;
  operationId?: string;
  spec?: string;
  /** external GraphNode standing for the target, when some caller exists */
  node?: string;
  callers: SeamParty[];
  handlers: SeamParty[];
  status: 'linked' | 'no-handler' | 'no-caller' | 'ambiguous';
}

export interface ProjectEdge {
  from: string; // project name, or '(external)' for unlinked calls
  to: string;   // project name, or '(unhandled)'
  kind: SeamKind;
  seams: string[];
  count: number;
}

export interface Analysis {
  version: string;
  generatedAt: string;
  root: string;
  /** Projects in the analysis (one for a single root) */
  projects: ProjectInfo[];
  /** API seams between projects (multi-project) or between callers and handlers (single project) */
  seams: Seam[];
  projectEdges: ProjectEdge[];
  packages: WorkspacePackage[];
  files: FileInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  externalCalls: ExternalCall[];
  machines: MachineModel[];
  openapi: { specs: OpenApiSpecInfo[]; operations: OpenApiOperation[] };
  stats: AnalysisStats;
  warnings: string[];
}

export interface AnalyzerOptions {
  root: string;
  /** Project name (multi-project analyses); defaults to the root's package / directory name */
  project?: string;
  /** Force the language instead of auto-detecting from package.json / pom.xml / build.gradle */
  language?: 'ts' | 'java';
  /** Host names / base URLs that identify this project as a call target (e.g. `users-service`, `api.example.com/v1`) */
  hosts?: string[];
  /** Include src/test/java (Java) */
  includeTests?: boolean;
  tsconfig?: string;
  include?: string[];
  exclude?: string[];
  /** Include calls to TS lib / global builtins (console.log, JSON.parse ...) in the graph */
  includeBuiltins?: boolean;
  /** Package names (or globs) whose call edges are dropped from the graph (they still count for external-call rules) */
  ignorePackages?: string[];
  /** Extra external-call rules (merged with the defaults) */
  rules?: ExternalRule[];
  /** Replace instead of merge the default rules */
  replaceRules?: boolean;
  /** OpenAPI / Swagger documents to index (default: discovered in the repo). Pass [] to disable. */
  openapi?: string[];
  /** Globs of files whose exported functions may be treated as OpenAPI operation handlers (default: heuristic on path / parameter names) */
  openapiHandlers?: string[];
  onProgress?: (msg: string) => void;
}

/* ---------- External-call rules ---------- */

export interface ExternalRule {
  name: string;
  category: ExternalCategory;
  protocol: string;
  /** Match when the callee resolves into one of these npm packages (exact or glob like `@grpc/*`) */
  packages?: string[];
  /** Match global callees by name (`fetch`, `WebSocket`) */
  globals?: string[];
  /** Regex source tested against the callee text (`axios.get`, `client.getUser`) */
  callee?: string;
  /** Regex tested against the file path of the receiver's type declaration (for generated clients) */
  receiverTypeFile?: string;
  /** Regex tested against the receiver's type name (`UserServiceClient`) */
  receiverType?: string;
  /** Match `new X()` expressions instead of calls */
  isConstructor?: boolean;
  /** Regex tested against the module specifier the callee (or its receiver's initializer) was imported from, e.g. `generated|\.gen$` */
  importModule?: string;
  /** How to extract target/method details from the call site; `openapi` resolves the method name against indexed specs */
  extract?: 'http' | 'axios-style' | 'rpc' | 'graphql' | 'orm' | 'ws' | 'openapi' | 'none';
}
