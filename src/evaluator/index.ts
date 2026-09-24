/** @module evaluator — Investigation evaluation harness.

 * The evaluator runs the investigation loop over a case pack, scores the outcomes
 * against ground-truth labels, and writes a Markdown report.
 *
 * Entry points:
 *   - `runEvaluation(rows, labels, options?)` — run the full evaluation, return runs + latencies
 *   - `evaluateRow(row, expected, options?)` — run one pack row through the investigation loop
 *   - `renderMarkdown(report)` — render an EvaluationReport as Markdown
 *   - `classify`, `rates`, `patternAgreement` — outcome metrics
 *   - `processScore`, `policyCheck` — process-quality scoring
 *   - `loadCasePack`, `loadClosedCaseLabels`, `findCasePack`, `labelIndex` — label extraction
 */

export { runEvaluation, evaluateRow, type EvaluatedRun, type RunnerOptions, type RunnerResult, triggerFor } from './runner.js';
export { renderMarkdown } from './report.js';
export type { EvaluationReport } from './report.js';
export { classify, rates, patternAgreement, distribution, ruleCitations, type RunOutcome, type LabeledOutcome, type Classification, type Rates, FRAUD_THRESHOLD } from './metrics.js';
export { processScore, policyCheck, latencyStats, type ProcessScore, type PolicyCheck } from './quality.js';
export { loadCasePack, loadClosedCaseLabels, findCasePack, labelIndex, outcomeToBoolean, type CasePackRow } from './labels.js';
