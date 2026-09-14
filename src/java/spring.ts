import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { normalize } from '../project.js';
import type { JAnnotation, JMethod, JType } from './model.js';

/* ---------- application properties ---------- */

/** Flattened Spring configuration with relaxed-binding lookup and `${key:default}` resolution. */
export class SpringProps {
  private values = new Map<string, string>(); // normalized key -> value
  readonly files: string[] = [];
  readonly profileFiles: string[] = [];

  static normalizeKey(k: string): string {
    return k.toLowerCase().replace(/[-_]/g, '').replace(/\[(\d+)\]/g, '.$1');
  }

  set(key: string, value: unknown) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      this.values.set(SpringProps.normalizeKey(key), value.map(String).join(','));
      value.forEach((v, i) => this.set(`${key}[${i}]`, v));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) this.set(key ? `${key}.${k}` : k, v);
      return;
    }
    this.values.set(SpringProps.normalizeKey(key), String(value));
  }

  get(key: string): string | undefined {
    return this.values.get(SpringProps.normalizeKey(key));
  }

  get size() {
    return this.values.size;
  }

  /** Resolve `${a.b:default}` placeholders (recursively, bounded). Unknown keys stay as `{a.b}`. */
  resolve(s: string | undefined, depth = 0): string | undefined {
    if (s === undefined) return undefined;
    if (depth > 5 || !s.includes('${')) return s;
    return s.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_m, key: string, def: string | undefined) => {
      const v = this.get(key.trim());
      if (v !== undefined) return this.resolve(v, depth + 1) ?? v;
      if (def !== undefined) return this.resolve(def, depth + 1) ?? def;
      return `{${key.trim()}}`;
    });
  }
}

function isPropsFile(name: string): { profile?: string } | undefined {
  const m = name.match(/^(application|bootstrap)(?:-([\w.]+))?\.(ya?ml|properties)$/);
  if (!m) return undefined;
  return { profile: m[2] };
}

/** Load application*.yml/properties under every src/main/resources of a project. Profile files are recorded, not merged. */
export function loadSpringProps(projectRoot: string, exclude: RegExp[] = []): SpringProps {
  const props = new SpringProps();
  const files: { file: string; profile?: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
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
        if (/^(node_modules|target|build|\.git|\.idea|out|bin|test)$/.test(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && normalize(full).includes('/src/main/resources/')) {
        const info = isPropsFile(e.name);
        if (info) files.push({ file: full, profile: info.profile });
      }
    }
  };
  walk(projectRoot, 0);
  // bootstrap first, then application; profile-less only
  files.sort((a, b) => (a.file.includes('bootstrap') ? -1 : 0) - (b.file.includes('bootstrap') ? -1 : 0));
  for (const f of files) {
    if (f.profile) {
      props.profileFiles.push(normalize(path.relative(projectRoot, f.file)));
      continue;
    }
    props.files.push(normalize(path.relative(projectRoot, f.file)));
    const text = fs.readFileSync(f.file, 'utf8');
    if (f.file.endsWith('.properties')) {
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const idx = line.search(/[=:]/);
        if (idx < 0) continue;
        props.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      }
    } else {
      try {
        for (const doc of YAML.parseAllDocuments(text)) {
          const obj = doc.toJS();
          if (!obj || typeof obj !== 'object') continue;
          const activate = (obj as any)?.spring?.config?.activate?.['on-profile'] ?? (obj as any)?.spring?.profiles;
          if (activate) continue; // profile-specific document
          props.set('', obj);
        }
      } catch {
        /* ignore malformed yaml */
      }
    }
  }
  return props;
}

/* ---------- annotations ---------- */

export function ann(list: JAnnotation[], ...names: string[]): JAnnotation | undefined {
  return list.find((a) => names.includes(a.name));
}

export function annValue(a: JAnnotation | undefined, ...keys: string[]): string[] {
  if (!a) return [];
  for (const k of keys) {
    const v = a.args[k];
    if (v === undefined) continue;
    return Array.isArray(v) ? v : [v];
  }
  return [];
}

export const STEREOTYPES = ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'ControllerAdvice', 'RestControllerAdvice', 'SpringBootApplication', 'Endpoint', 'MessageEndpoint'];
export const INJECT_ANNOTATIONS = ['Autowired', 'Inject', 'Resource', 'Value'];

export function isBeanClass(t: JType): boolean {
  return t.annotations.some((a) => STEREOTYPES.includes(a.name));
}

