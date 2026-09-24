/** @module mcp/names — Tool naming, descriptions and response wrapping.

 * Every tool the MCP server exposes is a thin adapter: it validates arguments, calls the
 * matching method on `GraphBackend`, and wraps the result in the structured response
 * shape documented in `docs/mcp-tool-contracts.md` (`ok`, `tool`, `args`, `data`,
 * `provenance`, `backend`, `degraded`, `retrieved_at`).

 * The wrapper — not the raw payload — is what an MCP client sees, so provenance and the
 * degraded marker travel with every result. That is what lets the audit trail state
 * plainly whether TigerGraph or the local projection produced a given piece of evidence.
 */

import { toolResult, toolError, type GraphBackend } from '../graph/contract.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Tool names are namespaced so several MCP servers can run side by side. */
export const NAMESPACE = process.env.MCP_NAMESPACE ?? 'hhgoa';

export function toolName(short: string): string {
  return `${NAMESPACE}__${String(short).replace(/^.*__/, '')}`;
}

export function shortName(prefixed: string): string {
  const idx = prefixed.indexOf('__');
  return idx === -1 ? prefixed : prefixed.slice(idx + 2);
}

export const DESCRIPTION: Record<string, string> = {
  txn_detail: 'Return full detail for a single transaction: amount, channel, risk score, device, region, billing email and the card it belongs to.',
  card_window: 'Return the transactions of one card inside a time window around an anchor timestamp (R5 card-testing detection).',
  card_history: 'Return the chronological transaction history of one card over a trailing number of days.',
  device_neighbors: 'Find other cards that shared the given device profile in a time window (R6 shared origin).',
  region_cluster: 'Find cards whose billing region matches the given region in a time window (R6 shared origin).',
  email_neighbors: 'Find cards whose billing email domain matches the given domain in a time window (R6 shared origin).',
  linked_cards: 'Find every card linked to a shared element (device, region, email) in a time window, excluding the investigation subject.',
  card_component: 'Return the connected component of cards reachable through shared elements, with the edges that connect them.',
  card_centrality: 'Return weighted degree and PageRank centrality over the shared-element card graph.',
  shortest_card_path: 'Return the shortest path between two cards over shared elements, with every hop explained.',
  card_testing_scan: 'Detect the card-testing sequence: 3+ small online authorizations on one card followed by a larger purchase (R5).',
  similar_closed_cases: 'Retrieve structurally similar closed cases as precedent, with the reasons each one matched.',
  graph_context: 'Return a combined context view for a set of entity ids: cards, devices, regions, neighbouring cards and closed-case context.',
  write_case: 'Write an investigation case record to the graph, or to the local store in degraded mode.',
  update_case: 'Update fields on an existing case record.',
  read_case: 'Read a case record by case_id.',
  read_evidence: 'Read the evidence items stored against a case.',
  read_audit: 'Read the audit trail for a case (or the system trail when no case id is given).',
  write_evidence: 'Append evidence items to a case record.',
  write_audit: 'Append audit events to the trail.',
  health: 'Return backend health: projection counts, closed-case count, memory stats and the degraded flag.',
  backend_config: 'Return the backend configuration visible to this process (paths, kind, tool list).',
  list_tools: 'List every tool this server exposes, with descriptions.',
  investigate: 'Run a full investigation loop for one trigger and return the case, probability, pattern and recommendation.',
  list_cases: 'List the investigation cases stored in this process.',
};

/** Wrap a backend call so provenance + the degraded marker always travel with the data. */
export function wrap(backend: GraphBackend, tool: string, args: Record<string, unknown>, data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toolResult(backend, tool, args, data), null, 2) }], isError: false };
}

export function wrapError(backend: GraphBackend, tool: string, args: Record<string, unknown>, message: string, code = 'TOOL_ERROR'): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toolError(backend, tool, args, message, code), null, 2) }], isError: true };
}
