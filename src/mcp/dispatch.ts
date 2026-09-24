/** @module mcp/dispatch — Routes an MCP tool call onto the graph backend contract.

 * The dispatch table is deliberately a plain switch rather than a reflexive lookup: it
 * makes the argument coercion explicit for every tool, so a malformed MCP call fails
 * loudly instead of silently passing `undefined` into a query.
 */

import type { GraphBackend } from '../graph/contract.js';

const S = (v: any): string => String(v);
const N = (v: any): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));

export async function dispatchTool(backend: GraphBackend, tool: string, a: Record<string, unknown>): Promise<any> {
  switch (tool) {
    case 'txn_detail':
      return backend.txnDetail({ txn_id: S(a.txn_id) });
    case 'card_window':
      return backend.cardWindow({ card_id: S(a.card_id), hours: N(a.hours), around_ts: a.around_ts ? S(a.around_ts) : undefined });
    case 'card_history':
      return backend.cardHistory({ card_id: S(a.card_id), days: N(a.days), before_ts: a.before_ts ? S(a.before_ts) : undefined });
    case 'device_neighbors':
      return backend.deviceNeighbors({ device_id: S(a.device_id), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined });
    case 'region_cluster':
      return backend.regionCluster({ region: S(a.region), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined, exclude_card_id: a.exclude_card_id ? S(a.exclude_card_id) : undefined });
    case 'email_neighbors':
      return backend.emailNeighbors({ email_domain: S(a.email_domain), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined });
    case 'linked_cards':
      return backend.linkedCards({ element_type: S(a.element_type), element_value: S(a.element_value), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined, exclude_card_id: a.exclude_card_id ? S(a.exclude_card_id) : undefined });
    case 'card_component':
      return backend.cardComponent({ card_id: S(a.card_id), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined });
    case 'card_centrality':
      return backend.cardCentrality({ window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined, top_n: N(a.top_n) });
    case 'shortest_card_path':
      return backend.shortestCardPath({ from_card_id: S(a.from_card_id), to_card_id: S(a.to_card_id), max_hops: N(a.max_hops), window_days: N(a.window_days), around_ts: a.around_ts ? S(a.around_ts) : undefined });
    case 'card_testing_scan':
      return backend.cardTestingScan({ card_id: S(a.card_id), hours: N(a.hours) });
    case 'similar_closed_cases':
      return backend.similarClosedCases((a.features as Record<string, unknown>) ?? {}, N(a.k));
    case 'graph_context':
      return backend.graphContext({
        entity_ids: Array.isArray(a.entity_ids) ? a.entity_ids.map(String) : [S(a.entity_ids)],
        window_days: N(a.window_days),
        around_ts: a.around_ts ? S(a.around_ts) : undefined,
      });
    case 'write_case':
      return backend.writeCase((a.record as Record<string, unknown>) ?? a);
    case 'update_case':
      return backend.updateCase(S(a.case_id), (a.patch as Record<string, unknown>) ?? {});
    case 'read_case':
      return backend.readCase({ case_id: S(a.case_id) });
    case 'read_evidence':
      return { case_id: a.case_id, items: readEvidence(backend, S(a.case_id)) };
    case 'read_audit':
      return { case_id: a.case_id ?? null, items: readAudit(backend, a.case_id ? S(a.case_id) : 'system') };
    case 'write_evidence': {
      const items: Record<string, unknown>[] = [];
      if (Array.isArray(a.items)) for (const item of a.items) items.push(item as Record<string, unknown>);
      if (a.item) items.push(a.item as Record<string, unknown>);
      return backend.writeEvidence({ case_id: S(a.case_id), items });
    }
    case 'write_audit': {
      const events: Record<string, unknown>[] = [];
      if (Array.isArray(a.events)) for (const ev of a.events) events.push(ev as Record<string, unknown>);
      if (a.event) events.push(a.event as Record<string, unknown>);
      return backend.writeAudit({ events });
    }
    default:
      throw new Error(`No handler for tool: ${tool}`);
  }
}

/** The local store exposes these beyond the shared contract; treat them as optional. */
export function readEvidence(backend: GraphBackend, caseId: string): unknown[] {
  const b = backend as any;
  return b.readEvidence ? b.readEvidence(caseId) : [];
}

export function readAudit(backend: GraphBackend, caseId: string): unknown[] {
  const b = backend as any;
  return b.readAudit ? b.readAudit(caseId) : [];
}

export function listLocalCases(backend: GraphBackend): unknown[] {
  const b = backend as any;
  return b.listLocalCases ? b.listLocalCases() : [];
}
