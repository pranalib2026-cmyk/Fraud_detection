import { describe, expect, it } from 'vitest';
import { investigate } from '../src/agent/index.js';
import { findCasePack, loadCasePack } from '../src/evaluator/labels.js';

/**
 * The goal of the assessment wiring, asserted end to end: a full run against the real
 * dataset must produce a non-null fraud probability, multiple evidence items and a
 * policy-citing recommendation — i.e. the evaluator can report real precision instead
 * of `p=n/a`.
 */
describe('investigate end to end (real dataset)', () => {
  it('populates fraud_probability, pattern and recommendation', async () => {
    const pack = findCasePack();
    expect(pack).not.toBe(null);
    const rows = loadCasePack(pack as string);
    const row = rows.find((r) => r.case_id === 'HHG-001');
    expect(row).toBeDefined();

    const result = await investigate(
      {
        type: row!.risk_score !== null ? 'risk_score' : 'customer_report',
        transaction_id: row!.transaction_id,
        card_id: row!.card_id,
        customer_id: row!.customer_id,
        risk_score: row!.risk_score,
        amount_usd: row!.amount_usd,
        ts: row!.opened_at ?? new Date().toISOString(),
        description: 'assessment integration test',
      },
      { maxSteps: 8 },
    );

    expect(result.fraud_probability).not.toBe(null);
    expect(result.fraud_probability!).toBeGreaterThanOrEqual(0);
    expect(result.fraud_probability!).toBeLessThanOrEqual(1);
    expect(result.evidence_count).toBeGreaterThanOrEqual(3);
    expect(result.recommendation).not.toBe(null);
    expect(result.recommendation!.citing_rules.length).toBeGreaterThan(0);
    expect(result.stop_reason).not.toBe(null);
    // assessed_pattern is `string | null` — null means "not assessable", which is fine;
    // `undefined` would mean the field was never wired.
    expect(result.assessed_pattern).not.toBe(undefined);
    expect(result.steps_count).toBeGreaterThan(result.evidence_count);
  }, 60_000);
});
