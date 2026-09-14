import type { Analysis } from '../model.js';

/**
 * Self-contained interactive report. The analysis JSON is embedded verbatim
 * (same shape as analysis.json) so the page can be regenerated from the JSON
 * or the JSON extracted from the page.
 *
 * Libraries are loaded from CDNs (cytoscape, dagre, mermaid); the page works
 * offline for everything except the graph canvas and diagram rendering.
 */
export function htmlReport(a: Analysis): string {
  const json = JSON.stringify(a).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const title = `xsa · ${a.root.split('/').pop() ?? 'report'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <div class="brand">xsa <span class="muted">static analysis</span></div>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="graph">Call graph</button>
    <button data-tab="machines">Machines <span class="pill" id="machineCount"></span></button>
    <button data-tab="external">External calls <span class="pill" id="externalCount"></span></button>
  </nav>
  <div class="muted small" id="rootLabel"></div>
</header>

<main>
  <section id="tab-overview" class="tab active">
    <div class="tiles" id="tiles"></div>
    <div class="cols">
      <div class="card"><h3>Entry points</h3><div id="entryPoints"></div></div>
      <div class="card"><h3>Workspace packages</h3><div id="packages"></div></div>
    </div>
    <div class="card"><h3>External calls by category</h3><div id="externalSummary"></div></div>
    <div class="card" id="openapiCard" hidden><h3>OpenAPI operations</h3><div id="openapi"></div></div>
    <div class="card" id="warningsCard" hidden><h3>Warnings</h3><ul id="warnings"></ul></div>
  </section>

  <section id="tab-graph" class="tab">
    <aside class="side">
      <input id="search" type="search" placeholder="Search functions, files, packages…" autocomplete="off">
      <div id="searchResults" class="results"></div>
      <details open><summary>View</summary>
        <div class="row"><label>Layout <select id="layout">
          <option value="dagre-LR">dagre (left→right)</option>
          <option value="dagre-TB">dagre (top→bottom)</option>
          <option value="cose">cose (force)</option>
          <option value="breadthfirst">breadth-first</option>
          <option value="concentric">concentric</option>
        </select></label></div>
        <div class="row"><label>Focus depth <input id="depth" type="range" min="1" max="4" value="2"> <span id="depthVal">2</span></label></div>
        <div class="row"><label><input type="checkbox" id="collapsePkgs"> Collapse packages into one node</label></div>
        <div class="row"><button id="showAll">Show whole graph</button> <button id="clearFocus" hidden>Clear focus</button></div>
        <div class="row muted small" id="graphHint"></div>
      </details>
      <details open><summary>Node kinds</summary><div id="kindFilters" class="checks"></div></details>
      <details open><summary>Edge kinds</summary><div id="edgeFilters" class="checks"></div></details>
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
#tab-external { flex-direction:column } .toolbar { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel) } .toolbar input { width:320px }
.chips { display:flex; gap:6px; flex-wrap:wrap } .chip { padding:2px 9px; border-radius:12px; border:1px solid var(--border); cursor:pointer; font-size:12px } .chip.on { background:var(--accent-bg); border-color:var(--accent) }
.tableWrap { flex:1; overflow:auto; padding:0 16px 16px } .tree { font-family:ui-monospace,monospace; font-size:11.5px } .tree ul { list-style:none; padding-left:16px; margin:2px 0 } .tree .t { color:var(--muted) }
kbd { font-size:10px; border:1px solid var(--border); border-radius:3px; padding:0 3px }
`;

const JS = String.raw`
const A = JSON.parse(document.getElementById('data').textContent);
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
const EDGE_STYLE = { calls: ['#94a3b8', 'solid'], renders: ['#2563eb', 'dashed'], 'uses-machine': ['#16a34a', 'solid'], invokes: ['#16a34a', 'solid'], implements: ['#16a34a', 'dotted'], defines: ['#16a34a', 'dashed'], external: ['#ea580c', 'solid'], 'server-action': ['#dc2626', 'dashed'], 'http-route': ['#dc2626', 'dashed'] };
const nodeColor = (n) => n.kind === 'external' ? (CATEGORY_COLORS[n.external?.category] ?? KIND_COLORS.external) : KIND_COLORS[n.kind];
const fileHref = (file, line) => 'vscode://file/' + A.root + '/' + file + (line ? ':' + line : '');
const nodeLink = (id) => { const n = nodeById.get(id); return n ? '<a data-node="' + esc(id) + '">' + esc(n.name) + '</a>' : esc(id); };

/* ---------- tabs ---------- */
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'graph') ensureGraph();
  if (name === 'machines' && A.machines.length && !currentMachine) selectMachine(A.machines[0].id);
}
document.body.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-node]');
  if (a) { ev.preventDefault(); showTab('graph'); focusNode(a.dataset.node); }
  const m = ev.target.closest('a[data-machine]');
  if (m) { ev.preventDefault(); showTab('machines'); selectMachine(m.dataset.machine); }
});

/* ---------- overview ---------- */
$('#rootLabel').textContent = A.root + ' · ' + new Date(A.generatedAt).toLocaleString();
$('#machineCount').textContent = A.machines.length;
$('#externalCount').textContent = A.externalCalls.length;
$('#tiles').innerHTML = Object.entries(A.stats).filter(([k]) => k !== 'durationMs').map(([k, v]) => '<div class="tile"><b>' + v + '</b><span class="muted">' + k.replace(/([A-Z])/g, ' $1').toLowerCase() + '</span></div>').join('');
{
  const entries = A.nodes.filter((n) => n.entry).sort((x, y) => (x.route ?? '').localeCompare(y.route ?? '') || x.name.localeCompare(y.name));
  $('#entryPoints').innerHTML = entries.length ? '<table><tr><th>Kind</th><th>Route</th><th>Function</th><th>File</th></tr>' + entries.map((n) => '<tr><td><span class="badge entry">' + esc(n.entry) + '</span></td><td class="mono">' + esc(n.route ?? '') + (n.httpMethods && n.httpMethods.length < 7 ? ' <span class="muted">' + n.httpMethods.join('/') + '</span>' : '') + '</td><td>' + nodeLink(n.id) + '</td><td class="mono"><a href="' + fileHref(n.file, n.line) + '">' + esc(n.file) + ':' + n.line + '</a></td></tr>').join('') + '</table>' : '<div class="muted">No Next.js entry points detected.</div>';
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

/* ---------- call graph ---------- */
let cy = null, currentFocus = null, visibleIds = null;
const state = { kinds: new Set(Object.keys(KIND_COLORS).filter((k) => k !== 'builtin')), edges: new Set(Object.keys(EDGE_STYLE)), pkgs: null, collapse: false };
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
  $('#legend').innerHTML = Object.entries(KIND_COLORS).filter(([k]) => k !== 'external').map(([k, c]) => '<span style="--c:' + c + '">' + k + '</span>').join('') + usedCats.map((c) => '<span style="--c:' + (CATEGORY_COLORS[c] ?? KIND_COLORS.external) + '">' + c + '</span>').join('');
  $('#kindFilters').addEventListener('change', (e) => { const k = e.target.dataset.kind; if (e.target.checked) state.kinds.add(k); else state.kinds.delete(k); render(); });
  $('#edgeFilters').addEventListener('change', (e) => { const k = e.target.dataset.edge; if (e.target.checked) state.edges.add(k); else state.edges.delete(k); render(); });
  $('#pkgFilters').addEventListener('change', () => { state.pkgs = new Set($$('#pkgFilters input:checked').map((i) => i.dataset.pkg)); render(); });
  $('#layout').addEventListener('change', () => runLayout());
  $('#depth').addEventListener('input', (e) => { $('#depthVal').textContent = e.target.value; if (currentFocus) focusNode(currentFocus); });
  $('#collapsePkgs').addEventListener('change', (e) => { state.collapse = e.target.checked; render(); });
  $('#showAll').addEventListener('click', () => { currentFocus = null; visibleIds = null; $('#clearFocus').hidden = true; render(true); });
  $('#clearFocus').addEventListener('click', () => { currentFocus = null; visibleIds = null; $('#clearFocus').hidden = true; render(true); });
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
  const seen = new Set([id]); const stack = [id];
  while (stack.length) { const cur = stack.pop(); for (const e of (dir === 'out' ? outE.get(cur) : inE.get(cur)) ?? []) { const o = dir === 'out' ? e.to : e.from; if (!seen.has(o)) { seen.add(o); stack.push(o); } } }
  return seen;
}
function focusNode(id) {
  currentFocus = id;
  visibleIds = neighborhood(id, Number($('#depth').value));
  $('#clearFocus').hidden = false;
  render(true);
  showDetails(id);
}
function ensureGraph() {
  if (cy) return;
  cytoscape.use(cytoscapeDagre);
  cy = cytoscape({
    container: $('#cy'), wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: { label: 'data(label)', 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 140, 'text-valign': 'center', 'text-halign': 'center', width: 'label', height: 'label', padding: '8px', shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.15, 'border-width': 1.5, 'border-color': 'data(color)', color: getComputedStyle(document.body).color } },
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
  const big = A.nodes.length > 400;
  $('#graphHint').textContent = big ? A.nodes.length + ' nodes: search and pick a function to explore its neighbourhood, or "Show whole graph" (slow).' : '';
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
  if (big && !render.forced) { cy.elements().remove(); return; }
  let nodes = A.nodes.filter((n) => state.kinds.has(n.kind) && (!state.pkgs || !n.package || state.pkgs.has(n.package)) && (!visibleIds || visibleIds.has(n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  let edges = A.edges.filter((e) => state.edges.has(e.kind) && ids.has(e.from) && ids.has(e.to));
  const els = [];
  const groupOf = (n) => (state.collapse && (n.kind === 'package' || n.kind === 'builtin')) ? 'grp:' + n.file : null;
  const groups = new Map();
  for (const n of nodes) {
    const g = groupOf(n);
    if (g) { groups.set(g, (groups.get(g) ?? 0) + 1); continue; }
    els.push({ data: { id: n.id, nid: n.id, label: n.name + (n.entry ? '\n«' + n.entry.replace('next:', '') + (n.route ? ' ' + n.route : '') + '»' : '') + (n.kind === 'external' && n.external.calls > 1 ? '\n(' + n.external.calls + ' call sites)' : ''), kind: n.kind, color: nodeColor(n), entry: !!n.entry } });
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
  cy.elements().remove();
  cy.add(els);
  runLayout();
  if (currentFocus) highlight(currentFocus);
}
render.forced = false;
$('#showAll').addEventListener('click', () => { render.forced = true; });
function runLayout() {
  const v = $('#layout').value;
  const opts = v.startsWith('dagre') ? { name: 'dagre', rankDir: v.split('-')[1], nodeSep: 20, rankSep: 60, animate: false } : v === 'cose' ? { name: 'cose', animate: false, nodeRepulsion: () => 40000, idealEdgeLength: () => 80 } : { name: v, animate: false, spacingFactor: 1.2 };
  cy.layout(opts).run();
  cy.fit(undefined, 30);
}
function showDetails(id) {
  const n = nodeById.get(id);
  if (!n) return;
  const badges = [n.entry ? '<span class="badge entry">' + esc(n.entry) + (n.route ? ' ' + esc(n.route) : '') + '</span>' : '', n.boundary ? '<span class="badge ' + n.boundary + '">use ' + n.boundary + '</span>' : '', n.exported ? '<span class="badge">exported</span>' : '', n.async ? '<span class="badge">async</span>' : '', ...(n.tags ?? []).map((t) => '<span class="badge">' + esc(t) + '</span>')].join('');
  const edgeList = (list, dir) => list.length ? '<ul>' + list.map((e) => '<li>' + (e.kind !== 'calls' ? '<span class="muted">' + esc(e.kind) + '</span> ' : '') + nodeLink(dir === 'out' ? e.to : e.from) + (e.count > 1 ? ' <span class="muted">×' + e.count + '</span>' : '') + (e.line ? ' <a class="muted small" href="' + fileHref(dir === 'out' ? n.file : nodeById.get(e.from)?.file, e.line) + '">:' + e.line + '</a>' : '') + '</li>').join('') + '</ul>' : '<div class="muted">none</div>';
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
      '<h4>Call sites (' + sites.length + ')</h4><ul>' + sites.map((c) => '<li>' + nodeLink(c.caller) + ' <span class="muted small"><code>' + esc(c.callee) + '</code> <a href="' + fileHref(c.file, c.line) + '">' + esc(c.file.split('/').pop()) + ':' + c.line + '</a></span></li>').join('') + '</ul>' +
      '<h4>Outgoing (' + (outE.get(id) ?? []).length + ')</h4>' + edgeList(outE.get(id) ?? [], 'out');
    $$('button[data-act]', $('#details')).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'focus') focusNode(id);
      else { currentFocus = id; visibleIds = trace(id, 'in'); $('#clearFocus').hidden = false; render(true); }
    }));
    return;
  }
  $('#details').innerHTML =
    '<h2 style="color:' + nodeColor(n) + '">' + esc(n.name) + '</h2>' +
    '<div class="muted">' + esc(n.kind) + ' · ' + (n.internal ? '<a href="' + fileHref(n.file, n.line) + '">' + esc(n.file) + (n.line ? ':' + n.line : '') + '</a>' : esc(n.file)) + (n.package ? ' · ' + esc(n.package) : '') + '</div>' +
    '<div style="margin:6px 0">' + badges + '</div>' +
    '<div class="row"><button data-act="focus">Focus</button> <button data-act="callers">Trace callers ⇡</button> <button data-act="callees">Trace callees ⇣</button>' + (machine ? ' <a data-machine="' + esc(id) + '"><button>Open diagram</button></a>' : '') + '</div>' +
    (ext.length ? '<h4>External calls (' + ext.length + ')</h4><ul>' + ext.map((c) => '<li><span class="badge" style="background:' + (CATEGORY_COLORS[c.category] ?? '#999') + '22">' + esc(c.category) + '</span> ' + (c.node && nodeById.has(c.node) ? nodeLink(c.node) : esc(c.method ?? '') + ' <code>' + esc(c.target ?? c.callee) + '</code>') + ' <span class="muted small"><code>' + esc(c.callee) + '</code> <a href="' + fileHref(c.file, c.line) + '">:' + c.line + '</a></span></li>').join('') + '</ul>' : '') +
    '<h4>Outgoing (' + (outE.get(id) ?? []).length + ')</h4>' + edgeList(outE.get(id) ?? [], 'out') +
    '<h4>Incoming (' + (inE.get(id) ?? []).length + ')</h4>' + edgeList(inE.get(id) ?? [], 'in');
  $$('button[data-act]', $('#details')).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'focus') focusNode(id);
    else { currentFocus = id; visibleIds = trace(id, b.dataset.act === 'callers' ? 'in' : 'out'); $('#clearFocus').hidden = false; render(true); }
  }));
}

/* ---------- machines ---------- */
let currentMachine = null;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
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
    '<div class="muted" style="margin-bottom:12px"><a href="' + fileHref(m.file, m.line) + '">' + esc(m.file) + ':' + m.line + '</a> · XState v' + m.version + ' · <code>' + esc(m.api) + '</code> · ' + nodeLink(m.id) + ' in graph · <button id="copyMmd">Copy Mermaid</button></div>' +
    '<div class="diagram" id="diagram"><div class="muted">Rendering…</div></div>' +
    '<div class="machineMeta">' +
      '<div class="card"><h3>Implementations</h3><ul>' + ['actions', 'guards', 'actors', 'delays'].map(implList).join('') + '</ul></div>' +
      '<div class="card"><h3>Relations</h3><ul>' + (m.usedBy.length ? '<li><b>used by:</b> ' + m.usedBy.map(nodeLink).join(', ') + '</li>' : '<li class="muted">not used by any analyzed function</li>') + (m.invokes.length ? '<li><b>invokes:</b> ' + m.invokes.map((x) => '<a data-machine="' + esc(x) + '">' + esc(machineById.get(x)?.name ?? x) + '</a>').join(', ') + '</li>' : '') + '<li><b>events:</b> ' + m.events.map((e) => '<code>' + esc(e) + '</code>').join(' ') + '</li></ul></div>' +
      '<div class="card"><h3>State tree</h3><div class="tree"><ul>' + stateTree(m.root) + '</ul></div></div>' +
    '</div>';
  $('#copyMmd').addEventListener('click', () => navigator.clipboard.writeText(m.mermaid));
  try {
    const { svg } = await mermaid.render('mmd-' + Math.random().toString(36).slice(2), m.mermaid);
    $('#diagram').innerHTML = svg;
  } catch (e) {
    $('#diagram').innerHTML = '<div class="muted">Could not render diagram: ' + esc(e.message) + '</div><pre>' + esc(m.mermaid) + '</pre>';
  }
}

/* ---------- scripting hook (also used by scripts/render-check.mjs) ---------- */
window.xsa = { data: A, showTab, focusNode, selectMachine, getCy: () => cy };

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
  $('#extTable tbody').innerHTML = rows.map((c) => '<tr><td><span class="badge">' + esc(c.category) + '</span></td><td>' + esc(c.protocol) + '</td><td class="mono">' + esc(c.method ?? '') + '</td><td class="mono">' + (c.node && nodeById.has(c.node) ? '<a data-node="' + esc(c.node) + '">' + esc(c.target ?? '(dynamic)') + '</a>' : esc(c.target ?? '')) + '</td><td class="mono">' + esc(c.callee) + (c.service ? ' <span class="muted">' + esc(c.service) + '</span>' : '') + '</td><td>' + nodeLink(c.caller) + '</td><td class="mono"><a href="' + fileHref(c.file, c.line) + '">' + esc(c.file) + ':' + c.line + '</a></td></tr>').join('') || '<tr><td colspan="7" class="muted">No matching calls.</td></tr>';
}
`;
