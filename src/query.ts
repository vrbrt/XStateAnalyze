import type { Analysis } from './model.js';

/**
 * Node ids within `depth` hops of every node whose id or name contains `needle`
 * (case-insensitive). Direction limits traversal to callers ('in'), callees ('out') or both.
 */
export function subgraph(a: Analysis, needle: string, depth = 2, direction: 'in' | 'out' | 'both' = 'both'): Set<string> {
  const q = needle.toLowerCase();
  const seeds = a.nodes.filter((n) => n.id.toLowerCase().includes(q) || n.name.toLowerCase().includes(q)).map((n) => n.id);
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of a.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>(seeds);
  let frontier = seeds;
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const nb = [...(direction !== 'in' ? out.get(id) ?? [] : []), ...(direction !== 'out' ? inc.get(id) ?? [] : [])];
      for (const n of nb) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Transitive callers of a node id (who can reach it). */
export function callersOf(a: Analysis, id: string): Set<string> {
  const inc = new Map<string, string[]>();
  for (const e of a.edges) {
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of inc.get(cur) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}