const MAPPINGS: Record<string, string[] | undefined> = {
  GetMapping: ['GET'],
  PostMapping: ['POST'],
  PutMapping: ['PUT'],
  DeleteMapping: ['DELETE'],
  PatchMapping: ['PATCH'],
  RequestMapping: undefined, // from `method`
  // Spring WebFlux functional & JAX-RS
  GET: ['GET'],
  POST: ['POST'],
  PUT: ['PUT'],
  DELETE: ['DELETE'],
  PATCH: ['PATCH'],
  HEAD: ['HEAD'],
  OPTIONS: ['OPTIONS'],
};
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function joinPath(...parts: (string | undefined)[]): string {
  const p = '/' + parts.filter((x): x is string => !!x).map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return p.replace(/\{([^}:]+):[^}]*\}/g, '{$1}').replace(/\/+/g, '/');
}

/** Paths declared by a mapping annotation (`value` / `path`), '' when none. */
export function mappingPaths(list: JAnnotation[]): string[] {
  const a = list.find((x) => x.name in MAPPINGS || x.name === 'Path');
  if (!a) return [];
  const v = annValue(a, 'value', 'path');
  return v.length ? v : [''];
}

/** HTTP method(s) + paths of a handler method annotation set, undefined when not a mapping. */
export function methodMapping(m: JMethod, props?: SpringProps): { methods: string[]; paths: string[] } | undefined {
  const a = m.annotations.find((x) => x.name in MAPPINGS);
  if (!a) return undefined;
  let methods = MAPPINGS[a.name];
  if (!methods) {
    const declared = annValue(a, 'method').map((x) => x.split('.').pop()!.toUpperCase());
    methods = declared.length ? declared : ALL_METHODS;
  }
  const raw = annValue(a, 'value', 'path');
  const paths = (raw.length ? raw : ['']).map((p) => props?.resolve(p) ?? p);
  return { methods, paths };
}

export function classMapping(t: JType, props?: SpringProps): string[] {
  const a = ann(t.annotations, 'RequestMapping', 'Path');
  const raw = annValue(a, 'value', 'path');
  const prefixes = raw.length ? raw : [''];
  return prefixes.map((p) => props?.resolve(p) ?? p);
}

export interface ListenerInfo {
  system: 'kafka' | 'rabbit' | 'jms' | 'sqs' | 'pubsub';
  topics: string[];
}

/** Message listener annotation on a method, with resolved topic/queue names. */
export function listenerOf(m: JMethod, props?: SpringProps): ListenerInfo | undefined {
  const res = (xs: string[]) => xs.map((x) => props?.resolve(x) ?? x).flatMap((x) => x.split(',').map((s) => s.trim())).filter(Boolean);
  const kafka = ann(m.annotations, 'KafkaListener', 'KafkaHandler');
  if (kafka && kafka.name === 'KafkaListener') return { system: 'kafka', topics: res([...annValue(kafka, 'topics'), ...annValue(kafka, 'topicPattern')]) };
  const rabbit = ann(m.annotations, 'RabbitListener');
  if (rabbit) {
    const topics = res([...annValue(rabbit, 'queues'), ...annValue(rabbit, 'queuesToDeclare')]);
    // bindings = @QueueBinding(value = @Queue("q"), exchange = @Exchange("ex"), key = "rk")
    for (const b of annValue(rabbit, 'bindings')) {
      const q = b.match(/@Queue\((?:value=)?"([^"]+)"/)?.[1];
      const ex = b.match(/@Exchange\((?:value=)?"([^"]+)"/)?.[1];
      const keys = [...b.matchAll(/key=\{?"([^"]+)"/g)].map((x) => x[1]);
      if (q) topics.push(...res([q]));
      for (const k of keys) topics.push(...res([`${ex ?? ''}/${k}`]));
      if (ex && !keys.length) topics.push(...res([`${ex}/`]));
    }
    return { system: 'rabbit', topics };
  }
  const jms = ann(m.annotations, 'JmsListener');
  if (jms) return { system: 'jms', topics: res(annValue(jms, 'destination')) };
  const sqs = ann(m.annotations, 'SqsListener');
  if (sqs) return { system: 'sqs', topics: res([...annValue(sqs, 'value'), ...annValue(sqs, 'queueNames')]) };
  return undefined;
}

/** Lower-camel bean name Spring derives from a class name, or the explicit stereotype value. */
export function beanName(t: JType): string {
  const st = t.annotations.find((a) => STEREOTYPES.includes(a.name));
  const explicit = annValue(st, 'value')[0];
  if (explicit) return explicit;
  return t.name.length > 1 && t.name[1] === t.name[1].toUpperCase() ? t.name : t.name[0].toLowerCase() + t.name.slice(1);
}

/** `@Value("${key}")` property key of an annotation list, resolved through props. */
export function valueAnnotation(list: JAnnotation[], props?: SpringProps): string | undefined {
  const v = annValue(ann(list, 'Value'), 'value')[0];
  if (v === undefined) return undefined;
  return props?.resolve(v) ?? v;
}

/** camelCase -> kebab-case for @ConfigurationProperties relaxed binding */
export function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
