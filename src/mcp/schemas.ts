/** @module mcp/schemas — Zod argument schemas for the MCP tools.

 * The MCP SDK validates every tool call against these shapes before the handler runs, so
 * a malformed call fails with a protocol-level error instead of reaching the graph with
 * undefined arguments. Descriptions double as the tool documentation an LLM sees.
 */

import { z } from 'zod';

export const SCHEMA = {
  txn_detail: { txn_id: z.string().describe('Transaction id, e.g. 331296') },
  card_window: {
    card_id: z.string().describe('Card id, e.g. C100001'),
    hours: z.number().optional().describe('Window half-width in hours (default 2)'),
    around_ts: z.string().optional().describe('Anchor timestamp; defaults to the latest transaction'),
  },
  card_history: {
    card_id: z.string(),
    days: z.number().optional().describe('Trailing window in days (default 30)'),
    before_ts: z.string().optional(),
  },
  device_neighbors: { device_id: z.string(), window_days: z.number().optional(), around_ts: z.string().optional() },
  region_cluster: { region: z.string(), window_days: z.number().optional(), around_ts: z.string().optional(), exclude_card_id: z.string().optional() },
  email_neighbors: { email_domain: z.string(), window_days: z.number().optional(), around_ts: z.string().optional() },
  linked_cards: {
    element_type: z.string().describe('device | region | email'),
    element_value: z.string(),
    window_days: z.number().optional(),
    around_ts: z.string().optional(),
    exclude_card_id: z.string().optional(),
  },
  card_component: { card_id: z.string(), window_days: z.number().optional(), around_ts: z.string().optional() },
  card_centrality: { window_days: z.number().optional(), around_ts: z.string().optional(), top_n: z.number().optional() },
  shortest_card_path: {
    from_card_id: z.string(),
    to_card_id: z.string(),
    max_hops: z.number().optional().describe('Maximum path length (default 3)'),
    window_days: z.number().optional(),
    around_ts: z.string().optional(),
  },
  card_testing_scan: { card_id: z.string(), hours: z.number().optional(), small_threshold_usd: z.number().optional(), min_small: z.number().optional() },
  similar_closed_cases: {
    features: z.record(z.any()).describe('Feature bag for similarity, e.g. { card_id, device_ids, region, amount_usd }'),
    k: z.number().optional(),
  },
  graph_context: {
    entity_ids: z.array(z.string()).describe('Card ids, device ids or transaction ids to expand'),
    window_days: z.number().optional(),
    around_ts: z.string().optional(),
  },
  write_case: { case_id: z.string(), record: z.record(z.any()).optional() },
  update_case: { case_id: z.string(), patch: z.record(z.any()).optional() },
  read_case: { case_id: z.string() },
  read_evidence: { case_id: z.string() },
  read_audit: { case_id: z.string().optional() },
  write_evidence: { case_id: z.string(), items: z.array(z.record(z.any())).optional(), item: z.record(z.any()).optional() },
  write_audit: { case_id: z.string().optional(), events: z.array(z.record(z.any())).optional(), event: z.record(z.any()).optional() },
  health: {},
  backend_config: {},
  list_tools: {},
  list_cases: {},
  investigate: {
    transaction_id: z.string().optional().describe('Transaction id (alias: txn_id)'),
    txn_id: z.string().optional(),
    card_id: z.string(),
    customer_id: z.string(),
    amount_usd: z.number().optional().describe('Transaction amount in USD (alias: amount)'),
    amount: z.number().optional(),
    risk_score: z.number().optional().describe('Model risk score 0-1 (alias: score)'),
    score: z.number().optional(),
    ts: z.string().optional(),
    trigger_type: z.enum(['risk_score', 'customer_report', 'analyst', 'case_pack']).optional(),
    description: z.string().optional(),
    max_steps: z.number().optional().describe('Override the step budget for this run'),
    max_evidence: z.number().optional().describe('Override the evidence budget for this run'),
  },
} as const;
