import { describe, expect, it } from 'vitest';
import { createInvestigationState } from '../src/core/state-factories.js';
import { inferPattern } from '../src/core/pattern-inference.js';
import type { EvidenceItem, InvestigationState, Trigger } from '../src/core/types.js';

const trigger: Trigger = {
  type: 'risk_score',
  transaction_id: 'T-FLAG',
  card_id: 'CARD-1',
  customer_id: 'CUST-1',
  risk_score: 0.6,
  amount_usd: 77,
  ts: '2016-12-05 01:55:28',
  description: 'pattern inference test',
};

function stateWith(items: Array<{ ref: string; data: any }>): InvestigationState {
  const s = createInvestigationState(trigger, 'case-test');
  items.forEach((item, i) => {
    const e: EvidenceItem = {
      id: `e-${i + 1}`,
      case_id: 'case-test',
      claim: 'test evidence',
      kind: 'graph_derived',
      source: 'graph',
      ref: item.ref,
      entity_ids: [],
      hypothesis_id: null,
      stance: 'neutral',
      created_at: new Date().toISOString(),
      data: item.data,
    };
    s.evidence.push(e);
  });
  return s;
}

const txnDetail = (txn: Record<string, unknown>) => ({ ref: 'query:txn_detail', data: { found: true, txn } });
const cardHistory = (txns: Array<Record<string, unknown>>) => ({ ref: 'query:card_history', data: { found: true, card_id: 'CARD-1', txns } });

describe('inferPattern — README § Known Fraud Patterns', () => {
  it('returns null when nothing has been gathered', () => {
    expect(inferPattern(stateWith([]))).toBe(null);
  });

  it('card_testing: a confirmed R5 sequence wins outright', () => {
    const s = stateWith([
      { ref: 'query:card_testing_scan', data: { sequences: [{ small_txns: [], small_total_usd: 3, window_minutes: 12, follow_up: null }] } },
    ]);
    expect(inferPattern(s)).toBe('card_testing');
  });

  it('card_not_present_new_device: online flagged txn on a New device', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'online', device_new_or_found: 'New', region: '119', ts: '2016-12-05 01:55:28' }),
    ]);
    expect(inferPattern(s)).toBe('card_not_present_new_device');
  });

  it('card_not_present_fraud: online burst of two or more within 48h', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'online', device_new_or_found: 'Found', region: '119', ts: '2016-12-05 01:55:28' }),
      cardHistory([
        { txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'online', region: '119', ts: '2016-12-05 01:55:28' },
        { txn_id: 'H1', card_id: 'CARD-1', channel: 'online', region: '119', ts: '2016-12-04 10:00:00' },
        { txn_id: 'H2', card_id: 'CARD-1', channel: 'online', region: '119', ts: '2016-12-03 20:00:00' },
      ]),
    ]);
    expect(inferPattern(s)).toBe('card_not_present_fraud');
  });

  it('stays null for a single ambiguous online purchase (README: verify)', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'online', device_new_or_found: 'Found', region: '119', ts: '2016-12-05 01:55:28' }),
      { ref: 'query:card_testing_scan', data: { sequences: [] } },
    ]);
    expect(inferPattern(s)).toBe(null);
  });

  it('out_of_region_use: card-present txn in a region with no history while activity exists elsewhere', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'in_person', device_new_or_found: null, region: '444.0', ts: '2016-12-05 01:55:28' }),
      cardHistory([
        { txn_id: 'H1', card_id: 'CARD-1', channel: 'in_person', region: '111.0', ts: '2016-11-01 10:00:00' },
        { txn_id: 'H2', card_id: 'CARD-1', channel: 'in_person', region: '111.0', ts: '2016-11-15 09:30:00' },
      ]),
    ]);
    expect(inferPattern(s)).toBe('out_of_region_use');
  });

  it('none: every detector ran clean against real history', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'in_person', device_new_or_found: null, region: '444.0', ts: '2016-12-05 01:55:28' }),
      { ref: 'query:card_testing_scan', data: { sequences: [] } },
      cardHistory([
        { txn_id: 'H1', card_id: 'CARD-1', channel: 'in_person', region: '444.0', ts: '2016-11-01 10:00:00' },
      ]),
    ]);
    expect(inferPattern(s)).toBe('none');
  });

  it('undocumented (R9): shared element with two confirmed-fraud neighbours, no documented pattern', () => {
    const s = stateWith([
      txnDetail({ txn_id: 'T-FLAG', card_id: 'CARD-1', channel: 'in_person', device_new_or_found: null, region: '444.0', ts: '2016-12-05 01:55:28' }),
      { ref: 'query:card_testing_scan', data: { sequences: [] } },
      cardHistory([
        { txn_id: 'H1', card_id: 'CARD-1', channel: 'in_person', region: '444.0', ts: '2016-11-01 10:00:00' },
      ]),
      { ref: 'query:region_cluster', data: { kind: 'region', value: '444.0', cards: [{ card_id: 'CARD-2' }, { card_id: 'CARD-3' }], txns: [] } },
      {
        ref: 'query:linked_cards',
        data: {
          kind: 'region', value: '444.0', cards: [{ card_id: 'CARD-2' }, { card_id: 'CARD-3' }], txns: [],
          closed_cases_on_these_cards: [
            'CC-1:confirmed_fraud/card_not_present_fraud',
            'CC-2:confirmed_fraud/out_of_region_use',
            'CC-3:cleared/none',
          ],
        },
      },
    ]);
    expect(inferPattern(s)).toBe('undocumented');
  });
});
