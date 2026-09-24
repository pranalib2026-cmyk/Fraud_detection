/** @module evaluator/report — The evaluator's report shape and Markdown rendering. */

import type { PolicyCheck, ProcessScore } from './quality.js';
import type { Classification, Rates } from './metrics.js';

export interface EvaluationReport {
  generated_at: string;
  pack: string | null;
  label_source: string;
  limit: number | null;
  totals: { cases_in_pack: number; runs: number; labeled: number; unlabeled: number; errors: number };
  classification: Classification;
  rates: Rates;
  pattern_agreement: { compared: number; matched: number; rate: number | null };
  process: ProcessScore;
  latency_ms: Record<string, number>;
  recommendation_distribution: Record<string, number>;
  route_distribution: Record<string, number>;
  status_distribution: Record<string, number>;
  rule_citations: Record<string, number>;
  policy_inconsistencies: PolicyCheck[];
  configuration: Record<string, unknown>;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null): string => (v === null ? 'n/a' : String(v));
const bullets = (record: Record<string, number>): string =>
  Object.keys(record).length ? Object.entries(record).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- none';

/** Render the report as Markdown for the submission bundle. */
export function renderMarkdown(report: EvaluationReport): string {
  const c = report.classification;
  const p = report.process;
  return `# Evaluation report

Generated: ${report.generated_at}
Case pack: \`${report.pack ?? 'not found'}\`
Label source: ${report.label_source}
Trigger construction: only transaction id, card id, customer id, amount and risk score are
passed to the agent. The recorded outcome in the pack is never given to the agent — it is used
only here, to score the result.

## Coverage

| Metric | Value |
| --- | --- |
| Cases in pack | ${report.totals.cases_in_pack} |
| Runs | ${report.totals.runs} |
| Labeled | ${report.totals.labeled} |
| Unlabeled | ${report.totals.unlabeled} |
| Errors | ${report.totals.errors} |

Runs are \`unlabeled\` when the pack records no usable outcome for that case, or when the agent
did not assess a probability. They are reported, never silently dropped.

## Outcome agreement (labeled runs only)

| Metric | Value |
| --- | --- |
| True positives | ${c.true_positive} |
| True negatives | ${c.true_negative} |
| False positives | ${c.false_positive} |
| False negatives | ${c.false_negative} |
| Precision | ${pct(report.rates.precision)} |
| Recall | ${pct(report.rates.recall)} |
| F1 | ${pct(report.rates.f1)} |
| Accuracy | ${pct(report.rates.accuracy)} |
| Specificity | ${pct(report.rates.specificity)} |
| Pattern agreement | ${pct(report.pattern_agreement.rate)} (${report.pattern_agreement.matched}/${report.pattern_agreement.compared}) |

A run counts as "fraud asserted" when its assessed probability is at or above ${(0.7).toFixed(2)},
which is the boundary policy rule R1 draws. Unlabeled runs are excluded from these rates and
from no other metric.

## Process quality (all runs)

| Indicator | Value |
| --- | --- |
| Completed without error | ${pct(p.completed)} |
| Recommendation cited a policy rule | ${pct(p.rules_cited)} |
| Gathered at least one evidence item | ${pct(p.evidence_gathered)} |
| Recorded an explicit stop reason | ${pct(p.stop_reason_recorded)} |
| Produced a recommendation | ${pct(p.recommendation_made)} |
| Mean evidence items per run | ${num(p.mean_evidence)} |
| Mean loop steps per run | ${num(p.mean_steps)} |
| Budget utilisation | ${pct(p.budget_utilisation)} |
| Process grade | ${pct(p.grade)} |

These indicators need no label, so they cover every run. They are what catches an agent that
reaches a plausible answer without gathering evidence or citing the policy.

## Latency

| Percentile | ms |
| --- | --- |
| min | ${report.latency_ms.min} |
| p50 | ${report.latency_ms.p50} |
| p90 | ${report.latency_ms.p90} |
| p95 | ${report.latency_ms.p95} |
| p99 | ${report.latency_ms.p99} |
| max | ${report.latency_ms.max} |
| mean | ${report.latency_ms.mean} |

## Recommendation distribution

${bullets(report.recommendation_distribution)}

## Approval routes

${bullets(report.route_distribution)}

## Run statuses

${bullets(report.status_distribution)}

## Policy rule citations

${bullets(report.rule_citations)}

## Policy consistency warnings

${report.policy_inconsistencies.length
  ? report.policy_inconsistencies.map((w) => `- \`${w.case_id}\`: ${w.note}`).join('\n')
  : 'None — every recommendation sat inside the probability band implied by R1.'}

These are warnings, not failures. R2 (customer denied), R5 (card testing with a cleared
purchase) and R6 (shared origin) legitimately justify blocking below the R1 boundary; the check
accounts for that.
`;
}
