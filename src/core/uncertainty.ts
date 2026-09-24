/** @module core/uncertainty — Functional unknowns & contradictions.
 * `refreshUncertainty` re-derives the active uncertainty set from gathered evidence after
 * every assessment; unknowns resolve or become unaddressable as coverage progresses.
 * `isBlockingUnknown` tells the stop check what still blocks a defensible decision.
 */
import { InvestigationState, Unknown, Contradiction } from './types.js';
import { findFlaggedTxn, triedTools } from './evidence-helpers.js';

const hasEvidence = (s: InvestigationState, tool: string): boolean => s.evidence.some((e) => e.ref?.includes(tool));
const hasCardsEvidence = (s: InvestigationState): boolean =>
  s.evidence.some((e) => { const d = e.data as any; return Array.isArray(d?.cards) && d.cards.length > 0; });

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const existing = list.find((x) => x.id === item.id);
  if (existing) Object.assign(existing, item); else list.push(item);
}

export function refreshUncertainty(state: InvestigationState): void {
  const pattern = state.assessed_pattern;
  const txn = findFlaggedTxn(state);
  const tried = triedTools(state);
  const clusterTried = ['device_neighbors', 'region_cluster', 'email_neighbors', 'linked_cards'].filter((t) => tried.has(t));

  upsert(state.unknowns, {
    id: 'u-pattern',
    question: 'Which documented fraud pattern fits this activity (if any)?',
    why_it_matters: 'Drives the policy branch (R5/R6/R9) and the SAR decision.',
    related_hypothesis_ids: state.hypotheses.filter((h) => h.kind === 'fraud_explanation').map((h) => h.id),
    status: pattern ? 'addressed' : (tried.has('card_testing_scan') && tried.has('card_history')) ? 'unaddressable' : 'open',
    evidence_that_would_resolve: 'card_testing_scan + card_history (+ txn_detail context)',
  } as Unknown);

  upsert(state.unknowns, {
    id: 'u-history',
    question: "What is this card's normal usage history around the alert?",
    why_it_matters: 'Without history, unusual channel/region/time patterns cannot be judged.',
    related_hypothesis_ids: [],
    status: (hasEvidence(state, 'card_history') || hasEvidence(state, 'card_window') || tried.has('card_history')) ? 'addressed' : 'open',
    evidence_that_would_resolve: 'card_history / card_window on the trigger card',
  } as Unknown);

  upsert(state.unknowns, {
    id: 'u-device',
    question: 'Was the flagged transaction on a new or known device profile?',
    why_it_matters: 'A New device on an online purchase supports pattern 3.',
    related_hypothesis_ids: [],
    status: (txn && (txn.device_new_or_found ?? null)) ? 'addressed' : tried.has('txn_detail') ? 'addressed' : 'open',
    evidence_that_would_resolve: 'txn_detail for the flagged transaction',
  } as Unknown);

  upsert(state.unknowns, {
    id: 'u-cluster',
    question: 'Do other cards share a device, region or email in the window (shared origin)?',
    why_it_matters: 'Shared origin triggers R6 (create case + file report + monitor connected cards).',
    related_hypothesis_ids: [],
    status: hasCardsEvidence(state) ? 'addressed'
      : (clusterTried.length >= 3) || (tried.has('txn_detail') && clusterTried.length >= 1) ? 'unaddressable'
      : 'open',
    evidence_that_would_resolve: 'device_neighbors / region_cluster / email_neighbors / linked_cards',
  } as Unknown);

  if (state.trigger.type === 'customer_report') {
    upsert(state.unknowns, {
      id: 'u-customer',
      question: 'Does the customer recognise the transaction?',
      why_it_matters: 'Customer confirmation/denial decides R2 vs R3.',
      related_hypothesis_ids: [],
      status: state.evidence.some((e) => e.source === 'customer') ? 'addressed' : 'unaddressable',
      evidence_that_would_resolve: 'customer response (controlled outreach action)',
    } as Unknown);
  }

  const scanClean = state.evidence.some((e) => {
    const d = e.data as any;
    return e.ref?.includes('card_testing_scan') && Array.isArray(d?.sequences) && d.sequences.length === 0;
  });
  const highRiskBenign = Boolean(txn && txn.device_new_or_found === 'Found' && (state.trigger.risk_score ?? 0) >= 0.7);
  if (highRiskBenign || (scanClean && (state.trigger.risk_score ?? 0) >= 0.7)) {
    upsert(state.contradictions, {
      id: 'c-signal-vs-graph',
      description: 'Model risk score is high, but graph evidence so far looks benign (known device / clean card-testing scan).',
      evidence_a: ['trigger:risk_score'],
      evidence_b: scanClean ? ['query:card_testing_scan'] : ['query:txn_detail'],
      severity: pattern ? 'medium' : 'high',
      resolution: pattern ? 'carried_into_decision' : 'unresolved',
    } as Contradiction);
  } else {
    const c = state.contradictions.find((x) => x.id === 'c-signal-vs-graph');
    if (c && pattern && c.resolution === 'unresolved') c.resolution = 'carried_into_decision';
  }
}

export function isBlockingUnknown(state: InvestigationState, u: Unknown): boolean {
  if (u.status !== 'open') return false;
  const tried = triedTools(state);
  if (u.id === 'u-pattern') return !(tried.has('card_testing_scan') && tried.has('card_history'));
  if (u.id === 'u-history') return !(tried.has('card_history') || tried.has('card_window'));
  if (u.id === 'u-device') return !tried.has('txn_detail');
  if (u.id === 'u-cluster') {
    const clusterTried = ['device_neighbors', 'region_cluster', 'email_neighbors', 'linked_cards'].filter((t) => tried.has(t));
    return clusterTried.length < 3 && !hasCardsEvidence(state);
  }
  return false; // u-customer: outreach is not an available tool in this build
}

export function blockingUnknowns(state: InvestigationState): Unknown[] {
  return state.unknowns.filter((u) => isBlockingUnknown(state, u));
}

export function blockingContradictions(state: InvestigationState): Contradiction[] {
  return state.contradictions.filter((c) => c.resolution === 'unresolved' && c.severity === 'high');
}
