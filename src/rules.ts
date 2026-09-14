import type { ExternalRule } from './model.js';

/**
 * Built-in detection rules for calls that leave the process (HTTP, RPC,
 * GraphQL, DB, sockets). Users can extend or replace these with
 * `--rules rules.json`. Rules are tested in order; the first match wins.
 */
export const DEFAULT_RULES: ExternalRule[] = [
  /* ---- HTTP ---- */
  { name: 'fetch', category: 'http', protocol: 'fetch', globals: ['fetch'], extract: 'http' },
  { name: 'node-fetch', category: 'http', protocol: 'fetch', packages: ['node-fetch', 'cross-fetch', 'isomorphic-fetch', 'isomorphic-unfetch', 'undici'], callee: '^(fetch|request|default)$', extract: 'http' },
  { name: 'axios', category: 'http', protocol: 'axios', packages: ['axios'], callee: '(^|\\.)(get|post|put|patch|delete|head|options|request)$|^axios$', extract: 'axios-style' },
  { name: 'ky', category: 'http', protocol: 'ky', packages: ['ky', 'ky-universal'], callee: '(^|\\.)(get|post|put|patch|delete|head)$|^ky$', extract: 'axios-style' },
  { name: 'got', category: 'http', protocol: 'got', packages: ['got'], extract: 'axios-style' },
  { name: 'superagent', category: 'http', protocol: 'superagent', packages: ['superagent'], callee: '(^|\\.)(get|post|put|patch|delete|head)$', extract: 'axios-style' },
  { name: 'xhr', category: 'http', protocol: 'XMLHttpRequest', globals: ['XMLHttpRequest'], isConstructor: true, extract: 'none' },
  { name: 'beacon', category: 'http', protocol: 'sendBeacon', callee: '^navigator\\.sendBeacon$', extract: 'http' },
  { name: 'eventsource', category: 'http', protocol: 'EventSource', globals: ['EventSource'], isConstructor: true, extract: 'ws' },

  { name: 'openapi-fetch', category: 'http', protocol: 'openapi-fetch', packages: ['openapi-fetch', 'openapi-react-query'], callee: '\\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|useQuery|useMutation)$', extract: 'axios-style' },
  { name: 'hey-api-client', category: 'http', protocol: '@hey-api/client', packages: ['@hey-api/*'], callee: '\\.(get|post|put|patch|delete|head|options|request)$', extract: 'axios-style' },
  // Clients generated from an OpenAPI spec (openapi-generator, orval, hey-api services, swagger-typescript-api...): the generated
  // module may be absent; the method name is matched against operationIds of specs found in the repo.
  { name: 'openapi-generated-client', category: 'http', protocol: 'openapi-client', importModule: '(generated|__generated__|openapi|swagger|api-client|apiClient|\\.gen(erated)?(\\.[cm]?[jt]sx?)?$)', callee: '\\.\\w+$', extract: 'openapi' },

  /* ---- Next.js server actions are detected structurally (see analyzers/next.ts) ---- */

  /* ---- gRPC ---- */
  { name: 'grpc-js-client', category: 'grpc', protocol: '@grpc/grpc-js', packages: ['@grpc/grpc-js', 'grpc'], callee: '^new\\s|Client$', isConstructor: true, extract: 'rpc' },
  { name: 'grpc-js', category: 'grpc', protocol: '@grpc/grpc-js', packages: ['@grpc/grpc-js', 'grpc'], extract: 'rpc' },
  { name: 'connect', category: 'grpc', protocol: 'connect-es', packages: ['@connectrpc/*', '@bufbuild/connect*'], callee: 'createClient|createPromiseClient|createCallbackClient', extract: 'rpc' },
  { name: 'nice-grpc', category: 'grpc', protocol: 'nice-grpc', packages: ['nice-grpc', 'nice-grpc-web'], extract: 'rpc' },
  { name: 'grpc-web', category: 'grpc', protocol: 'grpc-web', packages: ['grpc-web', '@improbable-eng/grpc-web'], extract: 'rpc' },
  // Generated stubs: any method call on a receiver whose type is declared in a *_pb / *_grpc_pb / *_connect file
  { name: 'grpc-generated-stub', category: 'grpc', protocol: 'grpc', receiverTypeFile: '(_grpc_pb|_pb|_connect|\\.grpc|ServiceClientPb)\\.(d\\.ts|ts|js)$', receiverType: '(Client|Service)$', extract: 'rpc' },

  /* ---- GraphQL ---- */
  { name: 'apollo', category: 'graphql', protocol: '@apollo/client', packages: ['@apollo/client', '@apollo/*'], callee: '^(useQuery|useMutation|useLazyQuery|useSubscription|useSuspenseQuery|useBackgroundQuery)$|\\.(query|mutate|subscribe|watchQuery)$', extract: 'graphql' },
  { name: 'urql', category: 'graphql', protocol: 'urql', packages: ['urql', '@urql/*'], callee: '^(useQuery|useMutation|useSubscription)$|\\.(query|mutation|subscription|executeQuery)$', extract: 'graphql' },
  { name: 'graphql-request', category: 'graphql', protocol: 'graphql-request', packages: ['graphql-request'], callee: '^request$|\\.(request|rawRequest|batchRequests)$', extract: 'graphql' },
  { name: 'relay', category: 'graphql', protocol: 'relay', packages: ['react-relay', 'relay-runtime'], callee: '^(useLazyLoadQuery|useMutation|usePreloadedQuery|fetchQuery|commitMutation|useFragment)$', extract: 'graphql' },

  /* ---- tRPC ---- */
  { name: 'trpc', category: 'trpc', protocol: '@trpc', packages: ['@trpc/*'], callee: '\\.(useQuery|useMutation|useInfiniteQuery|useSubscription|query|mutate|mutation|subscribe|fetch|prefetch)$', extract: 'rpc' },

  /* ---- WebSockets / realtime ---- */
  { name: 'websocket', category: 'websocket', protocol: 'WebSocket', globals: ['WebSocket'], isConstructor: true, extract: 'ws' },
  { name: 'ws', category: 'websocket', protocol: 'ws', packages: ['ws', 'isomorphic-ws'], isConstructor: true, extract: 'ws' },
  { name: 'socket.io', category: 'websocket', protocol: 'socket.io', packages: ['socket.io-client'], callee: '^io$|\\.(emit|connect)$', extract: 'ws' },
  { name: 'pusher', category: 'websocket', protocol: 'pusher', packages: ['pusher-js', 'pusher'], isConstructor: true, extract: 'ws' },
  { name: 'ably', category: 'websocket', protocol: 'ably', packages: ['ably'], callee: '\\.(publish|subscribe)$', extract: 'ws' },

  /* ---- Databases / ORMs / BaaS ---- */
  { name: 'prisma', category: 'db', protocol: 'prisma', packages: ['@prisma/client', '.prisma/*'], callee: '\\.(findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy|\\$queryRaw|\\$executeRaw|\\$transaction)$', extract: 'orm' },
  { name: 'drizzle', category: 'db', protocol: 'drizzle', packages: ['drizzle-orm', 'drizzle-orm/*'], callee: '\\.(select|insert|update|delete|execute|query|transaction)$', extract: 'orm' },
  { name: 'mongoose', category: 'db', protocol: 'mongoose', packages: ['mongoose'], callee: '\\.(find|findOne|findById|create|updateOne|updateMany|deleteOne|deleteMany|aggregate|save|findOneAndUpdate|findByIdAndUpdate|countDocuments)$', extract: 'orm' },
  { name: 'pg', category: 'db', protocol: 'pg', packages: ['pg', 'postgres', 'mysql2', 'mysql', 'better-sqlite3', 'sqlite3'], callee: '\\.(query|execute|prepare|run|all|get)$|^sql$', extract: 'orm' },
  { name: 'knex', category: 'db', protocol: 'knex', packages: ['knex'], extract: 'orm' },
  { name: 'supabase', category: 'db', protocol: 'supabase', packages: ['@supabase/*'], callee: '\\.(from|rpc|auth|storage|channel)$', extract: 'orm' },
  { name: 'firebase', category: 'db', protocol: 'firebase', packages: ['firebase', 'firebase/*', 'firebase-admin', '@firebase/*'], callee: '^(getDoc|getDocs|setDoc|addDoc|updateDoc|deleteDoc|onSnapshot|runTransaction|signInWithPopup|signInWithEmailAndPassword|httpsCallable)$', extract: 'orm' },
  { name: 'redis', category: 'db', protocol: 'redis', packages: ['redis', 'ioredis', '@upstash/redis'], callee: '\\.(get|set|del|hget|hset|incr|expire|publish|subscribe|lpush|rpush|sadd|zadd)$', extract: 'orm' },
  { name: 'mongodb', category: 'db', protocol: 'mongodb', packages: ['mongodb'], callee: '\\.(find|findOne|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|aggregate|countDocuments)$', extract: 'orm' },

  /* ---- Messaging / queues / cloud SDKs ---- */
  { name: 'aws-sdk', category: 'messaging', protocol: 'aws-sdk', packages: ['@aws-sdk/*', 'aws-sdk'], callee: '\\.send$|Command$', extract: 'rpc' },
  { name: 'kafka', category: 'messaging', protocol: 'kafka', packages: ['kafkajs'], callee: '\\.(send|sendBatch|subscribe|run)$', extract: 'rpc' },
  { name: 'amqp', category: 'messaging', protocol: 'amqp', packages: ['amqplib'], callee: '\\.(publish|sendToQueue|consume)$', extract: 'rpc' },
  { name: 'stripe', category: 'other', protocol: 'stripe', packages: ['stripe', '@stripe/*'], callee: '\\.(create|retrieve|update|list|del|confirm|cancel|capture)$', extract: 'rpc' },
  { name: 'openai', category: 'other', protocol: 'openai', packages: ['openai', '@anthropic-ai/*', '@google/generative-ai', 'ai', '@ai-sdk/*'], callee: '\\.(create|generateText|streamText|generateObject|streamObject|embed)$|^(generateText|streamText|generateObject|streamObject|embed)$', extract: 'rpc' },
];

/** Glob-ish package matcher: `@scope/*`, `firebase/*`, exact names */
export function packageMatches(pkg: string | undefined, patterns: string[] | undefined): boolean {
  if (!pkg || !patterns) return false;
  return patterns.some((p) => {
    if (p === pkg) return true;
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -2);
      return pkg === prefix || pkg.startsWith(prefix + '/');
    }
    if (p.endsWith('*')) return pkg.startsWith(p.slice(0, -1));
    return false;
  });
}
