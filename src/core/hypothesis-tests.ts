/** @module core — Hypothesis-based test suggestions */

import { InvestigationState, CandidateInvestigation } from './types.js';
import { findDeviceInEvidence, findRegionInEvidence } from './evidence-helpers.js';

export function suggestTestsForHypothesis(hyp: any, toolNames: string[], state: InvestigationState): CandidateInvestigation[] {
  const candidates: CandidateInvestigation[] = [];

  if (hyp.pattern === 'card_testing') {
    if (toolNames.includes('card_testing_scan')) {
      candidates.push({
        id: `cand-${state.budget.steps_taken}-test-ct`,
        tool: 'card_testing_scan',
        args: { card_id: state.trigger.card_id, hours: 4 },
        question: `Test hypothesis: ${hyp.claim}`,
        hypothesis_ids: [hyp.id],
        expected_impact: { could_change_decision: true, how: 'confirms or refutes card testing pattern', scenarios: { if_positive: 'supports card testing hypothesis', if_negative: 'refutes card testing hypothesis' } },
        cost: 'low', priority: 9,
      });
    }
  }

  if (hyp.pattern === 'card_not_present_fraud' || hyp.pattern === 'card_not_present_new_device') {
    if (toolNames.includes('device_neighbors')) {
      const deviceId = findDeviceInEvidence(state);
      if (deviceId) {
        candidates.push({
          id: `cand-${state.budget.steps_taken}-test-cnp`,
          tool: 'device_neighbors',
          args: { device_id: deviceId, window_days: 14 },
          question: `Test hypothesis: ${hyp.claim}`,
          hypothesis_ids: [hyp.id],
          expected_impact: { could_change_decision: true, how: 'checks if device was used by other cards', scenarios: { if_positive: 'supports new device fraud hypothesis', if_negative: 'device not shared' } },
          cost: 'low', priority: 8,
        });
      }
    }
  }

  if (hyp.pattern === 'out_of_region_use') {
    if (toolNames.includes('region_cluster')) {
      const region = findRegionInEvidence(state);
      if (region) {
        candidates.push({
          id: `cand-${state.budget.steps_taken}-test-oor`,
          tool: 'region_cluster',
          args: { region, window_days: 7, exclude_card_id: state.trigger.card_id },
          question: `Test hypothesis: ${hyp.claim}`,
          hypothesis_ids: [hyp.id],
          expected_impact: { could_change_decision: true, how: 'checks for other out-of-region activity', scenarios: { if_positive: 'supports out-of-region hypothesis', if_negative: 'no regional cluster' } },
          cost: 'low', priority: 7,
        });
      }
    }
  }

  if (toolNames.includes('graph_context')) {
    const entityIds = new Set<string>();
    entityIds.add(state.trigger.card_id);
    entityIds.add(state.trigger.customer_id);
    for (const e of state.evidence) {
      for (const id of e.entity_ids || []) entityIds.add(id);
    }
    candidates.push({
      id: `cand-${state.budget.steps_taken}-graph-ctx`,
      tool: 'graph_context',
      args: { entity_ids: [...entityIds], window_days: 14 },
      question: `Gather graph context for hypothesis: ${hyp.claim}`,
      hypothesis_ids: [hyp.id],
      expected_impact: { could_change_decision: true, how: 'comprehensive graph context', scenarios: { if_positive: 'context supports hypothesis', if_negative: 'context refutes hypothesis' } },
      cost: 'medium', priority: 5,
    });
  }

  return candidates;
}

