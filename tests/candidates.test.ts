import { describe, expect, it } from 'vitest';
import { createInvestigationState } from '../src/core/state-factories.js';
import { generateCandidateInvestigations } from '../src/core/candidates.js';
import { GRAPH_TOOL_NAMES } from '../src/graph/contract.js';
import type { EvidenceItem, InvestigationState, Trigger } from '../src/core/types.js';

const trigger: Trigger = {
  type: 'risk_score',
  transaction_id: '3514030',
  card_id: 'C12382-K1',
  customer_id: 'C12382',
  risk_score: 0.61,
  amount_usd: 77.07,
  ts: '2016-12-05 01:55:28',
  description: 'coverage test',
};

function freshState(): InvestigationState {
  return createInvestigationState(trigger, 'case-coverage');
}

function addEvidence(s: InvestigationState, ref: string, data: Record<string, unknown>): void {
  const e: EvidenceItem = {
    id: `e-${s.evidence.length + 1}`, case_id: s.case_id, claim: 'evidence', kind: 'graph_derived',
    source: 'graph', ref, entity_ids: [], hypothesis_id: null, stance: 'neutral',
    created_at: new Date().toISOString(), data,
  };
  s.evidence.push(e);
}

describe('candidate coverage schedule', () => {
  it('proposes txn_detail first with the trigger’s transaction id', () => {
    const s = freshState();
    const cands = generateCandidateInvestigations(s, GRAPH_TOOL_NAMES);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0].tool).toBe('txn_detail');
    expect(cands[0].args).toEqual({ txn_id: '3514030' });
    // No tool may be queued twice in one step.
    const names = cands.map((c) => c.tool);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never queues write/admin tools or arg-less guesses', () => {
    const s = freshState();
    const names = generateCandidateInvestigations(s, GRAPH_TOOL_NAMES).map((c) => c.tool);
    for (const banned of ['write_case', 'update_case', 'read_case', 'write_evidence', 'write_audit', 'shortest_card_path']) {
      expect(names).not.toContain(banned);
    }
  });

  it('skips tried tools and readies shared-element tools from evidence', () => {
    const s = freshState();
    addEvidence(s, 'query:txn_detail', {
      found: true,
      txn: { txn_id: '3514030', card_id: 'C12382-K1', channel: 'in_person', region: '444.0', device_id: 'D|1', email_domain: 'example.com', ts: '2016-12-05 01:55:28' },
    });
    const cands = generateCandidateInvestigations(s, GRAPH_TOOL_NAMES);
    expect(cands.some((c) => c.tool === 'txn_detail')).toBe(false);

    const dev = cands.find((c) => c.tool === 'device_neighbors');
    expect(dev).toBeDefined();
    expect(dev!.args.device_id).toBe('D|1');
    expect(dev!.args.around_ts).toBe(trigger.ts);

    const reg = cands.find((c) => c.tool === 'region_cluster');
    expect(reg).toBeDefined();
    expect(reg!.args.region).toBe('444.0');
    expect(reg!.args.exclude_card_id).toBe('C12382-K1');

    const em = cands.find((c) => c.tool === 'email_neighbors');
    expect(em).toBeDefined();
    expect(em!.args.email_domain).toBe('example.com');
  });

  it('every queued candidate carries question, args and expected impact', () => {
    const s = freshState();
    for (const c of generateCandidateInvestigations(s, GRAPH_TOOL_NAMES)) {
      expect(c.question.length).toBeGreaterThan(0);
      expect(c.args).toBeTypeOf('object');
      expect(c.expected_impact.could_change_decision).toBe(true);
      expect(c.priority).toBeGreaterThan(0);
    }
  });
});
