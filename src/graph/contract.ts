/**
 * Graph tool contract.
 *
 * This is the single interface the investigation engine uses to touch the graph, and
 * it is the same contract exposed through MCP (`docs/mcp-tool-contracts.md`).
 *
 * Two implementations exist:
 *   - `tigergraph`      : installed GSQL queries over RESTPP via the TigerGraph MCP layer
 *   - `local-simulated` : in-process queries over the derived projection, used only when
 *                         TigerGraph is unreachable (documented degraded mode, reported
 *                         in the UI, in audit records and in the answer files)
 *
 * The local backend must never silently stand in for TigerGraph: `kind` and `degraded`
 * are surfaced everywhere a decision is produced.
 */

export const GRAPH_TOOL_NAMES = [
  'txn_detail',
  'card_window',
  'card_history',
  'device_neighbors',
  'region_cluster',
  'email_neighbors',
  'linked_cards',
  'card_component',
  'card_centrality',
  'shortest_card_path',
  'card_testing_scan',
  'similar_closed_cases',
  'graph_context',
  'write_case',
  'update_case',
  'read_case',
  'write_evidence',
  'write_audit',
  'health',
];

/** Every tool result carries provenance so evidence can cite it. */
export function provenance(tool, args) {
  const argText = Object.entries(args ?? {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(', ');
  return `query:${tool}(${argText})`;
}

export function toolResult(backend, tool, args, data, extra = {}) {
  return {
    ok: true,
    tool,
    args,
    data,
    provenance: provenance(tool, args),
    backend: backend.kind,
    degraded: backend.degraded,
    retrieved_at: new Date().toISOString(),
    ...extra,
  };
}

export function toolError(backend, tool, args, message, code = 'TOOL_ERROR') {
  return {
    ok: false,
    tool,
    args,
    error: { code, message },
    provenance: provenance(tool, args),
    backend: backend.kind,
    degraded: backend.degraded,
    retrieved_at: new Date().toISOString(),
  };
}

/** Graph backend interface — shared by local and TigerGraph backends. */
export interface GraphBackend {
  kind: string;
  degraded: boolean;
  notes?: string[];
  txnDetail: (args: { txn_id: string }) => Promise<any>;
  cardWindow: (args: { card_id: string; hours?: number; around_ts?: string }) => Promise<any>;
  cardHistory: (args: { card_id: string; days?: number; before_ts?: string }) => Promise<any>;
  deviceNeighbors: (args: { device_id: string; window_days?: number; around_ts?: string }) => Promise<any>;
  regionCluster: (args: { region: string; window_days?: number; around_ts?: string; exclude_card_id?: string }) => Promise<any>;
  emailNeighbors: (args: { email_domain: string; window_days?: number; around_ts?: string }) => Promise<any>;
  linkedCards: (args: { element_type: string; element_value: string; window_days?: number; around_ts?: string; exclude_card_id?: string }) => Promise<any>;
  cardComponent: (args: { card_id: string; window_days?: number; around_ts?: string }) => Promise<any>;
  cardCentrality: (args: { window_days?: number; around_ts?: string; top_n?: number }) => Promise<any>;
  shortestCardPath: (args: { from_card_id: string; to_card_id: string; max_hops?: number; window_days?: number; around_ts?: string }) => Promise<any>;
  cardTestingScan: (args: { card_id: string; hours?: number }) => Promise<any>;
  similarClosedCases: (features: Record<string, unknown>, k?: number) => Promise<any>;
  graphContext: (args: { entity_ids: string[]; window_days?: number; around_ts?: string }) => Promise<any>;
  writeCase: (record: Record<string, unknown>) => Promise<any>;
  updateCase: (caseId: string, patch: Record<string, unknown>) => Promise<any>;
  readCase: (args: { case_id: string }) => Promise<any>;
  writeEvidence: (args: { case_id: string; items: Record<string, unknown>[] }) => Promise<any>;
  writeAudit: (args: { events: Record<string, unknown>[] }) => Promise<any>;
  health: () => Promise<any>;
  loadMs?: number;
}
