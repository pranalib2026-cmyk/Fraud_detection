/** @module core — STOP / sufficiency checks
 *
 * Sufficiency no longer requires a pre-existing recommendation (the audit defect that made
 * the mid-loop stop unreachable). `evaluateSufficiency` judges the gathered evidence on
 * its own; when it passes, the loop creates the recommendation and stops with
 * `evidence_sufficient`. Budget and no-useful-evidence conditions remain as safeguards.
 */
import { InvestigationState, StopCheckResult } from './types.js';
import { blockingContradictions, blockingUnknowns } from './uncertainty.js';

export interface SufficiencyReport {
  sufficient: boolean;
  graph_evidence: number;
  pattern_known: boolean;
  probability_assessed: boolean;
  blocking_unknowns: string[];
  blocking_contradictions: string[];
}

/** Minimum graph-derived evidence items before a decision can be called defensible. */
export const MIN_GRAPH_EVIDENCE = 4;

export function evaluateSufficiency(state: InvestigationState): SufficiencyReport {
  const graphEvidence = state.evidence.filter((e) => e.source === 'graph').length;
  const blockingU = blockingUnknowns(state);
  const blockingC = blockingContradictions(state);
  const patternKnown = state.assessed_pattern !== null;
  const probabilityAssessed = state.fraud_probability !== null;
  return {
    sufficient: graphEvidence >= MIN_GRAPH_EVIDENCE && patternKnown && probabilityAssessed
      && blockingU.length === 0 && blockingC.length === 0,
    graph_evidence: graphEvidence,
    pattern_known: patternKnown,
    probability_assessed: probabilityAssessed,
    blocking_unknowns: blockingU.map((u) => u.id),
    blocking_contradictions: blockingC.map((c) => c.id),
  };
}

export function checkStop(state: InvestigationState): StopCheckResult {
  const budget_exhausted = state.budget.steps_taken >= state.budget.max_steps;
  const evidence_exhausted = state.budget.evidence_items >= state.budget.max_evidence_items;
  const suff = evaluateSufficiency(state);
  const unresolved_uncertainty = suff.blocking_unknowns.length > 0;
  const contradictions_unresolved = suff.blocking_contradictions.length > 0;

  const reasons: string[] = [];
  if (budget_exhausted) reasons.push('investigation budget exhausted');
  if (evidence_exhausted) reasons.push('evidence budget exhausted');
  if (!suff.sufficient) {
    if (!suff.pattern_known) reasons.push('pattern not yet established');
    if (suff.graph_evidence < MIN_GRAPH_EVIDENCE) reasons.push(`only ${suff.graph_evidence}/${MIN_GRAPH_EVIDENCE} graph evidence items`);
    if (!suff.probability_assessed) reasons.push('probability not assessed');
    if (unresolved_uncertainty) reasons.push(`blocking unknowns: ${suff.blocking_unknowns.join(', ')}`);
    if (contradictions_unresolved) reasons.push(`blocking contradictions: ${suff.blocking_contradictions.join(', ')}`);
  }

  return {
    stop: suff.sufficient,
    reason: suff.sufficient
      ? 'evidence_sufficient'
      : reasons.length ? reasons.join('; ') : 'insufficient evidence for a defensible decision',
    decision_state: suff.sufficient ? 'sufficient' : state.decision_state,
    sufficient_evidence: suff.sufficient,
    unresolved_uncertainty,
    budget_exhausted,
    contradictions_resolved: !contradictions_unresolved,
  };
}
