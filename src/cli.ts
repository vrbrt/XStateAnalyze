#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import { VERSION, analyze, readRulesFile, writeFile } from './analyze.js';
import type { Analysis, AnalyzerOptions } from './model.js';
import { callGraphDot } from './output/dot.js';
import { htmlReport } from './output/html.js';
import { markdownReport } from './output/markdown.js';
import { callGraphFlowchart, stateDiagram } from './output/mermaid.js';
import { subgraph } from './query.js';

const program = new Command();
program.name('xsa').description('Static analyzer for React / XState / Next.js projects').version(VERSION);

function commonOptions(cmd: Command): Command {
  return cmd
    .option('-t, --tsconfig <file>', 'tsconfig.json to use for every package (default: each package\'s own)')
    .option('-i, --include <globs...>', 'only analyze files matching these globs')
    .option('-x, --exclude <globs...>', 'skip files/dirs matching these globs (node_modules, dist, .next are always skipped)')
    .option('--include-builtins', 'keep calls to globals / TS lib (console.log, JSON.parse, …) in the graph', false)
    .option('--ignore-packages <names...>', 'drop call edges into these npm packages (e.g. react react-dom lodash)')
    .option('--rules <file>', 'JSON file with extra external-call rules (array, or { rules, replace })')
    .option('--openapi <files...>', 'OpenAPI/Swagger documents to index (default: auto-discovered; pass "none" to disable)')
    .option('--openapi-handlers <globs...>', 'files whose exported functions named after operationIds are server handlers (default: heuristic)')
    .option('-q, --quiet', 'no progress output', false);
}

function toOptions(root: string, o: any): AnalyzerOptions {
  const opts: AnalyzerOptions = {
    root: path.resolve(root),
    tsconfig: o.tsconfig,
    include: o.include,
    exclude: o.exclude,
    includeBuiltins: o.includeBuiltins,
    ignorePackages: o.ignorePackages,
    openapi: o.openapi ? (o.openapi.length === 1 && o.openapi[0] === 'none' ? [] : o.openapi) : undefined,
    openapiHandlers: o.openapiHandlers,
    onProgress: o.quiet ? undefined : (m) => console.error(`[xsa] ${m}`),
  };
  if (o.rules) {
    const r = readRulesFile(o.rules);
    opts.rules = r.rules;
    opts.replaceRules = r.replace;
  }
  return opts;
}

commonOptions(
  program
    .command('analyze [root]')
    .description('Analyze a project / monorepo and write reports')
    .option('-o, --out <dir>', 'output directory', 'xsa-out')
    .option('-f, --format <formats>', 'comma-separated: json,html,mermaid,dot,md', 'json,html,mermaid,md')
    .option('--max-mermaid-nodes <n>', 'cap nodes in the call-graph flowchart', '300'),
).action((root = '.', o) => {
  const a = analyze(toOptions(root, o));
  const out = path.resolve(o.out);
  const formats = new Set(String(o.format).split(',').map((s) => s.trim()));
  const written: string[] = [];
  const w = (f: string, c: string) => {
    writeFile(path.join(out, f), c);
    written.push(f);
  };
  if (formats.has('json')) {
    w('analysis.json', JSON.stringify(a, null, 2));
    w('machines.json', JSON.stringify(a.machines, null, 2));
    w('external-calls.json', JSON.stringify(a.externalCalls, null, 2));
  }
  if (formats.has('mermaid')) {
    w('callgraph.mmd', callGraphFlowchart(a, { maxNodes: Number(o.maxMermaidNodes) }));
    for (const m of a.machines) w(`machines/${safeName(m.name)}.mmd`, m.mermaid);
  }
  if (formats.has('dot')) w('callgraph.dot', callGraphDot(a));
  if (formats.has('md')) w('report.md', markdownReport(a));
  if (formats.has('html')) w('report.html', htmlReport(a));
  printSummary(a);
  console.error(`[xsa] wrote ${written.length} files to ${out}`);
});

commonOptions(
  program
    .command('machines [root]')
    .description('Print XState machines as Mermaid state diagrams to stdout')
    .option('--json', 'print the machine models as JSON instead', false)
    .option('--no-notes', 'omit entry/exit/invoke notes')
    .option('--direction <dir>', 'TB or LR'),
).action((root = '.', o) => {
  const a = analyze(toOptions(root, o));
  if (o.json) {
    console.log(JSON.stringify(a.machines, null, 2));
    return;
  }
  for (const m of a.machines) {
    console.log(`%% ${m.file}:${m.line}`);
    console.log(stateDiagram(m, { notes: o.notes, direction: o.direction }));
    console.log();
  }
  if (!a.machines.length) console.error('[xsa] no XState machines found');
});

commonOptions(
  program
    .command('external [root]')
    .description('List external calls (HTTP, gRPC, GraphQL, DB, …)')
    .option('--json', 'output JSON', false)
    .option('-c, --category <cats...>', 'filter by category (http grpc graphql trpc websocket db server-action messaging other)'),
).action((root = '.', o) => {
  const a = analyze(toOptions(root, o));
  let calls = a.externalCalls;
  if (o.category) calls = calls.filter((c) => o.category.includes(c.category));
  if (o.json) {
    console.log(JSON.stringify(calls, null, 2));
    return;
  }
  const name = (id: string) => a.nodes.find((n) => n.id === id)?.name ?? id;
  for (const c of calls) {
    console.log(`${c.category.padEnd(13)} ${(c.method ?? '').padEnd(8)} ${(c.target ?? '').padEnd(40)} ${c.callee.padEnd(28)} ← ${name(c.caller)}  (${c.file}:${c.line})`);
  }
  console.error(`[xsa] ${calls.length} external calls`);
});

commonOptions(
  program
    .command('graph [root]')
    .description('Print the call graph (Mermaid or DOT) to stdout, optionally focused on a function')
    .option('--focus <name>', 'only the neighbourhood of the node(s) whose name/id contains this text')
    .option('--depth <n>', 'neighbourhood depth for --focus', '2')
    .option('--callers-only', 'with --focus: only walk incoming edges', false)
    .option('--callees-only', 'with --focus: only walk outgoing edges', false)
    .option('--dot', 'emit Graphviz DOT instead of Mermaid', false)
    .option('--no-group', 'do not group nodes by file'),
).action((root = '.', o) => {
  const a = analyze(toOptions(root, o));
  let ids: Set<string> | undefined;
  if (o.focus) {
    ids = subgraph(a, o.focus, Number(o.depth), o.callersOnly ? 'in' : o.calleesOnly ? 'out' : 'both');
    if (!ids.size) {
      console.error(`[xsa] no node matches '${o.focus}'`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(o.dot ? callGraphDot(a, { nodeIds: ids }) : callGraphFlowchart(a, { nodeIds: ids, groupByFile: o.group, maxNodes: 5000 }));
});

function printSummary(a: Analysis) {
  const s = a.stats;
  console.error(
    `[xsa] ${s.files} files · ${s.functions} functions · ${s.components} components · ${s.hooks} hooks · ${s.edges} edges · ${s.machines} machines · ${s.externalCalls} external calls · ${s.unresolvedCalls} unresolved · ${s.durationMs}ms`,
  );
  for (const w of a.warnings.slice(0, 20)) console.error(`[xsa] warn: ${w}`);
  if (a.warnings.length > 20) console.error(`[xsa] … ${a.warnings.length - 20} more warnings (see analysis.json)`);
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

program.parseAsync(process.argv).catch((e) => {
  console.error(`[xsa] error: ${e?.stack ?? e}`);
  process.exit(1);
});
