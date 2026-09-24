/** @module cli/benchmark-stats — Record shape and aggregation for benchmark runs.

 * Kept apart from the run loop so the aggregation can be unit tested on fixture records
 * without running a single investigation.
 */

import type { Trigger } from '../core/types.js';
import type { InvestigationResult } from '../agent/index.js';

export interface BenchRecord {
  case_id: string;
  trigger: Trigger;
  status: string;
  fraud_probability: number | null;
  assessed_pattern: string | null;
  recommendation: string | null;
  route: string | null;
  citing_rules: string[];
  steps: number;
  evidence: number;
  elapsed_ms: number;
  stop_reason: string | null;
  error: string | null;
  timestamp: string;
}

export function toRecord(trigger: Trigger, result: InvestigationResult, elapsedMs: number): BenchRecord {
  return {
    case_id: result.case_id,
    trigger,
    status: result.status,
    fraud_probability: result.fraud_probability,
    assessed_pattern: result.assessed_pattern,
    recommendation: result.recommendation?.action ?? null,
    route: result.recommendation?.route ?? null,
    citing_rules: result.recommendation?.citing_rules ?? [],
    steps: result.steps_count,
    evidence: result.evidence_count,
    elapsed_ms: elapsedMs,
    stop_reason: result.stop_reason,
    error: null,
    timestamp: new Date().toISOString(),
  };
}

export function errorRecord(trigger: Trigger, message: string, elapsedMs: number): BenchRecord {
  return {
    case_id: `error-${trigger.transaction_id}`,
    trigger,
    status: 'error',
    fraud_probability: null,
    assessed_pattern: null,
    recommendation: null,
    route: null,
    citing_rules: [],
    steps: 0,
    evidence: 0,
    elapsed_ms: elapsedMs,
    stop_reason: null,
    error: message,
    timestamp: new Date().toISOString(),
  };
}

/** Linear-interpolated quantile over an unsorted sample. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Count occurrences of a derived key, most frequent first. */
export function distribution(records: BenchRecord[], pick: (r: BenchRecord) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    const key = pick(r) ?? 'none';
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export function summarize(records: BenchRecord[], meta: Record<string, unknown>): Record<string, unknown> {
  const latencies = records.map((r) => r.elapsed_ms);
  const errors = records.filter((r) => r.error).length;
  const round = (n: number): number => Number(n.toFixed(2));
  return {
    ...meta,
    total: records.length,
    errors,
    success_rate: records.length ? round((records.length - errors) / records.length) : 0,
    latency_ms: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: Math.round(quantile(latencies, 0.5)),
      p90: Math.round(quantile(latencies, 0.9)),
      p95: Math.round(quantile(latencies, 0.95)),
      p99: Math.round(quantile(latencies, 0.99)),
      max: latencies.length ? Math.max(...latencies) : 0,
      mean: latencies.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : 0,
    },
    recommendation_distribution: distribution(records, (r) => r.recommendation),
    route_distribution: distribution(records, (r) => r.route),
    pattern_distribution: distribution(records, (r) => r.assessed_pattern),
    status_distribution: distribution(records, (r) => r.status),
    avg_steps: records.length ? round(records.reduce((s, r) => s + r.steps, 0) / records.length) : 0,
    avg_evidence: records.length ? round(records.reduce((s, r) => s + r.evidence, 0) / records.length) : 0,
  };
}
