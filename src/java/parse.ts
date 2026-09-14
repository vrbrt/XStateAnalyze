import { parse as javaParse } from 'java-parser';
import type { JAnnotation, JChainBase, JExpr, JField, JFile, JLocal, JMethod, JParam, JSegment, JType, JTypeRef } from './model.js';

/* ---------- CST helpers (chevrotain shape: nodes have name+children, tokens have image) ---------- */

interface Tok {
  image: string;
  startOffset: number;
  startLine: number;
  endLine?: number;
  tokenType?: { name: string };
}
interface Cst {
  name: string;
  children: Record<string, (Cst | Tok)[]>;
}
type Any = Cst | Tok;

const isTok = (n: Any): n is Tok => (n as Tok).image !== undefined;
const kids = (n: Cst | undefined, name: string): Cst[] => (n?.children?.[name] as Cst[] | undefined) ?? [];
const kid = (n: Cst | undefined, name: string): Cst | undefined => kids(n, name)[0];
const toks = (n: Cst | undefined, name: string): Tok[] => (n?.children?.[name] as Tok[] | undefined) ?? [];
const tok = (n: Cst | undefined, name: string): Tok | undefined => toks(n, name)[0];

const offsetCache = new WeakMap<Cst, number>();
function startOffset(n: Any): number {
  if (isTok(n)) return n.startOffset;
  const cached = offsetCache.get(n);
  if (cached !== undefined) return cached;
  let min = Infinity;
  for (const arr of Object.values(n.children)) for (const c of arr) min = Math.min(min, startOffset(c));
  offsetCache.set(n, min);
  return min;
}

/** All direct children (nodes and tokens) in source order. */
function ordered(n: Cst): Any[] {
  const all: Any[] = [];
  for (const arr of Object.values(n.children)) all.push(...arr);
  return all.sort((a, b) => startOffset(a) - startOffset(b));
}

function allTokens(n: Any, out: Tok[] = []): Tok[] {
  if (isTok(n)) out.push(n);
  else for (const c of ordered(n)) allTokens(c, out);
  return out;
}

function text(n: Any | undefined): string {
  if (!n) return '';
  return allTokens(n)
    .map((t) => t.image)
    .join('');
}

function lineOf(n: Any | undefined): number {
  if (!n) return 0;
  if (isTok(n)) return n.startLine;
  const t = allTokens(n)[0];
  return t?.startLine ?? 0;
}

function endLineOf(n: Any): number {
  const ts = allTokens(n);
  const t = ts[ts.length - 1];
  return t?.endLine ?? t?.startLine ?? 0;
}

/** Depth-first search for nodes named `name` (does not descend into matches unless `deep`). */
function find(n: Any, name: string, out: Cst[] = [], deep = true): Cst[] {
  if (isTok(n)) return out;
  if (n.name === name) {
    out.push(n);
    if (!deep) return out;
  }
  for (const arr of Object.values(n.children)) for (const c of arr) find(c, name, out, deep);
  return out;
}

/* ---------- types ---------- */

function typeRef(n: Cst | undefined): JTypeRef {
  if (!n) return { name: '?', args: [], dims: 0, raw: '' };
  const raw = text(n);
  // name: last identifier before the first '<' at this nesting level
  const ts = allTokens(n);
  let name = '?';
  let dims = 0;
  let depth = 0;
  for (const t of ts) {
    if (t.image === '<') depth++;
    else if (t.image === '>') depth--;
    else if (depth === 0 && t.image === '[') dims++;
    else if (depth === 0 && /^[A-Za-z_$][\w$]*$/.test(t.image) && !['var', 'final', 'extends', 'super'].includes(t.image)) name = t.image;
  }
  const args: JTypeRef[] = [];
  const ta = find(n, 'typeArguments', [], false)[0];
  if (ta) {
    for (const arg of kids(kid(ta, 'typeArgumentList'), 'typeArgument')) {
      const ref = kid(arg, 'referenceType');
      if (ref) args.push(typeRef(ref));
      else if (kid(arg, 'wildcard')) {
        const bound = kid(kid(arg, 'wildcard'), 'wildcardBounds');
        args.push(bound ? typeRef(kid(bound, 'referenceType')) : { name: '?', args: [], dims: 0, raw: '?' });
      }
    }
  }
  return { name, args, dims, raw };
}

