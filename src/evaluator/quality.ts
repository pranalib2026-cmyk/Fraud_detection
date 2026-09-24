/** @module evaluator/quality — Process-quality scoring, independent of any label.

 * These indicators do not need a ground-truth label, so they apply to every run including
 * the ones the dataset never labelled. They are the part of the evaluation that catches an
 * agent that reaches the right answer for the wrong reason — or no reason.
 */

import { FRAUD_THRESHOLD, type RunOutcome } from './metrics.js';

export interface ProcessScore {
  /** Fraction of runs that terminated without an unhandled error. */
  completed: number | null;
  /** Fraction of runs whose recommendation cited at least one policy rule. */
  rules_cited: number | null;
  /** Fraction of runs that gathered at least one piece of evidence. */
  evidence_gathered: number | null;
  /** Fraction of runs that recorded an explicit stop reason. */
  stop_reason_recorded: number | null;
  /** Fraction of runs that produced a recommendation. */
  recommendation_made: number | null;
  /** Mean evidence items per run. */
  mean_evidence: number | null;
  /** Mean loop steps per run. */
  mean_steps: number | null;
  /** Mean steps taken before stopping, as a share of the recommended ceiling. */
  budget_utilisation: number | null;
  /** Overall process grade: the mean of the five boolean indicators. */
  grade: number | null;
}

export function processScore(runs: RunOutcome[], maxSteps = 12): ProcessScore {
  if (!runs.length) {
    return { completed: null, rules_cited: null, evidence_gathered: null, stop_reason_recorded: null, recommendation_made: null, mean_evidence: null, mean_steps: null, budget_utilisation: null, grade: null };
  }
  const ratio = (n: number): number => Number((n / runs.length).toFixed(4));
  const sum = (pick: (r: RunOutcome) => number): number => runs.reduce((s, r) => s + pick(r), 0);

  const completed = ratio(runs.filter((r) => !r.error).length);
  const rules_cited = ratio(runs.filter((r) => (r.citing_rules?.length ?? 0) > 0).length);
  const evidence_gathered = ratio(runs.filter((r) => r.evidence > 0).length);
  const stop_reason_recorded = ratio(runs.filter((r) => Boolean(r.stop_reason)).length);
  const recommendation_made = ratio(runs.filter((r) => Boolean(r.recommendation)).length);

  return {
    completed,
    rules_cited,
    evidence_gathered,
    stop_reason_recorded,
    recommendation_made,
    mean_evidence: Number((sum((r) => r.evidence) / runs.length).toFixed(2)),
    mean_steps: Number((sum((r) => r.steps) / runs.length).toFixed(2)),
    budget_utilisation: maxSteps > 0 ? Number(((sum((r) => r.steps) / runs.length) / maxSteps).toFixed(4)) : null,
    grade: Number(((completed + rules_cited + evidence_gathered + stop_reason_recorded + recommendation_made) / 5).toFixed(4)),
  };
}

export interface PolicyCheck {
  case_id: string;
  recommendation: string | null;
  probability: number | null;
  expected_family: 'act' | 'verify' | 'allow' | 'unknown';
  consistent: boolean;
  note: string;
}

const BLOCKING = ['BLOCK_CARD', 'BLOCK_ALL_CARDS', 'DECLINE_TRANSACTION'];
const ALLOWING = ['ALLOW_TRANSACTION', 'CLOSE_NO_FRAUD'];
/** Rules that legitimately justify blocking below the probability boundary. */
const BLOCK_JUSTIFYING_RULES = ['R2', 'R5', 'R6'];

/**
 * R1 makes the probability boundary meaningful: below 0.70 the agent must not block on a
 * weak signal, and at or above it must not simply allow. R2 (customer denied), R5 (card
 * testing with a cleared purchase) and R6 (shared origin) are the documented exceptions.
 *
 * This is a warning, not a verdict: an inconsistency means the run needs a human read, not
 * that the agent was wrong.
 */
export function policyCheck(run: RunOutcome): PolicyCheck {
  const p = run.fraud_probability;
  const action = run.recommendation;
  const rules = run.citing_rules ?? [];

  const expected_family: PolicyCheck['expected_family'] =
    p === null ? 'unknown' : p >= FRAUD_THRESHOLD ? 'act' : p >= 0.30 ? 'verify' : 'allow';

  if (p === null) {
    return { case_id: run.case_id, recommendation: action, probability: p, expected_family, consistent: false, note: 'no fraud probability was assessed' };
  }
  if (!action) {
    return { case_id: run.case_id, recommendation: null, probability: p, expected_family, consistent: false, note: 'no recommendation was produced' };
  }
  if (p < FRAUD_THRESHOLD && BLOCKING.includes(action) && !rules.some((r) => BLOCK_JUSTIFYING_RULES.includes(r))) {
    return {
      case_id: run.case_id, recommendation: action, probability: p, expected_family, consistent: false,
      note: `blocking action ${action} at probability ${p.toFixed(2)} without an R2/R5/R6 justification`,
    };
  }
  if (p >= FRAUD_THRESHOLD && ALLOWING.includes(action)) {
    return {
      case_id: run.case_id, recommendation: action, probability: p, expected_family, consistent: false,
      note: `allowing action ${action} at probability ${p.toFixed(2)}, above the R1 boundary`,
    };
  }
  return { case_id: run.case_id, recommendation: action, probability: p, expected_family, consistent: true, note: 'consistent with the probability band implied by R1' };
}

/** Latency statistics with linear-interpolated percentiles. */
export function latencyStats(values: number[]): Record<string, number> {
  if (!values.length) return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = p * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return Math.round(lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo));
  };
  return {
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1],
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}
