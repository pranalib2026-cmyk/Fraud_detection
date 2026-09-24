/**
 * Shared card-graph algorithms.
 *
 * The local backend extracts a shared-element card adjacency from the projection;
 * the TigerGraph backend extracts the same adjacency with the
 * `card_graph_edges` installed query (windowed, bucket-capped in-graph). Both
 * then run THESE identical algorithms so evidence does not depend on which
 * backend served the traversal:
 *
 *   - computeComponent      : connected component over shared elements (BFS)
 *   - computeCentrality     : weighted degree + PageRank (damping 0.85, 20 iters)
 *   - computeShortestPath   : BFS shortest path with explained edges
 *
 * Edge semantics (mirrored from the local query builder):
 *   device -> weight 3, bucket cap 12 | email -> weight 1, cap 6 | region -> weight 0.5, cap 3
 * Bucket caps ignore elements whose value is empty.
 */

export interface CardEdge {
  from: string; // card_id
  to: string;   // card_id
  weight: number;
  via: string;  // 'device:<id>' | 'email:<domain>' | 'region:<code>'
}

export interface CardNodeInfo {
  card_id: string;
  customer_id: string;
  label_source?: string;
}

export function buildAdjacency(edges: CardEdge[]): Map<string, Map<string, { weight: number; via: Set<string> }>> {
  const adjacency = new Map<string, Map<string, { weight: number; via: Set<string> }>>();
  const put = (x: string, y: string, weight: number, via: string) => {
    const m = adjacency.get(x) ?? new Map();
    const e = m.get(y) ?? { weight: 0, via: new Set<string>() };
    e.weight += weight;
    e.via.add(via);
    m.set(y, e);
    adjacency.set(x, m);
  };
  for (const e of edges) {
    if (e.from === e.to) continue;
    put(e.from, e.to, e.weight, e.via);
    put(e.to, e.from, e.weight, e.via);
  }
  return adjacency;
}

/** Connected component of `seedCardId` (BFS over the shared-element graph). */
export function computeComponent(adjacency: Map<string, any>, seedCardId: string) {
  const edges: CardEdge[] = [];
  const seen = new Set<string>([seedCardId]);
  const queue = [seedCardId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [peer, meta] of adjacency.get(cur) ?? []) {
      edges.push({ from: cur, to: peer, weight: meta.weight, via: [...meta.via][0] ?? '' });
      if (!seen.has(peer)) { seen.add(peer); queue.push(peer); }
    }
  }
  return { nodes: [...seen], edges };
}

/** Weighted degree + PageRank over the shared-element card graph. */
export function computeCentrality(adjacency: Map<string, any>, topN = 10, nodeInfo?: (cardId: string) => CardNodeInfo) {
  const nodes = [...adjacency.keys()];
  if (!nodes.length) return { metric: 'weighted_degree + PageRank', nodes: [] };
  const index = new Map(nodes.map((n, i) => [n, i]));
  const N = nodes.length;
  const strength = new Float64Array(N);
  for (const n of nodes) {
    let s = 0;
    for (const [, meta] of adjacency.get(n)) s += meta.weight;
    strength[index.get(n)!] = s;
  }
  let rank = new Float64Array(N).fill(1 / N);
  for (let iter = 0; iter < 20; iter++) {
    const next = new Float64Array(N).fill(0.15 / N);
    for (const n of nodes) {
      const i = index.get(n)!;
      if (strength[i] === 0) continue;
      for (const [peer, meta] of adjacency.get(n)) {
        next[index.get(peer)!] += 0.85 * rank[i] * (meta.weight / strength[i]);
      }
    }
    rank = next;
  }
  const out = nodes.map((n, i) => {
    const info = nodeInfo?.(n);
    return {
      card_id: n,
      customer_id: info?.customer_id ?? '',
      weighted_degree: +strength[i].toFixed(2),
      pagerank: +rank[i].toFixed(6),
      neighbours: adjacency.get(n).size,
      shared_elements: [...new Set([...adjacency.get(n).values()].flatMap((e) => [...e.via]))].slice(0, 10),
    };
  });
  out.sort((a, b) => b.pagerank - a.pagerank);
  return { metric: 'weighted_degree + PageRank(damping=0.85, iterations=20, undirected)', nodes: out.slice(0, topN) };
}

/** BFS shortest path between two cards with explained shared-element edges. */
export function computeShortestPath(adjacency: Map<string, any>, fromCardId: string, toCardId: string, maxHops = 3) {
  if (!adjacency.has(fromCardId) && fromCardId !== toCardId) {
    return { found: false, reason: 'card not found' };
  }
  const prev = new Map<string, { from: string; via: string[] } | null>([[fromCardId, null]]);
  let frontier = [fromCardId];
  let hops = 0;
  while (frontier.length && hops < maxHops) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const [peer, meta] of adjacency.get(cur) ?? []) {
        if (prev.has(peer)) continue;
        prev.set(peer, { from: cur, via: [...meta.via] });
        if (peer === toCardId) {
          const path: Array<{ card_id: string; shared_elements: string[] | null }> = [];
          let node: string | null = toCardId;
          while (node !== null) {
            const step = prev.get(node);
            path.unshift({ card_id: node, shared_elements: step ? step.via : null });
            node = step ? step.from : null;
          }
          return { found: true, hops: path.length - 1, path };
        }
        next.push(peer);
      }
    }
    frontier = next;
    hops++;
  }
  return { found: false, reason: `no path within ${maxHops} hops`, searched_hops: hops };
}
