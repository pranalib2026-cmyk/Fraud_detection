/**
 * Analytical queries over the projection: traversal, shared-entity linking,
 * connected components, weighted degree / PageRank centrality, shortest path and
 * the card-testing sequence detector.
 *
 * These mirror the installed GSQL queries in `gsql/` one-for-one, so the same
 * investigation runs on TigerGraph or (when unreachable) in-process.
 *
 * Each analytical function below carries the name of the installed GSQL query it
 * mirrors (see gsql/3-investigation.gsql), so evidence provenance stays stable
 * across backends: `query:<tool>(args)`.
 */
import { CHANNEL, PRODUCT_BY_INDEX } from './projection.js';
import { buildAdjacency as buildCardGraphById, computeComponent, computeCentrality, computeShortestPath } from '../card-graph.js';

/** Local query -> installed GSQL query name (gsql/3-investigation.gsql). */
export const QUERY_TO_GSQL: Record<string, string> = {
  txn_detail: 'txn_detail',
  card_window: 'card_window',
  card_history: 'card_history',
  device_neighbors: 'device_neighbors',
  region_cluster: 'region_cluster',
  email_neighbors: 'email_neighbors',
  linked_cards: 'linked_cards',
  card_component: 'card_component',
  card_centrality: 'card_centrality',
  shortest_card_path: 'shortest_card_path',
  card_testing_scan: 'card_testing_scan',
  similar_closed_cases: 'similar_closed_cases',
  graph_context: 'graph_context',
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const EMPTY = [];

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function makeQueries(p) {
  const resolveCard = (ref) => {
    if (ref === undefined || ref === null || ref === '') return -1;
    if (typeof ref === 'number') return ref >= 0 && ref < p.meta.cards.length ? ref : -1;
    if (String(ref).includes('|')) {
      const i = p.indexes.cardIndexByKey.get(String(ref));
      return i === undefined ? -1 : i;
    }
    const byId = p.indexes.cardIndexById.get(String(ref));
    if (byId && byId.length) return byId[0];
    const fallback = p.indexes.cardIndexByKey.get(`${ref}|`);
    return fallback === undefined ? -1 : fallback;
  };

  const txnView = (row) => {
    const card = p.card(p.cardIdx(row));
    const deviceIdx = p.deviceIdx(row);
    const risk = p.riskIdx(row);
    return {
      txn_id: String(p.txnId(row)),
      ts: iso(p.ts(row)),
      amount_usd: +p.amount(row).toFixed(2),
      product_cd: p.productIdx(row) === 255 ? null : PRODUCT_BY_INDEX[p.productIdx(row)],
      channel: p.channelIdx(row) === CHANNEL.ONLINE ? 'online' : 'in_person',
      risk_score: risk === 255 ? null : risk / 100,
      customer_id: card.customer_id,
      card_id: card.card_id,
      card_key: card.key,
      card_label_source: card.label_source,
      region: p.region(p.regionIdx(row)),
      country: p.country(p.countryIdx(row)),
      email_domain: p.email(p.emailIdx(row)),
      device_id: deviceIdx >= 0 ? p.device(deviceIdx).device_id : null,
      device_new_or_found: deviceIdx >= 0 ? p.device(deviceIdx).device_new_or_found : null,
      proxy: deviceIdx >= 0 ? p.device(deviceIdx).proxy : null,
      device_type: deviceIdx >= 0 ? p.device(deviceIdx).device_type : null,
    };
  };

  const rowsOfCard = (cardIdx) => (cardIdx < 0 ? EMPTY : p.rowsOfCardIdx(cardIdx));

  function filterByTime(rows, fromMs, toMs) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const t = p.ts(rows[i]);
      if (t >= fromMs && t <= toMs) out.push(rows[i]);
    }
    return out;
  }
  const sortByTime = (rows) => [...rows].sort((a, b) => p.ts(a) - p.ts(b));

  const emptySummary = () => ({
    txns: 0, total_usd: 0, first_ts: null, last_ts: null, products: [], channels: [],
    regions: [], email_domains: [], device_profiles: [], avg_risk: null,
  });

  function summarise(txns) {
    if (!txns.length) return emptySummary();
    return {
      txns: txns.length,
      total_usd: +txns.reduce((s, t) => s + Math.abs(t.amount_usd), 0).toFixed(2),
      first_ts: txns.map((t) => t.ts).sort()[0],
      last_ts: txns.map((t) => t.ts).sort().at(-1),
      products: [...new Set(txns.map((t) => t.product_cd))].filter(Boolean).sort(),
      channels: [...new Set(txns.map((t) => t.channel))].sort(),
      regions: [...new Set(txns.map((t) => t.region))].sort(),
      email_domains: [...new Set(txns.map((t) => t.email_domain))].sort(),
      device_profiles: [...new Set(txns.map((t) => t.device_id).filter(Boolean))],
      avg_risk: +(txns.reduce((s, t) => s + (t.risk_score ?? 0), 0) / txns.length).toFixed(3),
    };
  }

  /** card_window: every transaction on the card inside a time window around a reference time. */
  function cardWindow(cardIdx, hours, aroundMs) {
    const rows = rowsOfCard(cardIdx);
    if (!rows.length) return { txns: [], window_hours: hours, anchor_ts: null, summary: emptySummary() };
    const anchor = aroundMs ?? Math.max(...Array.from(rows, (r) => p.ts(r)));
    const txns = sortByTime(filterByTime(rows, anchor - hours * HOUR, anchor + hours * HOUR)).map(txnView);
    return { txns, window_hours: hours, anchor_ts: iso(anchor), summary: summarise(txns) };
  }

  /** card_history: the card's transactions in the N days before a reference time. */
  function cardHistory(cardIdx, days, beforeMs) {
    const rows = rowsOfCard(cardIdx);
    if (!rows.length) return { txns: [], window_days: days, anchor_ts: null, summary: emptySummary() };
    const anchor = beforeMs ?? Math.max(...Array.from(rows, (r) => p.ts(r)));
    const txns = sortByTime(filterByTime(rows, anchor - days * DAY, anchor)).map(txnView);
    return { txns, window_days: days, anchor_ts: iso(anchor), summary: summarise(txns) };
  }

  function summaryOfCard(cardIdx) {
    return summarise(Array.from(rowsOfCard(cardIdx), txnView));
  }

  /** Shared-entity neighbours: which other cards appear on the same element in a window. */
  function sharedElementCards({ kind, value, windowDays = 14, aroundMs = null as number | null, excludeCardIdx = -1 as number, minTxnsPerCard = 1 }) {
    let rows;
    if (kind === 'device') {
      const idx = p.indexes.deviceIndexById.get(value);
      if (idx === undefined) return { kind, value, cards: [], txns: [] };
      rows = p.rowsOfDeviceIdx(idx);
    } else if (kind === 'region') {
      const idx = p.indexes.regionIndexByValue.get(value);
      if (idx === undefined) return { kind, value, cards: [], txns: [] };
      rows = p.rowsOfRegionIdx(idx);
    } else if (kind === 'email') {
      const idx = p.indexes.emailIndexByValue.get(String(value).toLowerCase());
      if (idx === undefined) return { kind, value, cards: [], txns: [] };
      rows = p.rowsOfEmailIdx(idx);
    } else {
      throw new Error(`unknown shared element kind: ${kind}`);
    }
    const filtered = aroundMs === null ? Array.from(rows) : filterByTime(rows, aroundMs - windowDays * DAY, aroundMs + windowDays * DAY);
    const byCard = new Map();
    for (const r of filtered) {
      const ci = p.cardIdx(r);
      if (ci === excludeCardIdx) continue;
      push(byCard, ci, r);
    }
    const cards = [];
    const txns = [];
    for (const [ci, list] of byCard) {
      if (list.length < minTxnsPerCard) continue;
      const card = p.card(ci);
      const sorted = sortByTime(list);
      cards.push({
        card_id: card.card_id,
        card_key: card.key,
        label_source: card.label_source,
        customer_id: card.customer_id,
        txn_count: list.length,
        total_usd: +list.reduce((s, r) => s + Math.abs(p.amount(r)), 0).toFixed(2),
        first_ts: iso(p.ts(sorted[0])),
        last_ts: iso(p.ts(sorted[sorted.length - 1])),
        txn_ids: sorted.map((r) => String(p.txnId(r))),
      });
      for (const r of sorted) txns.push(txnView(r));
    }
    cards.sort((a, b) => b.txn_count - a.txn_count);
    txns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { kind, value, window_days: windowDays, cards, txns };
  }

  /**
   * Card-level weighted graph: nodes are cards, edges are shared device profiles
   * (weight 3), shared purchaser email domains (weight 1) and shared billing
   * regions inside the time window (weight 0.5). Bucket sizes are capped so that
   * "half the dataset shares a region" does not create noise.
   */
  function buildCardGraph(windowDays, aroundMs) {
    const adjacency = new Map();
    const addEdge = (a, b, via, weight) => {
      if (a === b) return;
      const put = (x, y) => {
        const m = adjacency.get(x) ?? new Map();
        const e = m.get(y) ?? { weight: 0, via: new Set() };
        e.weight += weight;
        e.via.add(via);
        m.set(y, e);
        adjacency.set(x, m);
      };
      put(a, b);
      put(b, a);
    };
    const link = (buckets, weight, maxBucket, prefix, minBucket = 2) => {
      for (const [value, cards] of buckets) {
        if (!value || value === '-1') continue;
        const uniq = [...new Set(cards)];
        if (uniq.length < minBucket || uniq.length > maxBucket) continue;
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) addEdge(uniq[i], uniq[j], `${prefix}:${value}`, weight);
        }
      }
    };

    const fromMs = aroundMs === null || aroundMs === undefined ? null : aroundMs - windowDays * DAY;
    const toMs = aroundMs === null || aroundMs === undefined ? null : aroundMs + windowDays * DAY;
    const deviceBuckets = new Map();
    const emailBuckets = new Map();
    const regionBuckets = new Map();
    for (let row = 0; row < p.n; row++) {
      if (fromMs !== null) {
        const t = p.ts(row);
        if (t < fromMs || t > toMs) continue;
      }
      const ci = p.cardIdx(row);
      const d = p.deviceIdx(row);
      if (d >= 0) push(deviceBuckets, p.device(d).device_id, ci);
      push(emailBuckets, p.email(p.emailIdx(row)), ci);
      push(regionBuckets, p.region(p.regionIdx(row)), ci);
    }
    link(deviceBuckets, 3, 12, 'device');
    link(emailBuckets, 1, 6, 'email');
    if (fromMs !== null) link(regionBuckets, 0.5, 3, 'region');
    return adjacency;
  }

  /**
   * The shared-element adjacency keyed by card *index* is translated to the
   * card_id-keyed edge list consumed by src/graph/card-graph.ts, so the local
   * backend and the TigerGraph backend (card_graph_edges query) run the exact
   * same component/centrality/path algorithms.
   */
  function sharedAdjacency(windowDays, aroundMs) {
    const byIdx = buildCardGraph(windowDays, aroundMs);
    const edges = [];
    for (const [fromIdx, peers] of byIdx) {
      for (const [toIdx, meta] of peers) {
        for (const via of meta.via) {
          const kind = via.startsWith('device:') ? 3 : via.startsWith('email:') ? 1 : 0.5;
          edges.push({ from: p.card(fromIdx).card_id, to: p.card(toIdx).card_id, weight: kind, via });
        }
      }
    }
    return buildCardGraphById(edges);
  }

  /** Connected component of the shared-element card graph (graph algorithm). */
  function cardComponent(cardIdx, windowDays, aroundMs) {
    if (cardIdx < 0) return { nodes: [], edges: [], size: 0 };
    const adjacency = sharedAdjacency(windowDays, aroundMs);
    const seed = p.card(cardIdx).card_id;
    const raw = computeComponent(adjacency, seed);
    const idxOf = new Map(p.meta.cards.map((c, i) => [c.card_id, i]));
    const edges = raw.edges.map((e) => ({
      from: e.from,
      to: e.to,
      weight: +e.weight.toFixed(2),
      shared_elements: e.via ? [e.via] : [],
    }));
    // merge parallel edges that share endpoints (different via labels)
    const merged = new Map();
    for (const e of edges) {
      const key = [e.from, e.to].sort().join('::');
      const cur = merged.get(key) ?? { from: e.from, to: e.to, weight: 0, shared_elements: [] };
      cur.weight = +(cur.weight + e.weight).toFixed(2);
      for (const v of e.shared_elements) if (!cur.shared_elements.includes(v)) cur.shared_elements.push(v);
      merged.set(key, cur);
    }
    return {
      size: raw.nodes.length,
      nodes: raw.nodes.map((id) => {
        const i = idxOf.get(id);
        return {
          card_id: id,
          customer_id: i === undefined ? '' : p.card(i).customer_id,
          label_source: i === undefined ? '' : p.card(i).label_source,
        };
      }),
      edges: [...merged.values()],
    };
  }

  /** Weighted degree + PageRank over the shared-element card graph. */
  function cardCentrality(windowDays, aroundMs, topN = 10) {
    const adjacency = sharedAdjacency(windowDays, aroundMs);
    return computeCentrality(adjacency, topN, (cardId) => {
      const i = p.indexes.cardIndexById.get(cardId)?.[0];
      return i === undefined ? { card_id: cardId, customer_id: '' } : p.card(i);
    });
  }

  /** Shortest path between two cards over shared elements (BFS, edges explained). */
  function shortestCardPath(fromIdx, toIdx, maxHops = 3, windowDays = 14, aroundMs = null as number | null) {
    if (fromIdx < 0 || toIdx < 0) return { found: false, reason: 'card not found' };
    const adjacency = sharedAdjacency(windowDays, aroundMs);
    return computeShortestPath(adjacency, p.card(fromIdx).card_id, p.card(toIdx).card_id, maxHops);
  }


  /**
   * R5 detector: three or more small online authorizations on one card within an
   * hour, followed by a larger purchase. Returns the raw sequences, never a verdict.
   */
  function cardTestingScan(cardIdx, hours = 4, smallThresholdUsd = 5, minSmall = 3) {
    const txns = sortByTime(rowsOfCard(cardIdx));
    const sequences = [];
    for (let i = 0; i < txns.length; i++) {
      if (p.channelIdx(txns[i]) !== CHANNEL.ONLINE) continue;
      if (Math.abs(p.amount(txns[i])) > smallThresholdUsd) continue;
      const group = [txns[i]];
      let j = i + 1;
      while (j < txns.length && p.ts(txns[j]) - p.ts(txns[i]) <= hours * HOUR) {
        if (p.channelIdx(txns[j]) !== CHANNEL.ONLINE || Math.abs(p.amount(txns[j])) > smallThresholdUsd) break;
        group.push(txns[j]);
        j++;
      }
      if (group.length >= minSmall) {
        const last = group[group.length - 1];
        const followUp = txns.slice(j).find(
          (r) => p.ts(r) - p.ts(last) <= hours * HOUR && Math.abs(p.amount(r)) > smallThresholdUsd,
        ) ?? null;
        sequences.push({
          small_txns: group.map(txnView),
          small_total_usd: +group.reduce((s, r) => s + Math.abs(p.amount(r)), 0).toFixed(2),
          window_minutes: Math.round((p.ts(last) - p.ts(group[0])) / 60000),
          follow_up: followUp ? txnView(followUp) : null,
        });
        i = j - 1;
      }
    }
    return {
      sequences,
      parameters: { hours, small_amount_threshold_usd: smallThresholdUsd, min_small_txns: minSmall },
    };
  }

  return {
    resolveCard,
    txnView,
    rowsOfCard,
    filterByTime,
    cardWindow,
    cardHistory,
    summaryOfCard,
    summarise,
    sharedElementCards,
    buildCardGraph,
    cardComponent,
    cardCentrality,
    shortestCardPath,
    cardTestingScan,
  };
}



