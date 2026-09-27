/**
 * Pure DAG helpers over `{ source, target }` edge lists. Used to pre-check
 * connection validity while dragging (the server stays authoritative) and to
 * order keyboard navigation.
 */

export type EdgeLike = { source: string; target: string };

function adjacency(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const list = map.get(e.source);
    if (list) list.push(e.target);
    else map.set(e.source, [e.target]);
  }
  return map;
}

/**
 * Would adding `source → target` create a cycle? True when the target already
 * reaches the source (or source === target).
 */
export function wouldCreateCycle(edges: EdgeLike[], source: string, target: string): boolean {
  if (source === target) return true;
  const out = adjacency(edges);
  const seen = new Set<string>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of out.get(current) ?? []) {
      if (next === source) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Topological order of `ids` given `edges` (Kahn). Unknown ids may appear in
 * edges; they are ignored. Order is stable: ties resolve by input order.
 * Cycle members keep their input order at the end (defensive; the server
 * prevents cycles).
 */
export function topologicalOrder(ids: string[], edges: EdgeLike[]): string[] {
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (inDegree.has(e.source) && inDegree.has(e.target)) {
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }
  const order: string[] = [];
  const ready = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const spent = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (spent.has(id)) continue;
    spent.add(id);
    order.push(id);
    for (const e of edges) {
      if (e.source === id && inDegree.has(e.target)) {
        const next = (inDegree.get(e.target) ?? 0) - 1;
        inDegree.set(e.target, next);
        if (next === 0 && !spent.has(e.target)) ready.push(e.target);
      }
    }
  }
  // Cycle leftovers keep input order.
  for (const id of ids) if (!spent.has(id)) order.push(id);
  return order;
}
