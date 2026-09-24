import { describe, expect, it } from 'vitest';
import { createInvestigationState } from '../src/core/state-factories.js';
import { assessState, closedStatsFor, makeAssessor } from '../src/agent/assess.js';
import { createLlmAdapter } from '../src/llm/index.js';
import type { EvidenceItem, InvestigationState, Trigger } from '../src/core/types.js';
import type { GraphBackend } from '../src/graph/contract.js';

const llm = createLlmAdapter({
  provider: 'deterministic', model: 'deterministic', apiKey: '', baseUrl: '', maxTokens: 100, temperature: 0,
});

const backend = {
  kind: 'local',
  degraded: false,
  statistics: {
    overall: { total: 10, confirmed_fraud_rate: 0.4 },
    by_pattern: [{ pattern: 'card_testing', total: 2, confirmed_fraud_rate: 1 }],
  },
} as unknown as GraphBackend;

const trigger: Trigger = {
  type: 'customer_report',
  transaction_id: 'T-FLAG',
  card_id: 'CARD-1',
  customer_id: 'CUST-1',
  risk_score: null,
  amount_usd: 49,
  ts: '2016-12-10 15:01:21',
  description: 'assess test',
};

function freshState(): InvestigationState {
  const s = createInvestigationState(trigger, 'case-assess');
  const e: EvidenceItem = {
    id: 'e-1',
    case_id: 'case-assess',
    claim: 'flagged transaction detail',
    kind: 'graph_derived',
    source: 'graph',
    ref: 'query:txn_detail',
    entity_ids: ['CARD-1'],
    hypothesis_id: null,
    stance: 'neutral',
    created_at: new Date().toISOString(),
    data: { found: true, txn: { txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'online', device_new_or_found: 'Found', region: '119', ts: '2016-12-10 15:01:21' } },
  };
  s.evidence.push(e);
  s.budget.evidence_items = 1;
  return s;
}

describe('assessState — llm.reason write-back', () => {
  it('populates fraud_probability in [0, 1] and seeds hypotheses once', async () => {
    const s = freshState();
    const result = await assessState(s, llm, backend);
    expect(s.fraud_probability).not.toBe(null);
    expect(s.fraud_probability!).toBeGreaterThanOrEqual(0);
    expect(s.fraud_probability!).toBeLessThanOrEqual(1);
    expect(result.fraud_probability).toBe(s.fraud_probability);
    expect(result.confidence).toMatch(/high|medium|low/);
    expect(s.hypotheses.length).toBe(2);
    expect(s.hypotheses[0].kind).toBe('fraud_explanation');
    expect(s.hypotheses[1].kind).toBe('legitimate_explanation');

    // A second assessment must not duplicate the seeded hypotheses.
    await assessState(s, llm, backend);
    expect(s.hypotheses.length).toBe(2);
  });

  it('annotates decisive stances: clean scan contradicts, New device supports', async () => {
    const s = freshState();
    // The fixture's flagged txn is an ambiguous online purchase ('Found' device → neutral);
    // flip it to a New device to exercise the decisive support signal (README pattern 3).
    const txnEv = s.evidence.find((e) => e.ref === 'query:txn_detail')!;
    (txnEv.data as any).txn.device_new_or_found = 'New';
    s.evidence.push({
      id: 'e-2', case_id: s.case_id, claim: 'scan', kind: 'graph_derived', source: 'graph',
      ref: 'query:card_testing_scan', entity_ids: [], hypothesis_id: null, stance: 'neutral',
      created_at: new Date().toISOString(), data: { sequences: [] },
    });
    await assessState(s, llm, backend);
    expect(s.evidence.find((e) => e.ref === 'query:card_testing_scan')!.stance).toBe('contradicts');
    expect(s.evidence.find((e) => e.ref === 'query:txn_detail')!.stance).toBe('supports');
  });

  it('makeAssessor returns a usable engine hook', async () => {
    const hook = makeAssessor(llm, backend);
    const s = freshState();
    await hook(s);
    expect(s.fraud_probability).not.toBe(null);
  });
});

describe('closedStatsFor', () => {
  it('reads backend statistics and falls back safely', () => {
    const stats = closedStatsFor(backend);
    expect(stats.overall?.total).toBe(10);
    expect(stats.overall?.confirmed_fraud_rate).toBe(0.4);
    expect(stats.by_pattern[0].pattern).toBe('card_testing');

    const empty = closedStatsFor({ kind: 'stub', degraded: true } as GraphBackend);
    expect(empty.overall).toBe(null);
    expect(empty.by_pattern).toEqual([]);
  });
});