/* ---------- annotations ---------- */

function elementValueText(ev: Cst | undefined): string | string[] {
  if (!ev) return '';
  const arr = kid(ev, 'elementValueArrayInitializer');
  if (arr) return kids(kid(arr, 'elementValueList'), 'elementValue').map((e) => String(elementValueText(e)));
  const inner = kid(ev, 'annotation');
  if (inner) return '@' + text(inner);
  const cond = kid(ev, 'conditionalExpression');
  if (cond) {
    const e = expr({ name: 'expression', children: { conditionalExpression: [cond] } });
    const s = evalConstString(e);
    return s ?? text(cond);
  }
  return text(ev);
}

function annotation(n: Cst): JAnnotation {
  const typeName = text(kid(n, 'typeName'));
  const name = typeName.split('.').pop() ?? typeName;
  const args: Record<string, string | string[]> = {};
  const single = kid(n, 'elementValue');
  if (single) args.value = elementValueText(single);
  for (const pair of kids(kid(n, 'elementValuePairList'), 'elementValuePair')) {
    const key = tok(pair, 'Identifier')?.image ?? 'value';
    args[key] = elementValueText(kid(pair, 'elementValue'));
  }
  return { name, args, line: lineOf(n) };
}

function modifiers(n: Cst, key: string): { annotations: JAnnotation[]; modifiers: string[] } {
  const annotations: JAnnotation[] = [];
  const mods: string[] = [];
  for (const m of kids(n, key)) {
    const a = kid(m, 'annotation');
    if (a) annotations.push(annotation(a));
    else mods.push(text(m));
  }
  return { annotations, modifiers: mods };
}

/* ---------- expressions ---------- */

/** Best-effort compile-time string value of an expression (literals and `+` concatenation). */
export function evalConstString(e: JExpr | undefined): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'binary' && e.op === '+') {
    const parts = e.parts.map(evalConstString);
    if (parts.every((p) => p !== undefined)) return parts.join('');
    return undefined;
  }
  if (e.kind === 'chain' && e.base.kind === 'name' && e.segments.every((s) => !s.call)) return e.segments.map((s) => s.name).join('.');
  return undefined;
}

function literal(n: Cst): JExpr {
  const s = tok(n, 'StringLiteral') ?? tok(n, 'TextBlock');
  if (s) {
    let v = s.image;
    if (v.startsWith('"""')) v = v.slice(3, -3).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    else v = v.slice(1, -1);
    v = v.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    return { kind: 'literal', value: v, isString: true };
  }
  return { kind: 'literal', value: text(n), isString: false };
}

export function expr(n: Cst | undefined): JExpr {
  if (!n) return { kind: 'other', text: '' };
  switch (n.name) {
    case 'expression': {
      const l = kid(n, 'lambdaExpression');
      if (l) return lambda(l);
      return expr(kid(n, 'conditionalExpression'));
    }
    case 'conditionalExpression': {
      const bin = expr(kid(n, 'binaryExpression'));
      if (tok(n, 'QuestionMark')) return { kind: 'ternary', parts: [bin, ...kids(n, 'expression').map(expr)] };
      return bin;
    }
    case 'binaryExpression': {
      const unaries = kids(n, 'unaryExpression');
      const assign = tok(n, 'AssignmentOperator');
      if (assign) return { kind: 'binary', op: assign.image, parts: [expr(unaries[0]), expr(kid(n, 'expression'))] };
      if (tok(n, 'Instanceof')) return { kind: 'other', text: text(n) };
      if (unaries.length === 1) return expr(unaries[0]);
      const ops = [...toks(n, 'BinaryOperator'), ...kids(n, 'shiftOperator').map((s) => ({ image: text(s) }) as Tok)];
      const op = ops[0]?.image ?? '?';
      return { kind: 'binary', op: ops.every((o) => o.image === op) ? op : 'mixed', parts: unaries.map(expr) };
    }
    case 'unaryExpression':
    case 'unaryExpressionNotPlusMinus': {
      const p = kid(n, 'primary');
      if (p) return expr(p);
      const c = kid(n, 'castExpression');
      if (c) return expr(c);
      const l = kid(n, 'lambdaExpression');
      if (l) return lambda(l);
      return { kind: 'other', text: text(n) };
    }
    case 'castExpression': {
      const ref = kid(n, 'referenceTypeCastExpression');
      if (ref) {
        const inner = kid(ref, 'unaryExpressionNotPlusMinus') ?? kid(ref, 'lambdaExpression');
        return { kind: 'cast', type: typeRef(kid(ref, 'referenceType')).name, expr: inner ? (inner.name === 'lambdaExpression' ? lambda(inner) : expr(inner)) : { kind: 'other', text: '' } };
      }
      const prim = kid(n, 'primitiveCastExpression');
      return { kind: 'cast', type: text(kid(prim, 'primitiveType')), expr: expr(kid(prim, 'unaryExpression')) };
    }
    case 'primary':
      return primary(n);
    case 'lambdaExpression':
      return lambda(n);
    case 'parenthesisExpression':
      return expr(kid(n, 'expression'));
    default:
      return { kind: 'other', text: text(n) };
  }
}

