/** @module evaluator/metrics — Outcome metrics for investigation runs.

 * The evaluator answers two separate questions and never conflates them:
 *
 *   1. Did the agent produce a defensible process? — did it gather evidence, cite policy
 *      rules, respect its budget and stop for a stated reason. See `quality.ts`.
 *   2. Did the agent reach the right answer? — where a label exists (closed-case history,
 *      case pack), did its verdict agree. That is this module.
 *
 * A run can score well on (1) and badly on (2). Reporting both separately is the point: an
 * agent that guessed right without evidence is not a good agent, and a label mismatch on a
 * genuinely ambiguous case is not automatically a defect.
 */

export interface RunOutcome {
  case_id: string;
  fraud_probability: number | null;
  assessed_pattern: string | null;
  recommendation: string | null;
  route: string | null;
  citing_rules: string[];
  steps: number;
  evidence: number;
  stop_reason: string | null;
  error: string | null;
}

export interface LabeledOutcome {
  /** The expected outcome as recorded in the dataset (null when the label is unusable). */
  expected_fraud: boolean | null;
  /** Closed-case pattern, when the reference case recorded one. */
  expected_pattern: string | null;
}

/** The probability at or above which a run asserts fraud. Matches the R1 boundary. */
export const FRAUD_THRESHOLD = 0.70;

export interface Classification {
  true_positive: number;
  true_negative: number;
  false_positive: number;
  false_negative: number;
  /** Runs with no usable label, or with no assessed probability. */
  unlabeled: number;
}

export function classify(runs: RunOutcome[], labels: Map<string, LabeledOutcome>): Classification {
  const c: Classification = { true_positive: 0, true_negative: 0, false_positive: 0, false_negative: 0, unlabeled: 0 };
  for (const run of runs) {
    const label = labels.get(run.case_id);
    if (!label || label.expected_fraud === null || run.fraud_probability === null) { c.unlabeled++; continue; }
    const predicted = run.fraud_probability >= FRAUD_THRESHOLD;
    if (label.expected_fraud && predicted) c.true_positive++;
    else if (label.expected_fraud) c.false_negative++;
    else if (predicted) c.false_positive++;
    else c.true_negative++;
  }
  return c;
}

export interface Rates {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  specificity: number | null;
}

export function rates(c: Classification): Rates {
  const div = (a: number, b: number): number | null => (b === 0 ? null : Number((a / b).toFixed(4)));
  const precision = div(c.true_positive, c.true_positive + c.false_positive);
  const recall = div(c.true_positive, c.true_positive + c.false_negative);
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
    : null;
  return {
    precision,
    recall,
    f1,
    accuracy: div(c.true_positive + c.true_negative, c.true_positive + c.true_negative + c.false_positive + c.false_negative),
    specificity: div(c.true_negative, c.true_negative + c.false_positive),
  };
}

/** Count how often the assessed pattern matched the pattern recorded for the reference case. */
export function patternAgreement(runs: RunOutcome[], labels: Map<string, LabeledOutcome>): { compared: number; matched: number; rate: number | null } {
  let compared = 0;
  let matched = 0;
  for (const run of runs) {
    const label = labels.get(run.case_id);
    if (!label?.expected_pattern || !run.assessed_pattern) continue;
    compared++;
    if (label.expected_pattern === run.assessed_pattern) matched++;
  }
  return { compared, matched, rate: compared ? Number((matched / compared).toFixed(4)) : null };
}

/** Distribution of a derived string key across runs, most frequent first. */
export function distribution(runs: RunOutcome[], pick: (r: RunOutcome) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const run of runs) {
    const key = pick(run) ?? 'none';
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** How often each policy rule was cited across all recommendations. */
export function ruleCitations(runs: RunOutcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const run of runs) {
    for (const rule of run.citing_rules ?? []) out[rule] = (out[rule] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}
