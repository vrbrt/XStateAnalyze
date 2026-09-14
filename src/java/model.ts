/**
 * Lightweight Java source model extracted from the java-parser CST.
 * Only what the analyzer needs: declarations, annotations, types and call chains.
 */

export interface JAnnotation {
  name: string; // simple name, e.g. RestController
  /** `value` for single-element annotations; named members otherwise. Arrays are joined as string[] */
  args: Record<string, string | string[]>;
  line: number;
}

export interface JTypeRef {
  /** simple name as written (generics stripped), e.g. `List`, `UserService`, `String` */
  name: string;
  /** generic arguments, simple names */
  args: JTypeRef[];
  /** array dimensions */
  dims: number;
  raw: string;
}

export interface JField {
  name: string;
  type: JTypeRef;
  annotations: JAnnotation[];
  modifiers: string[];
  /** constant initializer when it is a string/number literal (or resolvable concat) */
  constValue?: string;
  line: number;
}

export interface JParam {
  name: string;
  type: JTypeRef;
  annotations: JAnnotation[];
}

/** One segment of a chain `a.b().c` */
export interface JSegment {
  name: string;
  call?: { args: JExpr[] };
}

/** An expression, kept mostly opaque; enough structure for string evaluation and call extraction */
export type JExpr =
  | { kind: 'literal'; value: string; isString: boolean }
  | { kind: 'chain'; base: JChainBase; segments: JSegment[]; line: number }
  | { kind: 'binary'; op: string; parts: JExpr[] }
  | { kind: 'lambda'; params: string[]; body: JExpr[] }
  | { kind: 'ternary'; parts: JExpr[] }
  | { kind: 'cast'; type: string; expr: JExpr }
  | { kind: 'classLiteral'; type: string }
  | { kind: 'methodRef'; target: JExpr; name: string }
  | { kind: 'other'; text: string };

export type JChainBase =
  | { kind: 'name' }            // starts with an identifier (first segment)
  | { kind: 'this' }
  | { kind: 'super' }
  | { kind: 'new'; type: JTypeRef; args: JExpr[]; anonymousBody?: boolean }
  | { kind: 'expr'; expr: JExpr }; // (expr).foo()

export interface JLocal {
  name: string;
  type?: JTypeRef; // undefined for `var` / lambda params without types
  /** for `var x = <chain>` — the initializer, to infer the type */
  init?: JExpr;
  line: number;
}

export interface JMethod {
  name: string;
  params: JParam[];
  returnType?: JTypeRef; // undefined for constructors
  annotations: JAnnotation[];
  modifiers: string[];
  isConstructor: boolean;
  isAbstract: boolean;
  line: number;
  endLine: number;
  /** all chains / expressions found in the body, in source order (nested ones included separately) */
  chains: Extract<JExpr, { kind: 'chain' }>[];
  locals: JLocal[];
  /** `this.x = y` assignments in constructors/setters (field <- param) */
  assignments: { field: string; from: string }[];
}

export interface JType {
  kind: 'class' | 'interface' | 'enum' | 'record' | 'annotation';
  name: string;
  fqn: string;
  package: string;
  annotations: JAnnotation[];
  modifiers: string[];
  superclass?: JTypeRef;
  interfaces: JTypeRef[];
  fields: JField[];
  methods: JMethod[];
  /** nested type FQNs */
  nested: string[];
  line: number;
  endLine: number;
  file: string;
}

export interface JFile {
  path: string; // root-relative
  package: string;
  imports: { name: string; isStatic: boolean; wildcard: boolean }[];
  types: JType[];
  parseError?: string;
}
