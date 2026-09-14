import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import type { Analysis } from '../model.js';

export interface HtmlOptions {
  /** Inline cytoscape / dagre / mermaid from node_modules so the report works without network access */
  embedLibs?: boolean;
  warn?: (msg: string) => void;
}

const LIB_FILES: [global: string, cdn: string, pkgPath: string][] = [
  ['cytoscape', 'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js', 'cytoscape/dist/cytoscape.min.js'],
  ['dagre', 'https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js', 'dagre/dist/dagre.min.js'],
  ['cytoscapeDagre', 'https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js', 'cytoscape-dagre/cytoscape-dagre.js'],
  ['mermaid', 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js', 'mermaid/dist/mermaid.min.js'],
];

/** Inline `<script>` tags for the libraries found in node_modules; missing ones stay on the CDN. */
function embeddedLibs(warn?: (m: string) => void): string {
  const req = createRequire(import.meta.url);
  const out: string[] = [];
  for (const [, , pkgPath] of LIB_FILES) {
    try {
      const file = req.resolve(pkgPath);
      out.push(`<script>${fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
    } catch {
      warn?.(`--offline: ${pkgPath} not installed (npm i ${pkgPath.split('/')[0]}); the report will load it from the CDN`);
    }
  }
  return out.join('\n');
}

/**
 * Self-contained interactive report. The analysis JSON is embedded verbatim
 * (same shape as analysis.json) so the page can be regenerated from the JSON
 * or the JSON extracted from the page.
 *
 * Libraries are loaded from CDNs (cytoscape, dagre, mermaid); the page works
 * offline for everything except the graph canvas and diagram rendering.
 */
export function htmlReport(a: Analysis, opts: HtmlOptions = {}): string {
  // Compact embed: `files` is not used by the page; edges become [from, to, kind, count, line, label] index tuples
  // (the page restores the normal Analysis shape on load, so window.xsa.data matches analysis.json minus `files`).
  const index = new Map(a.nodes.map((n, i) => [n.id, i]));
  const payload = { ...a, files: [], edges: [], edgeTuples: a.edges.map((e) => [index.get(e.from) ?? -1, index.get(e.to) ?? -1, e.kind, e.count, e.line ?? 0, e.label ?? '']) };
  const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const title = `xsa · ${a.root.split('/').pop() ?? 'report'}`;
  const libs = opts.embedLibs ? embeddedLibs(opts.warn) : '';
  const cdn = JSON.stringify(Object.fromEntries(LIB_FILES.map(([g, url]) => [g, url])));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${libs}
<script>window.__xsaLibs = ${cdn};</script>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <div class="brand">xsa <span class="muted">static analysis</span></div>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="projects" id="projectsTab" hidden>Projects</button>
    <button data-tab="seams">Seams <span class="pill" id="seamCount"></span></button>
    <button data-tab="graph">Call graph</button>
    <button data-tab="machines">Machines <span class="pill" id="machineCount"></span></button>
    <button data-tab="external">External calls <span class="pill" id="externalCount"></span></button>
  </nav>
  <div class="muted small" id="rootLabel"></div>
</header>

<main>
  <section id="tab-overview" class="tab active">
    <div class="tiles" id="tiles"></div>
    <div class="card" id="projectsCard"><h3>Projects</h3><div id="projectsTable"></div></div>
    <div class="cols">
      <div class="card"><h3>Entry points</h3><div id="entryPoints"></div></div>
      <div class="card"><h3>Workspace packages</h3><div id="packages"></div></div>
    </div>
    <div class="card"><h3>External calls by category</h3><div id="externalSummary"></div></div>
    <div class="card" id="openapiCard" hidden><h3>OpenAPI operations</h3><div id="openapi"></div></div>
    <div class="card" id="warningsCard" hidden><h3>Warnings</h3><ul id="warnings"></ul></div>
  </section>

  <section id="tab-projects" class="tab">
    <div class="canvasWrap"><div id="cyProjects"></div><div id="projectsLegend" class="legendBox"></div></div>
    <aside class="details" id="projectDetails"><div class="muted">Click a project or an edge between projects.</div></aside>
  </section>

  <section id="tab-seams" class="tab">
    <div class="toolbar">
      <input id="seamSearch" type="search" placeholder="Filter seams by path, topic, operation, caller, handler…">
      <div id="seamKindChips" class="chips"></div>
      <div id="seamStatusChips" class="chips"></div>
    </div>
    <div class="tableWrap"><table id="seamTable"><thead><tr>
      <th data-k="status">Status</th><th data-k="kind">Kind</th><th data-k="label">Seam</th><th data-k="operationId">Operation</th><th>Callers</th><th>Handlers</th>
    </tr></thead><tbody></tbody></table></div>
  </section>

  <section id="tab-graph" class="tab">
    <aside class="side">
      <input id="search" type="search" placeholder="Search functions, files, packages…" autocomplete="off">
      <div id="searchResults" class="results"></div>
      <details open><summary>View</summary>
        <div class="row"><label>Layout <select id="layout">
          <option value="auto">auto (dagre ≤ 400 nodes, breadth-first above)</option>
          <option value="dagre-LR">dagre (left→right)</option>
          <option value="dagre-TB">dagre (top→bottom)</option>
          <option value="cose">cose (force)</option>
          <option value="breadthfirst">breadth-first</option>
          <option value="concentric">concentric</option>
        </select></label></div>
        <div class="row"><label>Focus depth <input id="depth" type="range" min="1" max="4" value="2"> <span id="depthVal">2</span></label></div>
        <div class="row"><label>Max nodes <input id="maxNodes" type="number" min="100" max="20000" step="100" value="1500" style="width:80px"></label> <span class="muted small">nearest to the focus are kept</span></div>
        <div class="row"><label><input type="checkbox" id="collapsePkgs"> Collapse packages into one node</label></div>
        <div class="row"><button id="showAll">Show whole graph</button> <button id="clearFocus" hidden>Clear focus</button></div>
        <div class="row muted small" id="graphHint"></div>
      </details>
      <details open><summary>Node kinds</summary><div id="kindFilters" class="checks"></div></details>
      <details open><summary>Edge kinds</summary><div id="edgeFilters" class="checks"></div></details>
      <details open id="projectFilterBox" hidden><summary>Projects</summary><div id="projectFilters" class="checks"></div></details>
      <details><summary>Packages</summary><div id="pkgFilters" class="checks"></div></details>
    </aside>
    <div class="canvasWrap">
      <div id="cy"></div>
      <div id="legend"></div>
    </div>
    <aside class="details" id="details"><div class="muted">Select a node to see details.</div></aside>
  </section>

  <section id="tab-machines" class="tab">
    <aside class="side"><div id="machineList" class="list"></div></aside>
    <div class="machineMain" id="machineMain"><div class="muted pad">No XState machines found.</div></div>
  </section>

  <section id="tab-external" class="tab">
    <div class="toolbar">
      <input id="extSearch" type="search" placeholder="Filter by target, callee, caller, file…">
      <div id="catChips" class="chips"></div>
    </div>
    <div class="tableWrap"><table id="extTable"><thead><tr>
      <th data-k="category">Category</th><th data-k="protocol">Protocol</th><th data-k="method">Method</th><th data-k="target">Target</th><th data-k="callee">Callee</th><th data-k="caller">Caller</th><th data-k="file">Location</th>
    </tr></thead><tbody></tbody></table></div>
  </section>
</main>

<script id="data" type="application/json">${json}</script>
<script>
${JS}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
:root { --bg:#f8fafc; --panel:#fff; --border:#e2e8f0; --text:#0f172a; --muted:#64748b; --accent:#2563eb; --accent-bg:#dbeafe;
  --component:#2563eb; --hook:#7c3aed; --function:#64748b; --method:#64748b; --module:#ca8a04; --package:#dc2626; --builtin:#a8a29e; --machine:#16a34a; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --panel:#111a2e; --border:#243149; --text:#e5e7eb; --muted:#94a3b8; --accent:#60a5fa; --accent-bg:#1e3a8a; } }
* { box-sizing:border-box } html,body { height:100%; margin:0 }
body { font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--text); background:var(--bg); display:flex; flex-direction:column }
header { display:flex; align-items:center; gap:24px; padding:8px 16px; border-bottom:1px solid var(--border); background:var(--panel) }
.brand { font-weight:700; font-size:15px } .muted { color:var(--muted) } .small { font-size:11px }
nav button { background:none; border:1px solid transparent; padding:6px 10px; border-radius:6px; color:var(--text); cursor:pointer; font:inherit }
nav button.active { background:var(--accent-bg); border-color:var(--accent) }
.pill { display:inline-block; min-width:18px; padding:0 5px; border-radius:9px; background:var(--border); font-size:11px; text-align:center }
main { flex:1; min-height:0; display:flex }
.tab { display:none; flex:1; min-height:0 } .tab.active { display:flex }
#tab-overview { flex-direction:column; overflow:auto; padding:16px; gap:16px }
.tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px }
.tile { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px } .tile b { display:block; font-size:22px }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:16px } @media (max-width:900px){ .cols{grid-template-columns:1fr} }
.card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px 16px; overflow:auto } .card h3 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted) }
table { border-collapse:collapse; width:100%; font-size:12px } th,td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top } th { color:var(--muted); font-weight:600; cursor:pointer; white-space:nowrap; position:sticky; top:0; background:var(--panel) }
td code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px }
a { color:var(--accent); text-decoration:none; cursor:pointer } a:hover { text-decoration:underline }
.side { width:280px; flex:none; border-right:1px solid var(--border); background:var(--panel); overflow:auto; padding:10px; display:flex; flex-direction:column; gap:8px }
.side input[type=search], .toolbar input { width:100%; padding:7px 9px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font:inherit }
.results { max-height:220px; overflow:auto; display:flex; flex-direction:column } .results div { padding:4px 6px; border-radius:4px; cursor:pointer } .results div:hover { background:var(--accent-bg) } .results .k { color:var(--muted); font-size:11px; margin-left:6px }
details summary { cursor:pointer; font-weight:600; margin:4px 0 } .row { margin:4px 0 } .checks label { display:block; padding:1px 0 } select, input[type=range] { font:inherit }
button { font:inherit; padding:4px 8px; border:1px solid var(--border); border-radius:5px; background:var(--panel); color:var(--text); cursor:pointer } button:hover { border-color:var(--accent) }
.canvasWrap { flex:1; position:relative; min-width:0 } #cy { position:absolute; inset:0 }
#legend { position:absolute; left:10px; bottom:10px; background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11px; display:flex; gap:10px; flex-wrap:wrap; max-width:80% }
#legend span::before { content:''; display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; background:var(--c); vertical-align:-1px }
.details { width:340px; flex:none; border-left:1px solid var(--border); background:var(--panel); overflow:auto; padding:12px }
.details h2 { margin:0 0 4px; font-size:15px; word-break:break-all } .details h4 { margin:12px 0 4px; font-size:11px; text-transform:uppercase; color:var(--muted) } .details ul { margin:0; padding-left:16px } .details li { margin:2px 0; word-break:break-all }
.badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; background:var(--border); margin-right:4px } .badge.entry { background:#fef3c7; color:#92400e } .badge.client { background:#dbeafe; color:#1e40af } .badge.server { background:#dcfce7; color:#166534 }
.list div { padding:6px 8px; border-radius:6px; cursor:pointer } .list div.active, .list div:hover { background:var(--accent-bg) } .list .sub { font-size:11px; color:var(--muted) }
.machineMain { flex:1; overflow:auto; padding:16px } .pad { padding:16px } .diagram { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; overflow:auto; margin-bottom:16px } .diagram svg { max-width:100%; height:auto }
.machineMeta { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px }
pre { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px; overflow:auto; font-size:11px; max-height:300px }
#tab-external, #tab-seams { flex-direction:column } .toolbar { flex-wrap:wrap } .toolbar { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel) } .toolbar input { width:320px }
.chips { display:flex; gap:6px; flex-wrap:wrap } .chip { padding:2px 9px; border-radius:12px; border:1px solid var(--border); cursor:pointer; font-size:12px } .chip.on { background:var(--accent-bg); border-color:var(--accent) }
.tableWrap { flex:1; overflow:auto; padding:0 16px 16px } #cyProjects { position:absolute; inset:0 } .legendBox { position:absolute; left:10px; bottom:10px; background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11px }
.status { display:inline-block; padding:1px 7px; border-radius:4px; font-size:11px; font-weight:600 } .status.linked { background:#dcfce7; color:#166534 } .status.no-handler { background:#fee2e2; color:#991b1b } .status.no-caller { background:#fef3c7; color:#92400e } .status.ambiguous { background:#ede9fe; color:#5b21b6 }
.proj { display:inline-block; padding:0 5px; border-radius:3px; font-size:10.5px; background:var(--border); margin-right:3px; color:var(--muted) } .tree { font-family:ui-monospace,monospace; font-size:11.5px } .tree ul { list-style:none; padding-left:16px; margin:2px 0 } .tree .t { color:var(--muted) }
kbd { font-size:10px; border:1px solid var(--border); border-radius:3px; padding:0 3px }
`;

const JS = String.raw`
/* ---------- lazy library loading: the graph / diagram libraries are fetched only when their tab opens ---------- */
const libState = {};
function loadScript(src) { return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(el); }); }
function lib(name) {
  const globalsOf = { cytoscape: ['cytoscape', 'dagre', 'cytoscapeDagre'], mermaid: ['mermaid'] };
  return (libState[name] ??= (async () => {
    for (const g of globalsOf[name]) if (!window[g]) await loadScript(window.__xsaLibs[g]);
  })());
}
performance.mark('xsa:start');
const A = JSON.parse(document.getElementById('data').textContent);
if (A.edgeTuples) {
  A.edges = A.edgeTuples.filter((t) => t[0] >= 0 && t[1] >= 0).map((t) => ({ from: A.nodes[t[0]].id, to: A.nodes[t[1]].id, kind: t[2], count: t[3], line: t[4] || undefined, label: t[5] || undefined }));
  delete A.edgeTuples;
}
performance.mark('xsa:parsed');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nodeById = new Map(A.nodes.map((n) => [n.id, n]));
const machineById = new Map(A.machines.map((m) => [m.id, m]));
const outE = new Map(), inE = new Map();
for (const e of A.edges) { (outE.get(e.from) ?? outE.set(e.from, []).get(e.from)).push(e); (inE.get(e.to) ?? inE.set(e.to, []).get(e.to)).push(e); }
const extByCaller = new Map();
for (const c of A.externalCalls) (extByCaller.get(c.caller) ?? extByCaller.set(c.caller, []).get(c.caller)).push(c);
const KIND_COLORS = { component: '#2563eb', hook: '#7c3aed', function: '#64748b', method: '#475569', module: '#ca8a04', machine: '#16a34a', external: '#ea580c', package: '#dc2626', builtin: '#a8a29e' };
const CATEGORY_COLORS = { http: '#ea580c', grpc: '#c026d3', graphql: '#e535ab', trpc: '#0891b2', websocket: '#0d9488', db: '#b45309', 'server-action': '#dc2626', messaging: '#7c3aed', other: '#78716c' };
const EDGE_STYLE = { calls: ['#94a3b8', 'solid'], renders: ['#2563eb', 'dashed'], 'uses-machine': ['#16a34a', 'solid'], invokes: ['#16a34a', 'solid'], implements: ['#16a34a', 'dotted'], defines: ['#16a34a', 'dashed'], external: ['#ea580c', 'solid'], 'server-action': ['#dc2626', 'dashed'], 'http-route': ['#dc2626', 'dashed'], 'message-route': ['#0d9488', 'dashed'] };
const CATEGORY_COLORS_EXTRA = { messaging: '#0d9488' };
const nodeColor = (n) => n.kind === 'external' ? (CATEGORY_COLORS[n.external?.category] ?? KIND_COLORS.external) : KIND_COLORS[n.kind];
const multi = A.projects.length > 1;
const projectRoot = (name) => (A.projects.find((p) => p.name === name) ?? {}).root ?? A.root;
const fileHref = (file, line, project) => 'vscode://file/' + projectRoot(project) + '/' + file + (line ? ':' + line : '');
const projTag = (p) => (multi && p ? '<span class="proj">' + esc(p) + '</span>' : '');
const nodeLink = (id) => { const n = nodeById.get(id); return n ? projTag(n.project) + '<a data-node="' + esc(id) + '">' + esc(n.name) + '</a>' : esc(id); };
const PROJECT_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#ca8a04', '#4f46e5'];
const projectColor = (name) => PROJECT_COLORS[Math.max(0, A.projects.findIndex((p) => p.name === name)) % PROJECT_COLORS.length];

performance.mark('xsa:indexed');
/* ---------- tabs ---------- */
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
async function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  try {
    if (name === 'graph') await ensureGraph();
    if (name === 'projects') await ensureProjectsGraph();
    if (name === 'machines' && A.machines.length && !currentMachine) await selectMachine(A.machines[0].id);
  } catch (e) {
    const target = name === 'graph' ? $('#graphHint') : name === 'projects' ? $('#projectDetails') : $('#machineMain');
    if (target) target.textContent = 'Could not load the rendering library (offline?). Regenerate the report with --offline to embed it. ' + e.message;
  }
}
document.body.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-node]');
  if (a) { ev.preventDefault(); showTab('graph').then(() => focusNode(a.dataset.node)); }
  const m = ev.target.closest('a[data-machine]');
  if (m) { ev.preventDefault(); showTab('machines'); selectMachine(m.dataset.machine); }
});

/* ---------- overview ---------- */
$('#rootLabel').textContent = A.root + ' · ' + new Date(A.generatedAt).toLocaleString();
$('#machineCount').textContent = A.machines.length;
$('#externalCount').textContent = A.externalCalls.length;
$('#seamCount').textContent = A.seams.length;
if (multi) { $('#projectsTab').hidden = false; $('#projectFilterBox').hidden = false; }
{
  const fnCount = (p) => A.nodes.filter((n) => n.project === p && n.internal && n.kind !== 'module' && n.kind !== 'machine').length;
  const entryCount = (p) => A.nodes.filter((n) => n.project === p && n.entry).length;
  const extCount = (p) => A.externalCalls.filter((c) => c.project === p).length;
  const seamStats = (p) => { const out = A.seams.filter((s) => s.callers.some((c) => c.project === p)).length; const inn = A.seams.filter((s) => s.handlers.some((h) => h.project === p)).length; return out + ' out / ' + inn + ' in'; };
  $('#projectsTable').innerHTML = '<table><tr><th>Project</th><th>Language</th><th>Service</th><th>Hosts</th><th>Files</th><th>Functions</th><th>Entry points</th><th>External calls</th><th>Seams</th></tr>' +
    A.projects.map((p) => '<tr><td><span class="proj" style="background:' + projectColor(p.name) + '22;color:' + projectColor(p.name) + '">' + esc(p.name) + '</span></td><td>' + esc(p.language) + '</td><td class="mono">' + esc(p.serviceName ?? '') + (p.contextPath ? ' <span class="muted">' + esc(p.contextPath) + '</span>' : '') + (p.port ? ' <span class="muted">:' + esc(p.port) + '</span>' : '') + '</td><td class="mono small">' + esc((p.hosts ?? []).join(', ')) + '</td><td>' + p.files + '</td><td>' + fnCount(p.name) + '</td><td>' + entryCount(p.name) + '</td><td>' + extCount(p.name) + '</td><td>' + seamStats(p.name) + '</td></tr>').join('') + '</table>';
}
$('#tiles').innerHTML = Object.entries(A.stats).filter(([k]) => k !== 'durationMs').map(([k, v]) => '<div class="tile"><b>' + v + '</b><span class="muted">' + k.replace(/([A-Z])/g, ' $1').toLowerCase() + '</span></div>').join('');
{
  const entries = A.nodes.filter((n) => n.entry).sort((x, y) => (x.route ?? '').localeCompare(y.route ?? '') || x.name.localeCompare(y.name));
  $('#entryPoints').innerHTML = entries.length ? '<table><tr><th>Kind</th><th>Route / topic</th><th>Function</th><th>File</th></tr>' + entries.map((n) => '<tr><td><span class="badge entry">' + esc(n.entry) + '</span></td><td class="mono">' + esc(n.route ?? (n.topics ?? []).join(', ')) + (n.httpMethods && n.httpMethods.length < 7 ? ' <span class="muted">' + n.httpMethods.join('/') + '</span>' : '') + '</td><td>' + nodeLink(n.id) + '</td><td class="mono"><a href="' + fileHref(n.file, n.line, n.project) + '">' + esc(n.file) + ':' + n.line + '</a></td></tr>').join('') + '</table>' : '<div class="muted">No entry points detected.</div>';
  $('#packages').innerHTML = '<table><tr><th>Package</th><th>Dir</th><th>Files</th><th>Functions</th></tr>' + A.packages.map((p) => '<tr><td>' + esc(p.name) + '</td><td class="mono">' + esc(p.dir) + '</td><td>' + p.files + '</td><td>' + A.nodes.filter((n) => n.internal && n.package === p.name && n.kind !== 'module').length + '</td></tr>').join('') + '</table>';
  const cats = {};
  for (const c of A.externalCalls) { const k = c.category + ' / ' + c.protocol; cats[k] = (cats[k] ?? 0) + 1; }
  $('#externalSummary').innerHTML = Object.keys(cats).length ? '<table><tr><th>Category / protocol</th><th>Calls</th></tr>' + Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>').join('') + '</table>' : '<div class="muted">No external calls detected.</div>';
  if (A.warnings.length) { $('#warningsCard').hidden = false; $('#warnings').innerHTML = A.warnings.map((w) => '<li>' + esc(w) + '</li>').join(''); }
  if (A.openapi && A.openapi.operations.length) {
    $('#openapiCard').hidden = false;
    const specs = A.openapi.specs.map((s) => esc(s.file) + (s.title ? ' <span class="muted">' + esc(s.title) + (s.version ? ' ' + esc(s.version) : '') + '</span>' : '') + ' (' + s.operations + ')').join(' · ');
    const ops = [...A.openapi.operations].sort((x, y) => x.path.localeCompare(y.path) || x.method.localeCompare(y.method));
    $('#openapi').innerHTML = '<div class="muted small" style="margin-bottom:6px">' + specs + '</div><table><tr><th>Method</th><th>Path</th><th>operationId</th><th>Called by</th><th>Handled by</th></tr>' +
      ops.map((o) => '<tr><td class="mono">' + esc(o.method) + '</td><td class="mono">' + esc(o.path) + '</td><td class="mono">' + esc(o.operationId) + (o.explicitId ? '' : ' <span class="muted">(synthetic)</span>') + '</td><td>' + ((o.callers ?? []).map(nodeLink).join(', ') || '<span class="muted">—</span>') + '</td><td>' + ((o.handlers ?? []).map(nodeLink).join(', ') || '<span class="muted">—</span>') + '</td></tr>').join('') + '</table>';
  }
}

performance.mark('xsa:overview');
/* ---------- call graph ---------- */
let cy = null, currentFocus = null, visibleIds = null;
const BIG = A.nodes.length > 1500;
// big graphs: package / builtin members are hidden by default (external endpoint nodes carry the useful information)
const state = { kinds: new Set(Object.keys(KIND_COLORS).filter((k) => k !== 'builtin' && !(BIG && k === 'package'))), edges: new Set(Object.keys(EDGE_STYLE)), pkgs: null, projects: null, collapse: false, maxNodes: 1500, forced: false };
function initFilters() {
  const kinds = {};
  for (const n of A.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  $('#kindFilters').innerHTML = Object.keys(KIND_COLORS).filter((k) => kinds[k]).map((k) => '<label><input type="checkbox" data-kind="' + k + '"' + (state.kinds.has(k) ? ' checked' : '') + '> <span style="color:' + KIND_COLORS[k] + '">■</span> ' + k + ' <span class="muted">(' + kinds[k] + ')</span></label>').join('');
  const ek = {};
  for (const e of A.edges) ek[e.kind] = (ek[e.kind] ?? 0) + 1;
  $('#edgeFilters').innerHTML = Object.keys(EDGE_STYLE).filter((k) => ek[k]).map((k) => '<label><input type="checkbox" data-edge="' + k + '" checked> ' + k + ' <span class="muted">(' + ek[k] + ')</span></label>').join('');
  const pk = {};
  for (const n of A.nodes) if (n.package) pk[n.package] = (pk[n.package] ?? 0) + 1;
  const ws = new Set(A.packages.map((p) => p.name));
  $('#pkgFilters').innerHTML = Object.entries(pk).sort((a, b) => (ws.has(b[0]) - ws.has(a[0])) || b[1] - a[1]).map(([k, v]) => '<label><input type="checkbox" data-pkg="' + esc(k) + '" checked> ' + esc(k) + (ws.has(k) ? ' <span class="badge">workspace</span>' : '') + ' <span class="muted">(' + v + ')</span></label>').join('');
  const usedCats = [...new Set(A.nodes.filter((n) => n.kind === 'external').map((n) => n.external.category))];
  if (multi) {
    $('#projectFilters').innerHTML = A.projects.map((p) => '<label><input type="checkbox" data-project="' + esc(p.name) + '" checked> <span style="color:' + projectColor(p.name) + '">■</span> ' + esc(p.name) + ' <span class="muted">(' + A.nodes.filter((n) => n.project === p.name).length + ')</span></label>').join('');
    $('#projectFilters').addEventListener('change', () => { state.projects = new Set($$('#projectFilters input:checked').map((i) => i.dataset.project)); render(); });
  }
  $('#legend').innerHTML = Object.entries(KIND_COLORS).filter(([k]) => k !== 'external').map(([k, c]) => '<span style="--c:' + c + '">' + k + '</span>').join('') + usedCats.map((c) => '<span style="--c:' + (CATEGORY_COLORS[c] ?? KIND_COLORS.external) + '">' + c + '</span>').join('');
  $('#kindFilters').addEventListener('change', (e) => { const k = e.target.dataset.kind; if (e.target.checked) state.kinds.add(k); else state.kinds.delete(k); render(); });
  $('#edgeFilters').addEventListener('change', (e) => { const k = e.target.dataset.edge; if (e.target.checked) state.edges.add(k); else state.edges.delete(k); render(); });
  $('#pkgFilters').addEventListener('change', () => { state.pkgs = new Set($$('#pkgFilters input:checked').map((i) => i.dataset.pkg)); render(); });
  $('#layout').addEventListener('change', () => runLayout());
  $('#depth').addEventListener('input', (e) => { $('#depthVal').textContent = e.target.value; if (currentFocus) focusNode(currentFocus); });
  $('#collapsePkgs').addEventListener('change', (e) => { state.collapse = e.target.checked; render(); });
  $('#maxNodes').addEventListener('change', (e) => { state.maxNodes = Math.max(50, Number(e.target.value) || 1500); render(true); });
  $('#showAll').addEventListener('click', () => { currentFocus = null; visibleIds = null; state.forced = true; $('#clearFocus').hidden = false; render(true); });
  $('#clearFocus').addEventListener('click', () => { currentFocus = null; visibleIds = null; state.forced = false; $('#clearFocus').hidden = true; render(true); });
  $('#search').addEventListener('input', onSearch);
}
function onSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#searchResults');
  if (!q) { box.innerHTML = ''; return; }
  const hits = A.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.file.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || (n.external && (n.external.target ?? '').toLowerCase().includes(q))).slice(0, 40);
  box.innerHTML = hits.map((n) => '<div data-id="' + esc(n.id) + '"><span style="color:' + nodeColor(n) + '">■</span> ' + esc(n.name) + '<span class="k">' + esc(n.internal ? n.file : n.kind === 'external' ? n.external.category : n.kind) + '</span></div>').join('') || '<div class="muted">no matches</div>';
  $$('div[data-id]', box).forEach((d) => d.addEventListener('click', () => focusNode(d.dataset.id)));
}
function neighborhood(id, depth) {
  const seen = new Set([id]); let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) for (const e of [...(outE.get(cur) ?? []), ...(inE.get(cur) ?? [])]) { const o = e.from === cur ? e.to : e.from; if (!seen.has(o)) { seen.add(o); next.push(o); } }
    frontier = next;
  }
  return seen;
}
function trace(id, dir) {
  // breadth-first so that a node cap keeps the nearest callers / callees
  const seen = new Set([id]); let frontier = [id];
  while (frontier.length && seen.size < state.maxNodes * 4) {
    const next = [];
    for (const cur of frontier) for (const e of (dir === 'out' ? outE.get(cur) : inE.get(cur)) ?? []) { const o = dir === 'out' ? e.to : e.from; if (!seen.has(o)) { seen.add(o); next.push(o); } }
    frontier = next;
  }
  return seen;
}
function focusNode(id) {
  currentFocus = id;
  state.forced = false;
  visibleIds = neighborhood(id, Number($('#depth').value));
  $('#clearFocus').hidden = false;
  render(true);
  showDetails(id);
}
async function ensureGraph() {
  if (cy) return;
  await lib('cytoscape');
  if (cy) return;
  cytoscape.use(cytoscapeDagre);
  cy = cytoscape({
    container: $('#cy'), wheelSensitivity: 0.2,
    textureOnViewport: BIG, hideEdgesOnViewport: BIG, pixelRatio: BIG ? 1 : 'auto', motionBlur: false,
    style: [
      { selector: 'node', style: { label: 'data(label)', 'font-size': 10, 'min-zoomed-font-size': 7, 'text-wrap': 'wrap', 'text-max-width': 140, 'text-valign': 'center', 'text-halign': 'center', width: 'label', height: 'label', padding: '8px', shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.15, 'border-width': 1.5, 'border-color': 'data(color)', color: getComputedStyle(document.body).color } },
      // large renders: fixed-size nodes with ellipsised labels (label measurement per node is the expensive part)
      { selector: 'node.compact', style: { width: 150, height: 26, 'text-wrap': 'ellipsis', 'text-max-width': 140, 'font-size': 9, padding: '2px' } },
      { selector: 'edge.compact', style: { 'curve-style': 'haystack', 'haystack-radius': 0.3, label: '', 'target-arrow-shape': 'none', width: 1 } },
      { selector: 'node[kind="machine"]', style: { shape: 'hexagon', 'background-opacity': 0.3 } },
      { selector: 'node[kind="package"], node[kind="builtin"]', style: { shape: 'barrel', 'background-opacity': 0.1 } },
      { selector: 'node[kind="component"]', style: { shape: 'round-rectangle', 'border-width': 2.5 } },
      { selector: 'node[kind="module"]', style: { shape: 'round-tag' } },
      { selector: 'node[kind="external"]', style: { shape: 'right-rhomboid', 'background-opacity': 0.25, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', 'font-size': 9 } },
      { selector: 'node[?entry]', style: { 'border-width': 3, 'border-style': 'double' } },
      { selector: 'node.focus', style: { 'background-opacity': 0.6, 'border-width': 4 } },
      { selector: 'node.dim', style: { opacity: 0.25 } },
      { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', 'line-style': 'data(style)', label: 'data(label)', 'font-size': 8, color: '#64748b', 'text-rotation': 'autorotate', 'text-background-color': getComputedStyle(document.body).backgroundColor, 'text-background-opacity': 1, 'text-background-padding': '1px' } },
      { selector: 'edge.dim', style: { opacity: 0.15 } },
    ],
  });
  cy.on('tap', 'node', (ev) => { const id = ev.target.data('nid'); if (ev.target.data('kind') === 'pkg-group') return; showDetails(id); highlight(id); });
  cy.on('dbltap', 'node', (ev) => { const id = ev.target.data('nid'); if (ev.target.data('kind') !== 'pkg-group') focusNode(id); });
  cy.on('tap', (ev) => { if (ev.target === cy) { cy.elements().removeClass('dim focus'); } });
  initFilters();
  if (BIG) $('#kindFilters input[data-kind=package]') && ($('#kindFilters input[data-kind=package]').checked = false);
  render(true);
}
function highlight(id) {
  const nb = neighborhood(id, 1);
  cy.elements().addClass('dim').removeClass('focus');
  cy.nodes().filter((n) => nb.has(n.data('nid'))).removeClass('dim');
  cy.edges().filter((e) => e.data('from') === id || e.data('to') === id).removeClass('dim');
  cy.nodes().filter((n) => n.data('nid') === id).addClass('focus');
}
function render(relayout) {
  if (!cy) return;
  const big = A.nodes.length > 400 && !visibleIds && !currentFocus;
  if (big && !state.forced) { cy.elements().remove(); $('#graphHint').textContent = A.nodes.length + ' nodes: search and pick a function to explore its neighbourhood, or "Show whole graph".'; return; }
  let nodes = A.nodes.filter((n) => state.kinds.has(n.kind) && (!state.pkgs || !n.package || state.pkgs.has(n.package)) && (!state.projects || !n.project || state.projects.has(n.project)) && (!visibleIds || visibleIds.has(n.id)));
  // keep the nodes nearest to the focus (visibleIds is in breadth-first order); entry points first for the whole graph
  if (visibleIds) { const order = new Map([...visibleIds].map((id, i) => [id, i])); nodes.sort((x, y) => order.get(x.id) - order.get(y.id)); }
  else nodes.sort((x, y) => Number(!!y.entry) - Number(!!x.entry));
  const total = nodes.length;
  if (nodes.length > state.maxNodes) nodes = nodes.slice(0, state.maxNodes);
  $('#graphHint').textContent = nodes.length < total ? 'showing ' + nodes.length + ' of ' + total + ' nodes (raise "Max nodes" or lower the depth / filters)' : nodes.length > 400 ? nodes.length + ' nodes: compact rendering' : '';
  const compact = nodes.length > 400;
  const ids = new Set(nodes.map((n) => n.id));
  let edges = A.edges.filter((e) => state.edges.has(e.kind) && ids.has(e.from) && ids.has(e.to));
  const els = [];
  const groupOf = (n) => (state.collapse && (n.kind === 'package' || n.kind === 'builtin')) ? 'grp:' + n.file : null;
  const groups = new Map();
  for (const n of nodes) {
    const g = groupOf(n);
    if (g) { groups.set(g, (groups.get(g) ?? 0) + 1); continue; }
    els.push({ data: { id: n.id, nid: n.id, label: (multi && n.project && n.internal ? '[' + n.project + '] ' : '') + n.name + (n.entry ? '\n«' + n.entry.replace('next:', '') + (n.route ? ' ' + n.route : n.topics ? ' ' + n.topics.join(',') : '') + '»' : '') + (n.kind === 'external' && n.external.calls > 1 ? '\n(' + n.external.calls + ' call sites)' : ''), kind: n.kind, color: nodeColor(n), entry: !!n.entry } });
  }
  for (const [g, count] of groups) els.push({ data: { id: g, nid: g, label: g.slice(4) + '\n(' + count + ' members)', kind: 'pkg-group', color: KIND_COLORS.package } });
  const seenE = new Set();
  for (const e of edges) {
    const fn = nodeById.get(e.from), tn = nodeById.get(e.to);
    const from = groupOf(fn) ?? e.from, to = groupOf(tn) ?? e.to;
    const key = from + '|' + to + '|' + e.kind;
    if (seenE.has(key)) continue; seenE.add(key);
    const [color, style] = EDGE_STYLE[e.kind] ?? EDGE_STYLE.calls;
    els.push({ data: { id: 'e:' + key, from, to, source: from, target: to, kind: e.kind, color, style, label: e.kind === 'calls' ? (e.count > 1 ? e.count + '×' : '') : (e.label ?? e.kind) } });
  }
  cy.startBatch();
  cy.elements().remove();
  cy.add(els);
  if (compact) cy.elements().addClass('compact');
  cy.endBatch();
  runLayout();
  if (currentFocus) highlight(currentFocus);
}
function runLayout() {
  let v = $('#layout').value;
  const n = cy.nodes().length;
  if (v === 'auto') v = n <= 400 ? 'dagre-LR' : n <= state.maxNodes ? 'breadthfirst' : 'grid';
  if (v.startsWith('dagre') && n > 1200) v = 'breadthfirst'; // dagre is quadratic; never let it run on thousands of nodes
  const roots = currentFocus ? cy.nodes().filter((x) => x.data('nid') === currentFocus) : cy.nodes().filter((x) => x.data('entry'));
  const opts = v.startsWith('dagre') ? { name: 'dagre', rankDir: v.split('-')[1], nodeSep: 20, rankSep: 60, animate: false }
    : v === 'cose' ? { name: 'cose', animate: false, numIter: n > 400 ? 200 : 1000, nodeRepulsion: () => 40000, idealEdgeLength: () => 80 }
    : v === 'breadthfirst' ? { name: 'breadthfirst', animate: false, directed: false, spacingFactor: 0.9, roots: roots.length ? roots : undefined, avoidOverlap: true, grid: true }
    : { name: v, animate: false, spacingFactor: 1.2 };
  cy.layout(opts).run();
  cy.fit(undefined, 30);
}
function showDetails(id) {
  const n = nodeById.get(id);
  if (!n) return;
  const badges = [n.entry ? '<span class="badge entry">' + esc(n.entry) + (n.route ? ' ' + esc(n.route) : '') + '</span>' : '', n.boundary ? '<span class="badge ' + n.boundary + '">use ' + n.boundary + '</span>' : '', n.exported ? '<span class="badge">exported</span>' : '', n.async ? '<span class="badge">async</span>' : '', ...(n.tags ?? []).map((t) => '<span class="badge">' + esc(t) + '</span>')].join('');
  const LIST_CAP = 100;
  const edgeList = (list, dir) => list.length ? '<ul>' + list.slice(0, LIST_CAP).map((e) => '<li>' + (e.kind !== 'calls' ? '<span class="muted">' + esc(e.kind) + '</span> ' : '') + nodeLink(dir === 'out' ? e.to : e.from) + (e.count > 1 ? ' <span class="muted">×' + e.count + '</span>' : '') + (e.line ? ' <a class="muted small" href="' + fileHref(dir === 'out' ? n.file : nodeById.get(e.from)?.file, e.line, dir === 'out' ? n.project : nodeById.get(e.from)?.project) + '">:' + e.line + '</a>' : '') + '</li>').join('') + (list.length > LIST_CAP ? '<li class="muted">… ' + (list.length - LIST_CAP) + ' more (use Trace to see them in the graph)</li>' : '') + '</ul>' : '<div class="muted">none</div>';
  const ext = extByCaller.get(id) ?? [];
  const machine = machineById.get(id);
  if (n.kind === 'external') {
    const x = n.external;
    const sites = A.externalCalls.filter((c) => c.node === id);
    $('#details').innerHTML =
      '<h2 style="color:' + nodeColor(n) + '">' + esc(n.name) + '</h2>' +
      '<div class="muted">external · <span class="badge">' + esc(x.category) + '</span> ' + esc(x.protocol) + (n.package ? ' · ' + esc(n.package) : '') + '</div>' +
      '<h4>Target</h4><div class="mono" style="word-break:break-all">' + esc(x.method ? x.method + ' ' : '') + esc(x.target ?? '(dynamic)') + (x.service ? ' <span class="muted">' + esc(x.service) + '</span>' : '') + '</div>' +
      '<div class="row" style="margin-top:8px"><button data-act="focus">Focus</button> <button data-act="callers">Trace callers ⇡</button></div>' +
      '<h4>Call sites (' + sites.length + ')</h4><ul>' + sites.map((c) => '<li>' + nodeLink(c.caller) + ' <span class="muted small"><code>' + esc(c.callee) + '</code> <a href="' + fileHref(c.file, c.line, c.project) + '">' + esc(c.file.split('/').pop()) + ':' + c.line + '</a></span></li>').join('') + '</ul>' +
      '<h4>Outgoing (' + (outE.get(id) ?? []).length + ')</h4>' + edgeList(outE.get(id) ?? [], 'out');
    $$('button[data-act]', $('#details')).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'focus') focusNode(id);
      else { currentFocus = id; state.forced = false; visibleIds = trace(id, 'in'); $('#clearFocus').hidden = false; render(true); }
    }));
    return;
  }
  $('#details').innerHTML =
    '<h2 style="color:' + nodeColor(n) + '">' + esc(n.name) + '</h2>' +
    '<div class="muted">' + projTag(n.project) + esc(n.kind) + ' · ' + (n.internal ? '<a href="' + fileHref(n.file, n.line, n.project) + '">' + esc(n.file) + (n.line ? ':' + n.line : '') + '</a>' : esc(n.file)) + (n.package && !multi ? ' · ' + esc(n.package) : '') + (n.className ? ' · <span class="mono">' + esc(n.className) + '</span>' : '') + '</div>' +
    '<div style="margin:6px 0">' + badges + (n.topics ? n.topics.map((t) => '<span class="badge">topic ' + esc(t) + '</span>').join('') : '') + '</div>' +
    '<div class="row"><button data-act="focus">Focus</button> <button data-act="callers">Trace callers ⇡</button> <button data-act="callees">Trace callees ⇣</button>' + (machine ? ' <a data-machine="' + esc(id) + '"><button>Open diagram</button></a>' : '') + '</div>' +
    (ext.length ? '<h4>External calls (' + ext.length + ')</h4><ul>' + ext.map((c) => '<li><span class="badge" style="background:' + (CATEGORY_COLORS[c.category] ?? '#999') + '22">' + esc(c.category) + '</span> ' + (c.node && nodeById.has(c.node) ? nodeLink(c.node) : esc(c.method ?? '') + ' <code>' + esc(c.target ?? c.callee) + '</code>') + ' <span class="muted small"><code>' + esc(c.callee) + '</code> <a href="' + fileHref(c.file, c.line, c.project) + '">:' + c.line + '</a></span></li>').join('') + '</ul>' : '') +
    '<h4>Outgoing (' + (outE.get(id) ?? []).length + ')</h4>' + edgeList(outE.get(id) ?? [], 'out') +
    '<h4>Incoming (' + (inE.get(id) ?? []).length + ')</h4>' + edgeList(inE.get(id) ?? [], 'in');
  $$('button[data-act]', $('#details')).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'focus') focusNode(id);
    else { currentFocus = id; state.forced = false; visibleIds = trace(id, b.dataset.act === 'callers' ? 'in' : 'out'); $('#clearFocus').hidden = false; render(true); }
  }));
}

/* ---------- machines ---------- */
let currentMachine = null;
let mermaidReady = false;
$('#machineList').innerHTML = A.machines.map((m) => '<div data-id="' + esc(m.id) + '"><b>' + esc(m.name) + '</b><div class="sub">' + esc(m.file) + ' · v' + m.version + '</div></div>').join('');
$$('#machineList div[data-id]').forEach((d) => d.addEventListener('click', () => selectMachine(d.dataset.id)));
function stateTree(s) {
  const kids = s.states.map(stateTree).join('');
  const tr = [...s.transitions, ...s.invoke.flatMap((i) => [...i.onDone, ...i.onError, ...i.onSnapshot])].map((t) => '<li><span class="t">' + esc(t.kind === 'always' ? 'always' : t.event) + '</span> → ' + esc(t.targets.join(', ') || '(self)') + (t.guard ? ' <span class="t">[' + esc(t.guard) + ']</span>' : '') + (t.actions.length ? ' <span class="t">/ ' + esc(t.actions.join(', ')) + '</span>' : '') + '</li>').join('');
  const meta = [s.entry.length ? 'entry: ' + s.entry.join(', ') : '', s.exit.length ? 'exit: ' + s.exit.join(', ') : '', ...s.invoke.map((i) => 'invoke: ' + i.src + (i.machineRef ? ' → ' + (machineById.get(i.machineRef)?.name ?? '') : '')), s.tags.length ? 'tags: ' + s.tags.join(', ') : ''].filter(Boolean).map((x) => '<li class="t">' + esc(x) + '</li>').join('');
  return '<li><b>' + esc(s.key || '(root)') + '</b> <span class="t">' + s.type + (s.initial ? ' · initial ' + esc(s.initial) : '') + (s.id ? ' · #' + esc(s.id) : '') + '</span><ul>' + meta + tr + kids + '</ul></li>';
}
async function selectMachine(id) {
  const m = machineById.get(id); if (!m) return;
  currentMachine = id;
  $$('#machineList div[data-id]').forEach((d) => d.classList.toggle('active', d.dataset.id === id));
  const impl = m.implementations;
  const implList = (k) => impl[k].length ? '<li><b>' + k + ':</b> ' + impl[k].map((x) => { const nid = m.implementationNodes[k + '.' + x]; return nid && nodeById.has(nid) ? nodeLink(nid) : esc(x); }).join(', ') + '</li>' : '';
  $('#machineMain').innerHTML =
    '<h2 style="margin:0 0 4px">' + esc(m.name) + (m.machineId ? ' <span class="muted">#' + esc(m.machineId) + '</span>' : '') + '</h2>' +
    '<div class="muted" style="margin-bottom:12px"><a href="' + fileHref(m.file, m.line, (nodeById.get(m.id) || {}).project) + '">' + esc(m.file) + ':' + m.line + '</a> · XState v' + m.version + ' · <code>' + esc(m.api) + '</code> · ' + nodeLink(m.id) + ' in graph · <button id="copyMmd">Copy Mermaid</button></div>' +
    '<div class="diagram" id="diagram"><div class="muted">Rendering…</div></div>' +
    '<div class="machineMeta">' +
      '<div class="card"><h3>Implementations</h3><ul>' + ['actions', 'guards', 'actors', 'delays'].map(implList).join('') + '</ul></div>' +
      '<div class="card"><h3>Relations</h3><ul>' + (m.usedBy.length ? '<li><b>used by:</b> ' + m.usedBy.map(nodeLink).join(', ') + '</li>' : '<li class="muted">not used by any analyzed function</li>') + (m.invokes.length ? '<li><b>invokes:</b> ' + m.invokes.map((x) => '<a data-machine="' + esc(x) + '">' + esc(machineById.get(x)?.name ?? x) + '</a>').join(', ') + '</li>' : '') + '<li><b>events:</b> ' + m.events.map((e) => '<code>' + esc(e) + '</code>').join(' ') + '</li></ul></div>' +
      '<div class="card"><h3>State tree</h3><div class="tree"><ul>' + stateTree(m.root) + '</ul></div></div>' +
    '</div>';
  $('#copyMmd').addEventListener('click', () => navigator.clipboard.writeText(m.mermaid));
  try {
    await lib('mermaid');
    if (!mermaidReady) { mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' }); mermaidReady = true; }
    const { svg } = await mermaid.render('mmd-' + Math.random().toString(36).slice(2), m.mermaid);
    $('#diagram').innerHTML = svg;
  } catch (e) {
    $('#diagram').innerHTML = '<div class="muted">Could not render diagram: ' + esc(e.message) + '</div><pre>' + esc(m.mermaid) + '</pre>';
  }
}

performance.mark('xsa:machines-list');
/* ---------- seams ---------- */
const SEAM_KIND_COLORS = { http: '#ea580c', kafka: '#0d9488', rabbit: '#0d9488', jms: '#0d9488', sqs: '#0d9488', grpc: '#c026d3', 'server-action': '#dc2626' };
const seamState = { q: '', kinds: new Set(A.seams.map((s) => s.kind)), statuses: new Set(['linked', 'no-handler', 'no-caller', 'ambiguous']), sort: 'status', dir: 1 };
{
  const kinds = [...new Set(A.seams.map((s) => s.kind))];
  $('#seamKindChips').innerHTML = kinds.map((k) => '<span class="chip on" data-kind="' + esc(k) + '">' + esc(k) + ' (' + A.seams.filter((s) => s.kind === k).length + ')</span>').join('');
  const statuses = ['linked', 'no-handler', 'no-caller', 'ambiguous'];
  $('#seamStatusChips').innerHTML = statuses.map((st) => '<span class="chip on" data-status="' + st + '"><span class="status ' + st + '">' + st + '</span> ' + A.seams.filter((s) => s.status === st).length + '</span>').join('');
  $$('#seamKindChips .chip').forEach((ch) => ch.addEventListener('click', () => { ch.classList.toggle('on'); if (ch.classList.contains('on')) seamState.kinds.add(ch.dataset.kind); else seamState.kinds.delete(ch.dataset.kind); renderSeams(); }));
  $$('#seamStatusChips .chip').forEach((ch) => ch.addEventListener('click', () => { ch.classList.toggle('on'); if (ch.classList.contains('on')) seamState.statuses.add(ch.dataset.status); else seamState.statuses.delete(ch.dataset.status); renderSeams(); }));
  $('#seamSearch').addEventListener('input', (e) => { seamState.q = e.target.value.toLowerCase(); renderSeams(); });
  $$('#seamTable th[data-k]').forEach((th) => th.addEventListener('click', () => { if (seamState.sort === th.dataset.k) seamState.dir *= -1; else { seamState.sort = th.dataset.k; seamState.dir = 1; } renderSeams(); }));
  renderSeams();
}
function partyList(list) {
  if (!list.length) return '<span class="muted">—</span>';
  return '<ul style="margin:0;padding-left:14px">' + list.map((p) => '<li>' + nodeLink(p.node) + (p.line ? ' <span class="muted small">:' + p.line + '</span>' : '') + '</li>').join('') + '</ul>';
}
function renderSeams() {
  const nm = (id) => nodeById.get(id)?.name ?? id;
  let rows = A.seams.filter((s) => seamState.kinds.has(s.kind) && seamState.statuses.has(s.status));
  if (seamState.q) rows = rows.filter((s) => [s.label, s.target, s.operationId, s.method, ...s.callers.map((c) => c.project + ' ' + nm(c.node)), ...s.handlers.map((h) => h.project + ' ' + nm(h.node))].join(' ').toLowerCase().includes(seamState.q));
  const order = { 'no-handler': 0, ambiguous: 1, 'no-caller': 2, linked: 3 };
  rows.sort((a, b) => { const k = seamState.sort; const va = k === 'status' ? order[a.status] : (a[k] ?? ''); const vb = k === 'status' ? order[b.status] : (b[k] ?? ''); return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * seamState.dir || a.label.localeCompare(b.label); });
  $('#seamTable tbody').innerHTML = rows.map((s) => '<tr><td><span class="status ' + s.status + '">' + s.status + '</span></td><td><span class="badge" style="background:' + (SEAM_KIND_COLORS[s.kind] ?? '#999') + '22">' + esc(s.kind) + '</span></td><td class="mono">' + (s.node && nodeById.has(s.node) ? '<a data-node="' + esc(s.node) + '">' + esc(s.label) + '</a>' : esc(s.label)) + '</td><td class="mono">' + esc(s.operationId ?? '') + (s.spec ? ' <span class="muted small">' + esc(s.spec) + '</span>' : '') + '</td><td>' + partyList(s.callers) + '</td><td>' + partyList(s.handlers) + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">No matching seams.</td></tr>';
}

performance.mark('xsa:seams');
/* ---------- projects (system view) ---------- */
let cyProjects = null;
async function ensureProjectsGraph() {
  if (cyProjects || !multi) return;
  await lib('cytoscape');
  if (cyProjects) return;
  const els = [];
  const pseudo = new Set();
  for (const p of A.projects) els.push({ data: { id: 'p:' + p.name, label: p.name + '\n' + (p.serviceName && p.serviceName !== p.name ? p.serviceName + '\n' : '') + p.language, color: projectColor(p.name), kind: 'project' } });
  for (const e of A.projectEdges) {
    for (const x of [e.from, e.to]) if (!A.projects.some((p) => p.name === x) && !pseudo.has(x)) { pseudo.add(x); els.push({ data: { id: 'p:' + x, label: x, color: '#a8a29e', kind: 'pseudo' } }); }
    els.push({ data: { id: 'pe:' + e.from + '|' + e.to + '|' + e.kind, source: 'p:' + e.from, target: 'p:' + e.to, label: e.kind + ' ×' + e.count, color: SEAM_KIND_COLORS[e.kind] ?? '#94a3b8', width: 1 + Math.min(6, Math.log2(e.count + 1)), seams: e.seams, from: e.from, to: e.to } });
  }
  cyProjects = cytoscape({
    container: $('#cyProjects'), elements: els, wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: { label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'font-size': 12, width: 'label', height: 'label', padding: '18px', shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.15, 'border-width': 2.5, 'border-color': 'data(color)', color: getComputedStyle(document.body).color } },
      { selector: 'node[kind="pseudo"]', style: { 'border-style': 'dashed', 'background-opacity': 0.05 } },
      { selector: 'edge', style: { width: 'data(width)', 'curve-style': 'bezier', 'control-point-step-size': 60, 'target-arrow-shape': 'triangle', 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', label: 'data(label)', 'font-size': 10, color: getComputedStyle(document.body).color, 'text-background-color': getComputedStyle(document.body).backgroundColor, 'text-background-opacity': 1, 'text-background-padding': '2px', 'text-rotation': 'autorotate' } },
    ],
    layout: { name: 'circle', padding: 60 },
  });
  cyProjects.on('tap', 'edge', (ev) => {
    const d = ev.target.data();
    const seams = A.seams.filter((s) => d.seams.includes(s.id));
    $('#projectDetails').innerHTML = '<h2>' + esc(d.from) + ' → ' + esc(d.to) + '</h2><div class="muted">' + esc(d.label) + '</div><h4>Seams</h4><ul>' + seams.map((s) => '<li><span class="status ' + s.status + '">' + s.status + '</span> ' + (s.node ? '<a data-node="' + esc(s.node) + '">' + esc(s.label) + '</a>' : esc(s.label)) + '<div class="small muted">' + s.callers.filter((c) => c.project === d.from).map((c) => nodeLink(c.node)).join(', ') + ' → ' + (s.handlers.filter((h) => h.project === d.to).map((h) => nodeLink(h.node)).join(', ') || '—') + '</div></li>').join('') + '</ul>';
  });
  cyProjects.on('tap', 'node', (ev) => {
    const name = ev.target.data('id').slice(2);
    const p = A.projects.find((x) => x.name === name);
    if (!p) { $('#projectDetails').innerHTML = '<h2>' + esc(name) + '</h2><div class="muted">Calls that no analyzed project handles (third-party APIs, unknown hosts).</div>'; return; }
    const entries = A.nodes.filter((n) => n.project === name && n.entry);
    const outSeams = A.seams.filter((s) => s.callers.some((c) => c.project === name));
    $('#projectDetails').innerHTML = '<h2 style="color:' + projectColor(name) + '">' + esc(name) + '</h2><div class="muted">' + esc(p.language) + ' · ' + esc(p.root) + '</div>' +
      (p.serviceName ? '<div>service <code>' + esc(p.serviceName) + '</code>' + (p.port ? ' port ' + esc(p.port) : '') + (p.contextPath ? ' context ' + esc(p.contextPath) : '') + '</div>' : '') +
      (p.hosts.length ? '<div class="small muted">hosts: ' + esc(p.hosts.join(', ')) + '</div>' : '') +
      '<h4>Entry points (' + entries.length + ')</h4><ul>' + entries.map((n) => '<li><span class="badge entry">' + esc(n.entry.replace(/^(next|spring):/, '')) + '</span> <span class="mono">' + esc(n.route ?? (n.topics ?? []).join(',')) + '</span> ' + nodeLink(n.id) + '</li>').join('') + '</ul>' +
      '<h4>Outgoing seams (' + outSeams.length + ')</h4><ul>' + outSeams.map((s) => '<li><span class="status ' + s.status + '">' + s.status + '</span> ' + esc(s.label) + ' → ' + ([...new Set(s.handlers.map((h) => h.project))].join(', ') || '—') + '</li>').join('') + '</ul>';
  });
  $('#projectsLegend').innerHTML = Object.entries(SEAM_KIND_COLORS).filter(([k]) => A.projectEdges.some((e) => e.kind === k)).map(([k, c]) => '<span style="color:' + c + '">■</span> ' + k).join(' &nbsp; ');
}

/* ---------- scripting hook (also used by scripts/render-check.mjs) ---------- */
window.xsa = { data: A, showTab, focusNode, selectMachine, getCy: () => cy, getProjectsCy: () => cyProjects, lib };
performance.mark('xsa:ready');

/* ---------- external calls ---------- */
const extState = { q: '', cats: new Set(), sort: 'category', dir: 1 };
{
  const cats = [...new Set(A.externalCalls.map((c) => c.category))];
  $('#catChips').innerHTML = cats.map((c) => '<span class="chip on" data-cat="' + esc(c) + '">' + esc(c) + ' (' + A.externalCalls.filter((x) => x.category === c).length + ')</span>').join('');
  extState.cats = new Set(cats);
  $$('#catChips .chip').forEach((ch) => ch.addEventListener('click', () => { ch.classList.toggle('on'); if (ch.classList.contains('on')) extState.cats.add(ch.dataset.cat); else extState.cats.delete(ch.dataset.cat); renderExt(); }));
  $('#extSearch').addEventListener('input', (e) => { extState.q = e.target.value.toLowerCase(); renderExt(); });
  $$('#extTable th').forEach((th) => th.addEventListener('click', () => { if (extState.sort === th.dataset.k) extState.dir *= -1; else { extState.sort = th.dataset.k; extState.dir = 1; } renderExt(); }));
  renderExt();
}
function renderExt() {
  const callerName = (id) => nodeById.get(id)?.name ?? id;
  let rows = A.externalCalls.filter((c) => extState.cats.has(c.category));
  if (extState.q) rows = rows.filter((c) => [c.target, c.callee, c.protocol, c.method, c.file, callerName(c.caller)].join(' ').toLowerCase().includes(extState.q));
  rows.sort((a, b) => { const k = extState.sort; const va = k === 'caller' ? callerName(a.caller) : (a[k] ?? ''); const vb = k === 'caller' ? callerName(b.caller) : (b[k] ?? ''); return String(va).localeCompare(String(vb)) * extState.dir || a.file.localeCompare(b.file) || a.line - b.line; });
  $('#extTable tbody').innerHTML = rows.map((c) => '<tr><td><span class="badge">' + esc(c.category) + '</span></td><td>' + esc(c.protocol) + '</td><td class="mono">' + esc(c.method ?? '') + '</td><td class="mono">' + (c.node && nodeById.has(c.node) ? '<a data-node="' + esc(c.node) + '">' + esc(c.target ?? '(dynamic)') + '</a>' : esc(c.target ?? '')) + '</td><td class="mono">' + esc(c.callee) + (c.service ? ' <span class="muted">' + esc(c.service) + '</span>' : '') + '</td><td>' + nodeLink(c.caller) + '</td><td class="mono"><a href="' + fileHref(c.file, c.line, c.project) + '">' + esc(c.file) + ':' + c.line + '</a></td></tr>').join('') || '<tr><td colspan="7" class="muted">No matching calls.</td></tr>';
}
`;
