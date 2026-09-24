/** @module agent/result — Serialisable investigation result.

 * The engine produces a rich `InvestigationState`. Hosts (CLI, API, MCP, evaluator)
 * want a stable, small shape they can print, store or return over the wire. This module
 * defines that shape and the conversion, including the LLM-rendered narrative.
 */

import type { InvestigationState, PolicyAction, Recommendation } from '../core/types.js';
import type { GraphBackend } from '../graph/contract.js';
import type { EvidenceItem as LlmEvidenceItem, LlmAdapter } from '../llm/types.js';
import { synthesizeEvidence } from '../llm/explain.js';
import { RULES } from '../policy/policy.js';

export interface ActionRecord {
  action: PolicyAction;
  route: string;
  status: 'recommended' | 'authorized' | 'requires_human' | 'rejected' | 'executed';
  reason: string;
  citing_rules: string[];
  timestamp: string;
}

export interface InvestigationResult {
  case_id: string;
  status: string;
  fraud_probability: number | null;
  assessed_pattern: string | null;
  stop_reason: string | null;
  recommendation: Recommendation | null;
  nba_initial: import('../core/types.js').NbaRecord | null;
  nba_final: import('../core/types.js').NbaRecord | null;
  sar: import('../policy/sar.js').SarDecision | null;
  hypotheses: import('../core/types.js').Hypothesis[];
  hypothesis_updates: import('../core/types.js').HypothesisUpdate[];
  unknowns: import('../core/types.js').Unknown[];
  contradictions: import('../core/types.js').Contradiction[];
  steps: import('../core/types.js').Step[];
  evidence_items: Array<Pick<import('../core/types.js').EvidenceItem, 'id' | 'claim' | 'kind' | 'source' | 'ref' | 'stance' | 'entity_ids' | 'created_at'>>;
  policy_rules: Array<{ id: string; text: string }>;
  written_to_graph: boolean;
  persisted: boolean;
  actions: ActionRecord[];
  steps_count: number;
  evidence_count: number;
  evidence_summary: string;
  backend_kind: string;
  degraded: boolean;
  summary: string;
}

function toActionRecord(
  rec: { action: string; route: string; reason: string; citing_rules: string[]; timestamp: string },
  status: ActionRecord['status'],
): ActionRecord {
  return {
    action: rec.action as PolicyAction,
    route: rec.route,
    status,
    reason: rec.reason,
    citing_rules: rec.citing_rules,
    timestamp: rec.timestamp,
  };
}

/** Project core evidence onto the LLM layer's view of it. */
export function toLlmEvidence(state: InvestigationState): LlmEvidenceItem[] {
  return state.evidence.map((e) => ({
    id: e.id,
    claim: e.claim,
    kind: e.kind,
    source: e.source,
    ref: e.ref,
    entity_ids: e.entity_ids ?? [],
    stance: e.stance,
  }));
}

export function summarizeResult(state: InvestigationState, evidenceSummary: string): string {
  const lines = [
    `Case ${state.case_id} — status: ${state.status}`,
    `Fraud probability: ${state.fraud_probability != null ? state.fraud_probability.toFixed(2) : 'not assessed'}`,
    `Assessed pattern: ${state.assessed_pattern ?? 'none'}`,
  ];
  if (state.recommendation) {
    lines.push(`Recommendation: ${state.recommendation.action} via ${state.recommendation.route}`);
    lines.push(`Reason: ${state.recommendation.reason}`);
    lines.push(`Citing rules: ${state.recommendation.citing_rules.join(', ') || 'none'}`);
  }
  lines.push(`Stop reason: ${state.stop_reason ?? 'not stopped'}`);
  lines.push(`Steps: ${state.steps.length} · Evidence items: ${state.evidence.length}`);
  lines.push('Evidence:');
  lines.push(evidenceSummary);
  return lines.join('\n');
}

/** Convert a finished investigation state into the host-facing result shape. */
export async function buildResult(state: InvestigationState, llm: LlmAdapter, backend: GraphBackend): Promise<InvestigationResult> {
  const actions: ActionRecord[] = [];
  if (state.recommendation) actions.push(toActionRecord(state.recommendation, 'recommended'));
  for (const ex of state.executed_actions) {
    actions.push(toActionRecord(
      { action: ex.action, route: '', reason: ex.reason, citing_rules: [], timestamp: ex.timestamp },
      ex.status === 'executed' ? 'executed' : ex.status === 'pending' ? 'recommended' : 'rejected',
    ));
  }
  if (state.authorization) {
    actions.push(toActionRecord(
      { action: state.authorization.action, route: state.authorization.route, reason: state.authorization.reason, citing_rules: [], timestamp: state.authorization.timestamp },
      state.authorization.status === 'rejected' ? 'rejected' : state.authorization.status === 'requires_human' ? 'requires_human' : 'authorized',
    ));
  }

  const evidenceItems = toLlmEvidence(state);
  const evidence_summary = evidenceItems.length ? synthesizeEvidence(evidenceItems) : llm.synthesizeEvidence(evidenceItems);

  // Optional LLM-authored SAR narrative — only when a live provider adapter is in use.
  if (state.sar?.required && (llm as any).meta?.mode === 'live' && typeof (llm as any).synthesizeAsync === 'function') {
    try {
      const draft = await (llm as any).synthesizeAsync(
        'Write a standalone suspicious activity report narrative (6-12 sentences: who, what, when, where, how, why).',
        { case_id: state.case_id, pattern: state.assessed_pattern, probability: state.fraud_probability, evidence: evidence_summary },
      );
      if (draft && draft.length > 120) state.sar = { ...state.sar, narrative: draft, narrative_source: 'llm' };
    } catch { /* keep the deterministic template */ }
  }

  return {
    case_id: state.case_id,
    status: state.status,
    fraud_probability: state.fraud_probability,
    assessed_pattern: state.assessed_pattern ?? null,
    stop_reason: state.stop_reason,
    recommendation: state.recommendation,
    nba_initial: state.nba_initial,
    nba_final: state.nba_final,
    sar: state.sar,
    hypotheses: state.hypotheses,
    hypothesis_updates: state.hypothesis_updates,
    unknowns: state.unknowns,
    contradictions: state.contradictions,
    steps: state.steps,
    evidence_items: state.evidence.map((e) => ({
      id: e.id, claim: e.claim, kind: e.kind, source: e.source, ref: e.ref,
      stance: e.stance, entity_ids: e.entity_ids ?? [], created_at: e.created_at,
    })),
    policy_rules: RULES,
    written_to_graph: Boolean((state as any).persisted_written_to_graph),
    persisted: Boolean((state as any).persisted_at),
    actions,
    steps_count: state.steps.length,
    evidence_count: state.evidence.length,
    evidence_summary,
    backend_kind: backend.kind,
    degraded: backend.degraded,
    summary: summarizeResult(state, evidence_summary),
  };
}