function lambda(n: Cst): JExpr {
  const params: string[] = [];
  const lp = kid(n, 'lambdaParameters');
  const single = tok(lp, 'Identifier');
  if (single) params.push(single.image);
  const withBraces = kid(lp, 'lambdaParametersWithBraces');
  if (withBraces) {
    for (const t of allTokens(withBraces)) if (/^[A-Za-z_$][\w$]*$/.test(t.image)) params.push(t.image);
    // typed params `(String a, int b)`: keep only the identifiers that are declarator ids
    const ids = find(withBraces, 'variableDeclaratorId').map((d) => text(d));
    const concise = kids(kid(kid(kid(withBraces, 'lambdaParameterList'), 'conciseLambdaParameterList'), 'conciseLambdaParameter'), 'Identifier');
    if (ids.length) {
      params.length = 0;
      params.push(...ids);
    } else if (concise.length) {
      params.length = 0;
      params.push(...concise.map((c) => text(c)));
    }
  }
  const body = kid(n, 'lambdaBody');
  const bodyExprs: JExpr[] = [];
  const e = kid(body, 'expression');
  if (e) bodyExprs.push(expr(e));
  return { kind: 'lambda', params, body: bodyExprs };
}

function argsOf(suffixOrCreation: Cst | undefined): JExpr[] {
  return kids(kid(suffixOrCreation, 'argumentList'), 'expression').map(expr);
}

