/**
 * Local (degraded-mode) graph backend.
 *
 * Implements the same tool contract as the TigerGraph backend, over the derived
 * projection. It reports `kind: 'local-simulated'` and `degraded: true`, and every
 * result carries that marker so the UI, the audit trail and the answer files can
 * state plainly that TigerGraph was not the evidence source for that step.
 */
import { loadProjection } from './load.js';
import { makeQueries } from './queries.js';
import { LocalMemoryStore } from './memory-store.js';
import { loadClosedCases, closedCaseStatistics, findSimilarCases } from './closed-cases.js';
import { toolResult, toolError } from '../contract.js';

export function createLocalBackend({ projectionFile, rawDir, memoryDir }) {
  const started = Date.now();
  const projection = loadProjection(projectionFile);
  const q = makeQueries(projection);
  const { cases: closedCases, byTxn } = loadClosedCases(rawDir, projection);
  const statistics = closedCaseStatistics(closedCases);
  const memory = new LocalMemoryStore(memoryDir);

  // The backend object is progressively decorated with the tool-contract methods
  // below; typed as `any` so each method can be attached without a stub interface.
  const backend: any = {
    kind: 'local-simulated',
    degraded: true,
    notes: [
      'TigerGraph was not reachable, so queries ran against the derived local projection of the same dataset.',
      'Evidence produced in this mode is marked degraded and must not be presented as graph-server evidence.',
    ],
    closedCases,
    statistics,
    memory,
    projection,
  };

  const wrap = (tool, args, fn) => {
    try {
      return toolResult(backend, tool, args, fn());
    } catch (error) {
      return toolError(backend, tool, args, (error as any)?.message ?? String(error));
    }
  };

  const resolveCard = (ref) => q.resolveCard(ref);
  /**
   * Parse a reference timestamp to epoch ms. ISO strings with an explicit zone are
   * parsed as-is; naive datetimes (dataset `YYYY-MM-DD HH:MM:SS`, ISO without a zone)
   * are treated as UTC. Appending `Z` to a string that already ends in `Z` would yield
   * NaN, which silently empties every time-windowed query (`t >= NaN` is false).
   */
  const anchor = (ts) => {
    if (!ts) return null;
    const s = String(ts);
    const ms = Date.parse(/[zZ]$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? null : ms;
  };

  backend.health = async () => wrap('health', {}, () => ({
    backend: backend.kind,
    degraded: true,
    txns: projection.meta.counts.txns,
    cards: projection.meta.counts.cards,
    devices: projection.meta.counts.devices,
    closed_cases: closedCases.length,
    projection_built_at: projection.meta.built_at,
    card_label_fit: projection.meta.card_label_fit,
    memory: memory.stats(),
    identity_lookup: projection.isDenseIdLookup ? 'dense' : 'map',
  }));

  backend.txnDetail = async ({ txn_id }) => wrap('txn_detail', { txn_id }, () => {
    const row = projection.rowOf(txn_id);
    if (row < 0) return { found: false, txn_id: String(txn_id) };
    const cardIdx = projection.cardIdx(row);
    const card = projection.card(cardIdx);
    return {
      found: true,
      txn: q.txnView(row),
      card_summary: q.summaryOfCard(cardIdx),
      closed_case_naming_this_txn: byTxn.get(String(txn_id)) ?? null,
      card_label_source: card.label_source,
    };
  });

  backend.cardWindow = async ({ card_id, hours = 2, around_ts }) => wrap('card_window', { card_id, hours, around_ts }, () => {
    const idx = resolveCard(card_id);
    if (idx < 0) return { found: false, card_id, txns: [] };
    return { found: true, card_id: projection.card(idx).card_id, ...q.cardWindow(idx, hours, anchor(around_ts)) };
  });

  backend.cardHistory = async ({ card_id, days = 30, before_ts }) => wrap('card_history', { card_id, days, before_ts }, () => {
    const idx = resolveCard(card_id);
    if (idx < 0) return { found: false, card_id, txns: [], summary: null };
    return { found: true, card_id: projection.card(idx).card_id, ...q.cardHistory(idx, days, anchor(before_ts)) };
  });

  backend.deviceNeighbors = async ({ device_id, window_days = 14, around_ts }) => wrap(
    'device_neighbors', { device_id, window_days, around_ts },
    () => q.sharedElementCards({ kind: 'device', value: device_id, windowDays: window_days, aroundMs: anchor(around_ts) }),
  );

  backend.regionCluster = async ({ region, window_days = 7, around_ts, exclude_card_id }) => wrap(
    'region_cluster', { region, window_days, around_ts, exclude_card_id },
    () => q.sharedElementCards({
      kind: 'region', value: region, windowDays: window_days,
      aroundMs: anchor(around_ts), excludeCardIdx: exclude_card_id ? resolveCard(exclude_card_id) : -1,
    }),
  );

  backend.emailNeighbors = async ({ email_domain, window_days = 14, around_ts }) => wrap(
    'email_neighbors', { email_domain, window_days, around_ts },
    () => q.sharedElementCards({ kind: 'email', value: email_domain, windowDays: window_days, aroundMs: anchor(around_ts) }),
  );

  backend.linkedCards = async ({ element_type, element_value, window_days = 14, around_ts, exclude_card_id }) => wrap(
    'linked_cards', { element_type, element_value, window_days, around_ts, exclude_card_id },
    () => {
      const res = q.sharedElementCards({
        kind: element_type, value: element_value, windowDays: window_days,
        aroundMs: anchor(around_ts), excludeCardIdx: exclude_card_id ? resolveCard(exclude_card_id) : -1,
      });
      const closedCasesOnCards = [...new Set(res.cards.flatMap((c) => closedCases
        .filter((cc) => cc.card_id === c.card_id)
        .map((cc) => `${cc.case_id}:${cc.outcome}/${cc.pattern}`)))];
      return {
        ...res,
        distinct_customers: [...new Set(res.cards.map((c) => c.customer_id))].length,
        closed_cases_on_these_cards: closedCasesOnCards,
      };
    },
  );

  backend.cardComponent = async ({ card_id, window_days = 14, around_ts }) => wrap(
    'card_component', { card_id, window_days, around_ts },
    () => q.cardComponent(resolveCard(card_id), window_days, anchor(around_ts)),
  );

  backend.cardCentrality = async ({ window_days = 14, around_ts, top_n = 10 }) => wrap(
    'card_centrality', { window_days, around_ts, top_n },
    () => q.cardCentrality(window_days, anchor(around_ts), top_n),
  );

  backend.shortestCardPath = async ({ from_card_id, to_card_id, max_hops = 3, window_days = 14, around_ts }) => wrap(
    'shortest_card_path', { from_card_id, to_card_id, max_hops, window_days, around_ts },
    () => q.shortestCardPath(resolveCard(from_card_id), resolveCard(to_card_id), max_hops, window_days, anchor(around_ts)),
  );

  backend.cardTestingScan = async ({ card_id, hours = 4 }) => wrap(
    'card_testing_scan', { card_id, hours },
    () => q.cardTestingScan(resolveCard(card_id), hours),
  );

  backend.similarClosedCases = async (features, k = 5) => wrap(
    'similar_closed_cases', { ...features, k },
    () => ({
      precedents: findSimilarCases(closedCases, features, k),
      statistics: statistics.overall,
      by_pattern: statistics.by_pattern,
      caveat: 'Precedent is contextual: it informs the assessment, it does not decide the case.',
    }),
  );

  /** Structured subgraph for GraphRAG: the entities in play plus their 1-hop context. */
  backend.graphContext = async ({ entity_ids = [], window_days = 14, around_ts }) => wrap(
    'graph_context', { entity_ids, window_days, around_ts },
    () => {
      const aroundMs = anchor(around_ts);
      const cards = [];
      const devices = new Set();
      const regions = new Set();
      const neighbourCards = new Map();
      for (const id of entity_ids) {
        const text = String(id);
        if (/^C\d{5}(-K\d)?$/.test(text)) {
          const idx = resolveCard(text);
          if (idx < 0) continue;
          const card = projection.card(idx);
          const summary = q.summaryOfCard(idx);
          cards.push({
            card_id: card.card_id, card_key: card.key, customer_id: card.customer_id,
            label_source: card.label_source, summary,
            closed_cases: closedCases.filter((c) => c.card_id === card.card_id).map((c) => c.case_id),
          });
          for (const deviceId of summary.device_profiles) {
            devices.add(deviceId);
            const res = q.sharedElementCards({ kind: 'device', value: deviceId, windowDays: window_days, aroundMs, excludeCardIdx: idx });
            for (const other of res.cards) {
              if (!neighbourCards.has(other.card_id)) neighbourCards.set(other.card_id, { ...other, via: `device:${deviceId}` });
            }
          }
          for (const region of summary.regions) regions.add(region);
        } else if (text.includes('|')) {
          devices.add(text);
          const res = q.sharedElementCards({ kind: 'device', value: text, windowDays: window_days, aroundMs });
          for (const c of res.cards) {
            if (!neighbourCards.has(c.card_id)) neighbourCards.set(c.card_id, { ...c, via: `device:${text}` });
          }
        }
      }
      return {
        cards,
        devices: [...devices],
        regions: [...regions],
        neighbour_cards: [...neighbourCards.values()].slice(0, 25),
        closed_case_context: closedCases
          .filter((c) => cards.some((card) => card.card_id === c.card_id))
          .map((c) => ({ case_id: c.case_id, outcome: c.outcome, pattern: c.pattern, exposure_usd: c.exposure_usd, closed_at: c.closed_at })),
        statistics: { overall: statistics.overall, by_pattern: statistics.by_pattern.slice(0, 8) },
      };
    },
  );

  backend.writeCase = async (record) => wrap('write_case', { case_id: record.case_id }, () => {
    const stored = memory.saveCase(record);
    return {
      written_to_graph: false,
      graph_case_id: '',
      local_record: stored,
      warning: 'TigerGraph not reachable: the case was stored in the local memory store only. Answer files report written_to_graph=false.',
    };
  });

  backend.updateCase = async (caseId, patch) => wrap('update_case', { case_id: caseId }, () => ({
    written_to_graph: false,
    graph_case_id: '',
    record: memory.updateCase(caseId, patch),
  }));

  backend.readCase = async ({ case_id }) => wrap('read_case', { case_id }, () => ({
    found: Boolean(memory.getCase(case_id)),
    record: memory.getCase(case_id),
  }));

  backend.writeEvidence = async ({ case_id, items }) => wrap('write_evidence', { case_id, count: items.length }, () => ({
    written_to_graph: false,
    stored: memory.appendEvidence(case_id, items),
  }));

  backend.writeAudit = async ({ events }) => wrap('write_audit', { count: events.length }, () => ({
    written_to_graph: false,
    stored: memory.appendAudit(events),
  }));

  backend.readAudit = (caseId) => memory.readAudit(caseId);
  // Was missing (audit item 13): dispatch/API read_evidence returned [] without this.
  backend.readEvidence = (caseId) => memory.readEvidence(caseId);
  backend.listLocalCases = () => memory.listCases();
  backend.loadMs = Date.now() - started;

  return backend;
}


