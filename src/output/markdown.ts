import type { Analysis } from '../model.js';

function cell(s: string | number | undefined): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Human-readable summary: stats, entry points, machines (with Mermaid), external calls. */
export function markdownReport(a: Analysis): string {
  const nodeName = (id: string) => a.nodes.find((n) => n.id === id)?.name ?? id;
  const out: string[] = [];
  out.push(`# Static analysis report`, '', `Root: \`${a.root}\`  `, `Generated: ${a.generatedAt}  `, '');
  out.push('## Summary', '');
  out.push('| Metric | Value |', '|---|---|');
  for (const [k, v] of Object.entries(a.stats)) out.push(`| ${k} | ${v} |`);
  out.push('');
  if (a.packages.length > 1) {
    out.push('## Workspace packages', '', '| Package | Dir | Files |', '|---|---|---|');
    for (const p of a.packages) out.push(`| ${cell(p.name)} | ${cell(p.dir)} | ${p.files} |`);
    out.push('');
  }

  if (a.projects.length > 1) {
    out.push('## Projects', '', '| Project | Language | Service | Hosts | Files |', '|---|---|---|---|---|');
    for (const p of a.projects) out.push(`| ${cell(p.name)} | ${p.language} | ${cell(p.serviceName)}${p.contextPath ? ' ' + cell(p.contextPath) : ''} | ${cell(p.hosts.join(', '))} | ${p.files} |`);
    out.push('');
    if (a.projectEdges.length) {
      out.push('### Project dependencies', '', '```mermaid', 'flowchart LR');
      const id = (s: string) => 'p_' + s.replace(/[^A-Za-z0-9_]/g, '_');
      for (const p of a.projects) out.push(`  ${id(p.name)}["${p.name}"]`);
      for (const e of a.projectEdges) out.push(`  ${id(e.from)} -->|${e.kind} x${e.count}| ${id(e.to)}`);
      out.push('```', '');
    }
  }
  if (a.seams.length) {
    out.push('## API seams', '', '| Status | Kind | Seam | Operation | Callers | Handlers |', '|---|---|---|---|---|---|');
    const party = (p: { project?: string; node: string }) => (a.projects.length > 1 && p.project ? p.project + ':' : '') + nodeName(p.node);
    for (const s of a.seams) out.push(`| ${s.status} | ${s.kind} | ${cell(s.label)} | ${cell(s.operationId)} | ${s.callers.map((c) => cell(party(c))).join(', ')} | ${s.handlers.map((h) => cell(party(h))).join(', ')} |`);
    out.push('');
  }
  const entries = a.nodes.filter((n) => n.entry);
  if (entries.length) {
    out.push('## Entry points (Next.js)', '', '| Kind | Route | Function | File |', '|---|---|---|---|');
    for (const n of entries.sort((x, y) => (x.route ?? '').localeCompare(y.route ?? ''))) {
      out.push(`| ${n.entry} | ${cell(n.route)} ${n.httpMethods?.length && n.httpMethods.length < 7 ? n.httpMethods.join('/') : ''} | ${cell(n.name)} | ${cell(n.file)}:${n.line} |`);
    }
    out.push('');
  }

  if (a.machines.length) {
    out.push('## XState machines', '');
    for (const m of a.machines) {
      out.push(`### ${m.name}`, '', `File: \`${m.file}:${m.line}\` · XState v${m.version} · \`${m.api}\`${m.machineId ? ` · id \`${m.machineId}\`` : ''}`, '');
      if (m.usedBy.length) out.push(`Used by: ${m.usedBy.map((u) => `\`${nodeName(u)}\``).join(', ')}`, '');
      if (m.invokes.length) out.push(`Invokes: ${m.invokes.map((u) => `\`${nodeName(u)}\``).join(', ')}`, '');
      const impl = m.implementations;
      const implLines = (['actions', 'guards', 'actors', 'delays'] as const).filter((k) => impl[k].length).map((k) => `- **${k}**: ${impl[k].map((x) => `\`${x}\``).join(', ')}`);
      if (implLines.length) out.push(...implLines, '');
      if (m.events.length) out.push(`Events: ${m.events.map((e) => `\`${e}\``).join(', ')}`, '');
      out.push('```mermaid', m.mermaid, '```', '');
    }
  }

  if (a.openapi?.operations.length) {
    out.push('## OpenAPI operations', '', `Specs: ${a.openapi.specs.map((s) => `\`${s.file}\``).join(', ')}`, '', '| Method | Path | operationId | Called by | Handled by |', '|---|---|---|---|---|');
    for (const o of a.openapi.operations) out.push(`| ${o.method} | ${cell(o.path)} | ${cell(o.operationId)} | ${(o.callers ?? []).map((c) => cell(nodeName(c))).join(', ')} | ${(o.handlers ?? []).map((c) => cell(nodeName(c))).join(', ')} |`);
    out.push('');
  }

  if (a.externalCalls.length) {
    out.push('## External calls', '');
    const cats = [...new Set(a.externalCalls.map((c) => c.category))];
    for (const cat of cats) {
      const calls = a.externalCalls.filter((c) => c.category === cat);
      out.push(`### ${cat} (${calls.length})`, '', '| Protocol | Method | Target | Callee | Caller | Location |', '|---|---|---|---|---|---|');
      for (const c of calls) {
        out.push(`| ${cell(c.protocol)} | ${cell(c.method)} | ${cell(c.target)} | \`${cell(c.callee)}\` | ${cell(nodeName(c.caller))} | ${cell(c.file)}:${c.line} |`);
      }
      out.push('');
    }
  }

  if (a.warnings.length) {
    out.push('## Warnings', '');
    for (const w of a.warnings) out.push(`- ${w}`);
    out.push('');
  }
  return out.join('\n');
}