function primary(n: Cst): JExpr {
  const prefix = kid(n, 'primaryPrefix');
  const suffixes = kids(n, 'primarySuffix');
  const line = lineOf(n);
  let base: JChainBase = { kind: 'name' };
  const segments: JSegment[] = [];

  if (prefix) {
    const lit = kid(prefix, 'literal');
    const fqn = kid(prefix, 'fqnOrRefType');
    const paren = kid(prefix, 'parenthesisExpression');
    const cast = kid(prefix, 'castExpression');
    const nw = kid(prefix, 'newExpression');
    if (lit) base = { kind: 'expr', expr: literal(lit) };
    else if (tok(prefix, 'This')) base = { kind: 'this' };
    else if (fqn) {
      const parts = [kid(fqn, 'fqnOrRefTypePartFirst'), ...kids(fqn, 'fqnOrRefTypePartRest')];
      for (const p of parts) {
        const common = kid(p, 'fqnOrRefTypePartCommon');
        const id = tok(common, 'Identifier');
        if (id) segments.push({ name: id.image });
        else if (tok(common, 'Super')) {
          if (!segments.length) base = { kind: 'super' };
          else segments.push({ name: 'super' });
        }
      }
    } else if (paren) base = { kind: 'expr', expr: expr(paren) };
    else if (cast) base = { kind: 'expr', expr: expr(cast) };
    else if (nw) {
      const creation = kid(nw, 'unqualifiedClassInstanceCreationExpression');
      if (creation) {
        const t = kid(creation, 'classOrInterfaceTypeToInstantiate');
        const ids = toks(t, 'Identifier');
        base = { kind: 'new', type: { name: ids[ids.length - 1]?.image ?? '?', args: [], dims: 0, raw: text(t) }, args: argsOf(creation), anonymousBody: !!kid(creation, 'classBody') };
      } else {
        const arr = kid(nw, 'arrayCreationExpression');
        base = { kind: 'expr', expr: { kind: 'other', text: text(arr ?? nw) } };
      }
    } else if (kid(prefix, 'switchStatement')) return { kind: 'other', text: 'switch' };
    else if (kid(prefix, 'unannPrimitiveTypeWithOptionalDimsSuffix') || tok(prefix, 'Void')) {
      return { kind: 'classLiteral', type: text(prefix) };
    }
  }

  for (const s of suffixes) {
    const inv = kid(s, 'methodInvocationSuffix');
    const id = tok(s, 'Identifier');
    const clsLit = kid(s, 'classLiteralSuffix');
    const mref = kid(s, 'methodReferenceSuffix');
    const creation = kid(s, 'unqualifiedClassInstanceCreationExpression');
    if (inv) {
      if (!segments.length) segments.push({ name: base.kind === 'super' ? '<super>' : base.kind === 'this' ? '<this>' : '<call>' });
      segments[segments.length - 1].call = { args: argsOf(inv) };
    } else if (id) segments.push({ name: id.image });
    else if (tok(s, 'This')) segments.push({ name: 'this' });
    else if (clsLit) return { kind: 'classLiteral', type: segments.map((x) => x.name).join('.') || text(prefix) };
    else if (mref) {
      const name = tok(mref, 'Identifier')?.image ?? (tok(mref, 'New') ? 'new' : '?');
      return { kind: 'methodRef', target: { kind: 'chain', base, segments, line }, name };
    } else if (creation) {
      // outer.new Inner(args)
      const t = kid(creation, 'classOrInterfaceTypeToInstantiate');
      const ids = toks(t, 'Identifier');
      segments.push({ name: `new ${ids[ids.length - 1]?.image ?? '?'}`, call: { args: argsOf(creation) } });
    }
    // arrayAccessSuffix / typeArguments / templateArgument: ignore
  }
  if (base.kind === 'expr' && segments.length === 0) return base.expr;
  return { kind: 'chain', base, segments, line };
}

/* ---------- declarations ---------- */

function params(list: Cst | undefined): JParam[] {
  const out: JParam[] = [];
  for (const fp of kids(list, 'formalParameter')) {
    const reg = kid(fp, 'variableParaRegularParameter');
    const varArity = kid(fp, 'variableArityParameter');
    const p = reg ?? varArity;
    if (!p) continue;
    const anns = kids(p, 'variableModifier').map((m) => kid(m, 'annotation')).filter((a): a is Cst => !!a).map(annotation);
    const name = reg ? text(kid(reg, 'variableDeclaratorId')) : (tok(varArity, 'Identifier')?.image ?? '?');
    out.push({ name, type: typeRef(kid(p, 'unannType')), annotations: anns });
  }
  return out;
}

function collectBody(body: Cst | undefined, m: JMethod) {
  if (!body) return;
  // chains: every primary in the body (nested ones are separate entries)
  for (const p of find(body, 'primary')) {
    const e = primary(p);
    if (e.kind === 'chain') m.chains.push(e);
  }
  // locals
  for (const d of find(body, 'localVariableDeclaration')) {
    const lt = kid(d, 'localVariableType');
    const isVar = !!tok(lt, 'Var') || text(lt) === 'var';
    const type = isVar ? undefined : typeRef(kid(lt, 'unannType') ?? lt);
    for (const v of kids(kid(d, 'variableDeclaratorList'), 'variableDeclarator')) {
      const init = kid(kid(v, 'variableInitializer'), 'expression');
      m.locals.push({ name: text(kid(v, 'variableDeclaratorId')), type, init: init ? expr(init) : undefined, line: lineOf(v) });
    }
  }
  for (const c of find(body, 'catchFormalParameter')) {
    m.locals.push({ name: text(kid(c, 'variableDeclaratorId')), type: typeRef(kid(kid(c, 'catchType'), 'unannClassType')), line: lineOf(c) });
  }
  for (const r of find(body, 'resource')) {
    const lvd = kid(r, 'localVariableDeclaration');
    if (lvd) continue; // handled above
  }
  for (const tp of find(body, 'typePattern')) {
    const lvd = kid(tp, 'localVariableDeclaration');
    if (lvd) continue; // handled above
  }
  // assignments `this.x = y` / `x = y`
  for (const b of find(body, 'binaryExpression')) {
    if (tok(b, 'AssignmentOperator')?.image !== '=') continue;
    const lhs = expr(kids(b, 'unaryExpression')[0]);
    const rhs = expr(kid(b, 'expression'));
    if (lhs.kind !== 'chain') continue;
    const field = lhs.base.kind === 'this' && lhs.segments.length === 1 ? lhs.segments[0].name : lhs.base.kind === 'name' && lhs.segments.length === 1 ? lhs.segments[0].name : undefined;
    if (!field) continue;
    if (rhs.kind === 'chain' && rhs.base.kind === 'name' && rhs.segments.length === 1 && !rhs.segments[0].call) m.assignments.push({ field, from: rhs.segments[0].name });
  }
}

