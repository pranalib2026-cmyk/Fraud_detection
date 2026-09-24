/** @module core — State factory and update helpers */

import { InvestigationState, Trigger, Hypothesis, EvidenceItem, Unknown, Contradiction, Step } from './types.js';

export function createInvestigationState(trigger: Trigger, caseId: string): InvestigationState {
  return {
    case_id: caseId,
    trigger,
    status: 'open',
    trigger_ts: trigger.ts,
    opened_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    current_ts: new Date().toISOString().slice(0, 19).replace('T', ' '),
    hypotheses: [],
    evidence: [],
    unknowns: [],
    contradictions: [],
    fraud_probability: null,
    assessed_pattern: null,
    decision_state: 'insufficient',
    steps: [],
    candidate_investigations: [],
    selected_investigation: null,
    recommendation: null,
    nba_initial: null,
    nba_final: null,
    sar: null,
    hypothesis_updates: [],
    authorization: null,
    executed_actions: [],
    budget: {
      max_steps: Number(process.env.HHGOA_MAX_STEPS ?? 12),
      steps_taken: 0,
      max_evidence_items: Number(process.env.HHGOA_MAX_EVIDENCE ?? 30),
      evidence_items: 0,
      max_tools_per_step: Number(process.env.HHGOA_MAX_TOOLS_PER_STEP ?? 3),
    },
    stop_reason: null,
  };
}

export function addEvidence(state: InvestigationState, item: EvidenceItem): InvestigationState {
  state.evidence.push(item);
  state.budget.evidence_items = state.evidence.length;
  if (item.hypothesis_id) {
    const h = state.hypotheses.find(hh => hh.id === item.hypothesis_id);
    if (h) {
      if (item.stance === 'supports') h.supporting.push({ evidence_id: item.id, stance: 'supports' });
      else if (item.stance === 'contradicts') h.contradicting.push({ evidence_id: item.id, stance: 'contradicts' });
    }
  }
  return state;
}

export function addHypothesis(state: InvestigationState, h: Hypothesis): InvestigationState {
  state.hypotheses.push(h);
  return state;
}

export function addUnknown(state: InvestigationState, u: Unknown): InvestigationState {
  state.unknowns.push(u);
  return state;
}

export function addContradiction(state: InvestigationState, c: Contradiction): InvestigationState {
  state.contradictions.push(c);
  return state;
}

export function logStep(state: InvestigationState, step: Omit<Step, 'step_number' | 'timestamp'>): InvestigationState {
  const s: Step = {
    step_number: state.steps.length + 1,
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    ...step,
  };
  state.steps.push(s);
  state.budget.steps_taken = state.steps.length;
  state.current_ts = s.timestamp;
  return state;
}
