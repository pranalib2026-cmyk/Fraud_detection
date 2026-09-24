/** @module evaluator/runner — Runs the agent over pack rows and collects outcomes.

 * Exported separately from the CLI entry point so the same evaluation can be driven from a
 * test, and so a caller can evaluate against an injected backend rather than the local one.
 */

import { investigate } from '../agent/index.js';
import { selectBackend } from '../graph/select.js';
import type { Trigger } from '../core/types.js';
import type { GraphBackend } from '../graph/contract.js';
import type { RunOutcome } from './metrics.js';
import type { CasePackRow } from './labels.js';

export interface EvaluatedRun extends RunOutcome {
  card_id: string;
  elapsed_ms: number;
  expected: { expected_fraud: boolean | null; expected_pattern: string | null } | null;
}

export function triggerFor(row: CasePackRow): Trigger {
  const type: Trigger['type'] =
    row.trigger_type === 'customer_report' ? 'customer_report'
    : row.trigger_type === 'analyst_request' || row.trigger_type === 'analyst' ? 'analyst'
    : row.risk_score !== null ? 'risk_score'
    : 'case_pack';
  return {
    type,
    transaction_id: row.transaction_id,
    card_id: row.card_id,
    customer_id: row.customer_id,
    risk_score: row.risk_score,
    amount_usd: row.amount_usd,
    // Use the pack's own alert timestamp so time-windowed graph queries are anchored to
    // the event (not to wall-clock evaluation time) and runs are reproducible.
    ts: row.opened_at ?? new Date().toISOString(),
    description: row.case_id
      ? `Evaluation pack case ${row.case_id} (transaction ${row.transaction_id})`
      : `Evaluation pack row for transaction ${row.transaction_id}`,
  };
}

export interface RunnerOptions {
  maxSteps?: number;
  maxEvidence?: number;
  backend?: GraphBackend;
  onProgress?: (info: { index: number; total: number; run: EvaluatedRun }) => void;
}

/** Run one pack row through the investigation loop. Never throws — errors become outcomes. */
export async function evaluateRow(
  row: CasePackRow,
  expected: EvaluatedRun['expected'],
  options: RunnerOptions = {},
): Promise<EvaluatedRun> {
  const trigger = triggerFor(row);
  const started = Date.now();
  try {
    const result = await investigate(trigger, {
      maxSteps: options.maxSteps,
      maxEvidence: options.maxEvidence,
      backend: options.backend,
    });
    const rec = result.recommendation;
    return {
      case_id: result.case_id,
      card_id: row.card_id,
      fraud_probability: result.fraud_probability,
      assessed_pattern: result.assessed_pattern,
      recommendation: rec?.action ?? null,
      route: rec?.route ?? null,
      citing_rules: rec?.citing_rules ?? [],
      steps: result.steps_count,
      evidence: result.evidence_count,
      stop_reason: result.stop_reason,
      error: null,
      elapsed_ms: Date.now() - started,
      expected,
    };
  } catch (e: any) {
    return {
      case_id: `error-${row.transaction_id}`,
      card_id: row.card_id,
      fraud_probability: null,
      assessed_pattern: null,
      recommendation: null,
      route: null,
      citing_rules: [],
      steps: 0,
      evidence: 0,
      stop_reason: null,
      error: e?.message ?? String(e),
      elapsed_ms: Date.now() - started,
      expected,
    };
  }
}

export interface RunnerResult {
  runs: EvaluatedRun[];
  latencies: number[];
}

export async function runEvaluation(
  rows: CasePackRow[],
  labels: Map<string, { expected_fraud: boolean | null; expected_pattern: string | null }>,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const runs: EvaluatedRun[] = [];
  const latencies: number[] = [];
  const backend = options.backend ?? await selectBackend();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const run = await evaluateRow(row, labels.get(row.card_id) ?? null, { ...options, backend });
    runs.push(run);
    latencies.push(run.elapsed_ms);
    options.onProgress?.({ index: i, total: rows.length, run });
  }
  return { runs, latencies };
}