function method(n: Cst, kind: 'method' | 'interfaceMethod' | 'constructor'): JMethod {
  const modKey = kind === 'constructor' ? 'constructorModifier' : kind === 'interfaceMethod' ? 'interfaceMethodModifier' : 'methodModifier';
  const mods = modifiers(n, modKey);
  const m: JMethod = {
    name: '?',
    params: [],
    annotations: mods.annotations,
    modifiers: mods.modifiers,
    isConstructor: kind === 'constructor',
    isAbstract: false,
    line: lineOf(n),
    endLine: endLineOf(n),
    chains: [],
    locals: [],
    assignments: [],
  };
  if (kind === 'constructor') {
    const decl = kid(n, 'constructorDeclarator');
    m.name = '<init>';
    m.params = params(kid(decl, 'formalParameterList'));
    collectBody(kid(n, 'constructorBody'), m);
  } else {
    const header = kid(n, 'methodHeader');
    const decl = kid(header, 'methodDeclarator');
    m.name = tok(decl, 'Identifier')?.image ?? '?';
    m.params = params(kid(decl, 'formalParameterList'));
    const result = kid(header, 'result');
    m.returnType = tok(result, 'Void') ? { name: 'void', args: [], dims: 0, raw: 'void' } : typeRef(kid(result, 'unannType'));
    const body = kid(kid(n, 'methodBody'), 'block');
    m.isAbstract = !body;
    collectBody(body, m);
  }
  return m;
}

function field(n: Cst, modKey: string): JField[] {
  const mods = modifiers(n, modKey);
  const type = typeRef(kid(n, 'unannType'));
  const out: JField[] = [];
  for (const v of kids(kid(n, 'variableDeclaratorList'), 'variableDeclarator')) {
    const init = kid(kid(v, 'variableInitializer'), 'expression');
    const f: JField = { name: text(kid(v, 'variableDeclaratorId')), type, annotations: mods.annotations, modifiers: mods.modifiers, line: lineOf(v) };
    if (init) f.constValue = evalConstString(expr(init));
    out.push(f);
  }
  return out;
}

