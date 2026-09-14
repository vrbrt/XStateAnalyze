#!/usr/bin/env node
/**
 * Opens a generated report.html in a real browser (Edge/Chrome via puppeteer-core),
 * renders every machine diagram with Mermaid and lays out the call graph with Cytoscape.
 * Catches render-time failures the Mermaid *parser* accepts (e.g. reserved ids).
 *
 *   node scripts/render-check.mjs examples/demo-out/report.html
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'examples/demo-out/report.html';
const candidates = [
  process.env.XSA_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('render-check: no Chromium-based browser found; set XSA_BROWSER=/path/to/chrome');
  process.exit(2);
}
const puppeteer = await import('puppeteer-core');
const browser = await puppeteer.default.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
await page.goto('file:///' + path.resolve(file).split(path.sep).join('/'), { waitUntil: 'networkidle0', timeout: 90000 });
await page.waitForFunction(() => window.xsa && window.mermaid && window.cytoscape, { timeout: 60000 });

let failed = 0;
const machines = await page.evaluate(() => window.xsa.data.machines.map((m) => m.id));
for (const id of machines) {
  const result = await page.evaluate(async (id) => {
    await window.xsa.selectMachine(id);
    const d = document.querySelector('#diagram');
    return d.querySelector('svg') ? 'ok' : d.textContent.slice(0, 300);
  }, id);
  if (result === 'ok') console.log('OK   machine', id);
  else { failed++; console.log('FAIL machine', id, '->', result); }
}
const graph = await page.evaluate(() => {
  window.xsa.showTab('graph');
  const cy = window.xsa.getCy();
  return { nodes: cy.nodes().length, edges: cy.edges().length, total: window.xsa.data.nodes.length };
});
console.log(`graph: ${graph.nodes} nodes / ${graph.edges} edges rendered (of ${graph.total} nodes in data)`);
if (graph.total && !graph.nodes && graph.total <= 400) { failed++; console.log('FAIL graph rendered nothing'); }
for (const e of errors) { failed++; console.log('FAIL', e); }
await browser.close();
console.log(failed ? `${failed} problem(s)` : 'all good');
process.exit(failed ? 1 : 0);