function typeDecl(n: Cst, pkg: string, outer: string | undefined, file: string, out: JType[]): JType | undefined {
  // n is classDeclaration | interfaceDeclaration
  const isClassDecl = n.name === 'classDeclaration';
  const mods = modifiers(n, isClassDecl ? 'classModifier' : 'interfaceModifier');
  const normal = kid(n, 'normalClassDeclaration');
  const enumD = kid(n, 'enumDeclaration');
  const recordD = kid(n, 'recordDeclaration');
  const normalI = kid(n, 'normalInterfaceDeclaration');
  const annoI = kid(n, 'annotationInterfaceDeclaration');
  const body = normal ?? enumD ?? recordD ?? normalI ?? annoI;
  if (!body) return undefined;
  const name = text(kid(body, 'typeIdentifier')) || tok(body, 'Identifier')?.image || '?';
  const fqn = outer ? `${outer}$${name}` : pkg ? `${pkg}.${name}` : name;
  const t: JType = {
    kind: normal ? 'class' : enumD ? 'enum' : recordD ? 'record' : annoI ? 'annotation' : 'interface',
    name,
    fqn,
    package: pkg,
    annotations: mods.annotations,
    modifiers: mods.modifiers,
    interfaces: [],
    fields: [],
    methods: [],
    nested: [],
    line: lineOf(n),
    endLine: endLineOf(n),
    file,
  };
  const ext = kid(body, 'classExtends');
  if (ext) t.superclass = typeRef(kid(ext, 'classType'));
  const impl = kid(body, 'classImplements') ?? kid(body, 'interfaceExtends');
  for (const it of kids(kid(impl, 'interfaceTypeList'), 'interfaceType')) t.interfaces.push(typeRef(kid(it, 'classType')));
  if (recordD) {
    for (const rc of kids(kid(kid(recordD, 'recordHeader'), 'recordComponentList'), 'recordComponent')) {
      t.fields.push({ name: tok(rc, 'Identifier')?.image ?? text(kid(rc, 'variableArityRecordComponent')), type: typeRef(kid(rc, 'unannType')), annotations: [], modifiers: ['private', 'final'], line: lineOf(rc) });
    }
  }
  const members: Cst[] = [];
  const classBody = kid(body, 'classBody') ?? kid(kid(body, 'enumBody'), 'enumBodyDeclarations') ?? kid(body, 'recordBody');
  if (classBody) {
    for (const d of kids(classBody, 'classBodyDeclaration')) members.push(d);
    for (const d of kids(classBody, 'recordBodyDeclaration')) {
      const cbd = kid(d, 'classBodyDeclaration');
      if (cbd) members.push(cbd);
    }
  }
  for (const d of members) {
    const cm = kid(d, 'classMemberDeclaration');
    const ctor = kid(d, 'constructorDeclaration');
    if (ctor) t.methods.push(method(ctor, 'constructor'));
    if (!cm) continue;
    const f = kid(cm, 'fieldDeclaration');
    const m = kid(cm, 'methodDeclaration');
    const nestedC = kid(cm, 'classDeclaration') ?? kid(cm, 'interfaceDeclaration');
    if (f) t.fields.push(...field(f, 'fieldModifier'));
    if (m) t.methods.push(method(m, 'method'));
    if (nestedC) {
      const nt = typeDecl(nestedC, pkg, fqn, file, out);
      if (nt) t.nested.push(nt.fqn);
    }
  }
  const ibody = kid(body, 'interfaceBody');
  for (const d of kids(ibody, 'interfaceMemberDeclaration')) {
    const c = kid(d, 'constantDeclaration');
    const m = kid(d, 'interfaceMethodDeclaration');
    const nestedC = kid(d, 'classDeclaration') ?? kid(d, 'interfaceDeclaration');
    if (c) t.fields.push(...field(c, 'constantModifier'));
    if (m) t.methods.push(method(m, 'interfaceMethod'));
    if (nestedC) {
      const nt = typeDecl(nestedC, pkg, fqn, file, out);
      if (nt) t.nested.push(nt.fqn);
    }
  }
  // enum constants with bodies / arguments: ignore
  out.push(t);
  return t;
}

/** Parse one Java source file into the lightweight model. Never throws; sets `parseError` instead. */
export function parseJava(source: string, relPath: string): JFile {
  const file: JFile = { path: relPath, package: '', imports: [], types: [] };
  let cst: Cst;
  try {
    cst = javaParse(source) as unknown as Cst;
  } catch (e) {
    file.parseError = String((e as Error).message ?? e).split('\n')[0].slice(0, 200);
    return file;
  }
  const unit = kid(cst, 'ordinaryCompilationUnit') ?? cst;
  const pkgDecl = kid(unit, 'packageDeclaration');
  if (pkgDecl) file.package = toks(pkgDecl, 'Identifier').map((t) => t.image).join('.');
  for (const imp of kids(unit, 'importDeclaration')) {
    const name = toks(kid(imp, 'packageOrTypeName') ?? imp, 'Identifier').map((t) => t.image).join('.');
    if (!name) continue;
    file.imports.push({ name, isStatic: !!tok(imp, 'Static'), wildcard: !!tok(imp, 'Star') });
  }
  for (const td of kids(unit, 'typeDeclaration')) {
    const decl = kid(td, 'classDeclaration') ?? kid(td, 'interfaceDeclaration');
    if (decl) typeDecl(decl, file.package, undefined, relPath, file.types);
  }
  return file;
}
