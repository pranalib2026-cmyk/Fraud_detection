/** @module core — Candidate investigation generation
 *
 * Candidates come from three sources, best-priority first:
 *   1. open unknowns and active hypotheses (the adaptive part of the loop),
 *   2. a coverage schedule of graph tools that are *ready* (their required entity is
 *      known from the trigger or from evidence) and *untried* (no evidence yet carries
 *      their ref). This is what keeps the loop gathering evidence after the first step:
 *      without it, an empty unknowns/hypotheses list would yield zero candidates and the
 *      run would idle to the step budget with a single evidence item.
 */

import { InvestigationState, CandidateInvestigation } from './types.js';
import { suggestTestsForHypothesis } from './hypothesis-tests.js';
import {
  extractSimilarCaseFeatures, findDeviceInEvidence, findRegionInEvidence,
  findEmailInEvidence, triedTools,
} from './evidence-helpers.js';

export function generateCandidateInvestigations(state: InvestigationState, toolNames: string[]): CandidateInvestigation[] {
  const candidates: CandidateInvestigation[] = [];
  const tried = triedTools(state);
  const openUnknowns = state.unknowns.filter(u => u.status === 'open');

  for (const unknown of openUnknowns) {
    for (const c of suggestToolsForUnknown(unknown, toolNames, state)) {
      if (!tried.has(c.tool)) candidates.push(c);
    }
  }

  for (const hyp of state.hypotheses) {
    if (hyp.status === 'active') {
      for (const c of suggestTestsForHypothesis(hyp, toolNames, state)) {
        if (tried.has(c.tool)) continue;
        if (!candidates.some(ex => ex.id === c.id)) candidates.push(c);
      }
    }
  }

  // Coverage pass: ready, untried tools — fills in what the hypothesis-driven sources
  // did not ask for. `existing` keeps it from queueing a tool twice in one step.
  const existing = new Set(candidates.map(c => c.tool));
  for (const spec of COVERAGE) {
    if (!toolNames.includes(spec.tool)) continue;
    if (tried.has(spec.tool) || existing.has(spec.tool)) continue;
    if (!spec.ready(state)) continue;
    existing.add(spec.tool);
    candidates.push(makeCandidate(state, spec.tool, spec.args(state), spec.question, spec.priority, spec.how, spec.ifPositive, spec.ifNegative));
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, 10);
}

/** A graph tool in the coverage schedule: when it can run, and with which arguments. */
interface CoverageSpec {
  tool: string;
  priority: number;
  question: string;
  how: string;
  ifPositive: string;
  ifNegative: string;
  ready: (state: InvestigationState) => boolean;
  args: (state: InvestigationState) => Record<string, unknown>;
}

const hasCard = (s: InvestigationState) => Boolean(s.trigger.card_id);
const hasDevice = (s: InvestigationState) => Boolean(findDeviceInEvidence(s));
const hasRegion = (s: InvestigationState) => Boolean(findRegionInEvidence(s));
const hasEmail = (s: InvestigationState) => Boolean(findEmailInEvidence(s));
const hasElement = (s: InvestigationState) => hasDevice(s) || hasRegion(s) || hasEmail(s);

function elementArgs(s: InvestigationState): Record<string, unknown> {
  const device = findDeviceInEvidence(s);
  if (device) return { element_type: 'device', element_value: device, window_days: 14, around_ts: s.trigger.ts, exclude_card_id: s.trigger.card_id };
  const region = findRegionInEvidence(s);
  if (region) return { element_type: 'region', element_value: region, window_days: 7, around_ts: s.trigger.ts, exclude_card_id: s.trigger.card_id };
  return { element_type: 'email', element_value: findEmailInEvidence(s), window_days: 14, around_ts: s.trigger.ts, exclude_card_id: s.trigger.card_id };
}

function contextEntityIds(s: InvestigationState): string[] {
  const ids = new Set<string>([s.trigger.card_id, s.trigger.customer_id]);
  for (const e of s.evidence) for (const id of e.entity_ids || []) if (id) ids.add(id);
  return [...ids];
}

/**
 * Ordered by investigative value: flagged txn first (unlocks device/region/email facts),
 * then the R5 detector, then window/history (which pattern inference needs), then
 * shared-element searches once an element is known, then precedent and graph context.
 */
const COVERAGE: CoverageSpec[] = [
  { tool: 'txn_detail', priority: 9, question: 'What happened in the flagged transaction?',
    how: 'establishes primary facts', ifPositive: 'facts sharpen the assessment', ifNegative: 'txn unknown — degraded',
    ready: (s) => Boolean(s.trigger.transaction_id), args: (s) => ({ txn_id: s.trigger.transaction_id }) },
  { tool: 'card_testing_scan', priority: 8, question: 'Is there a card testing sequence (3+ small online charges then a larger purchase)?',
    how: 'runs the R5 detector', ifPositive: 'confirms card testing (R5)', ifNegative: 'no card testing sequence',
    ready: hasCard, args: (s) => ({ card_id: s.trigger.card_id, hours: 4 }) },
  { tool: 'card_window', priority: 7, question: 'What else happened on this card around the flagged time?',
    how: 'shows local burst context', ifPositive: 'burst activity around the flag', ifNegative: 'flagged txn isolated in time',
    ready: hasCard, args: (s) => ({ card_id: s.trigger.card_id, hours: 24, around_ts: s.trigger.ts }) },
  { tool: 'card_history', priority: 7, question: 'How has this card normally been used before the flag?',
    how: 'establishes the cardholder baseline', ifPositive: 'deviation from baseline', ifNegative: 'activity matches baseline',
    ready: hasCard, args: (s) => ({ card_id: s.trigger.card_id, days: 30, before_ts: s.trigger.ts }) },
  { tool: 'device_neighbors', priority: 6, question: 'Which other cards shared this device profile in the window?',
    how: 'reveals other cards on the same device (R6)', ifPositive: 'shared device links other cards', ifNegative: 'device not shared',
    ready: hasDevice, args: (s) => ({ device_id: findDeviceInEvidence(s), window_days: 14, around_ts: s.trigger.ts }) },
  { tool: 'region_cluster', priority: 6, question: 'Which other cards billed in this region in the window?',
    how: 'reveals a regional cluster (R6)', ifPositive: 'regional cluster found', ifNegative: 'no regional cluster',
    ready: hasRegion, args: (s) => ({ region: findRegionInEvidence(s), window_days: 7, around_ts: s.trigger.ts, exclude_card_id: s.trigger.card_id }) },
  { tool: 'email_neighbors', priority: 5, question: 'Which other cards used this recipient email domain?',
    how: 'reveals a shared recipient email (R6)', ifPositive: 'shared email links other cards', ifNegative: 'email not shared',
    ready: hasEmail, args: (s) => ({ email_domain: findEmailInEvidence(s), window_days: 14, around_ts: s.trigger.ts }) },
  { tool: 'similar_closed_cases', priority: 5, question: 'How were structurally similar closed cases resolved?',
    how: 'provides precedent context', ifPositive: 'precedents lean toward fraud', ifNegative: 'precedents lean toward clearing',
    ready: () => true, args: (s) => extractSimilarCaseFeatures(s) },
  { tool: 'linked_cards', priority: 4, question: 'What is connected through the shared element, including prior outcomes?',
    how: 'combines links with closed-case outcomes (R6/R9)', ifPositive: 'connected cards show confirmed fraud', ifNegative: 'no confirmed fraud among neighbours',
    ready: hasElement, args: (s) => elementArgs(s) },
  { tool: 'card_component', priority: 4, question: 'How large is this card’s connected component?',
    how: 'shows fraud-ring connectivity', ifPositive: 'large component', ifNegative: 'isolated card',
    ready: hasCard, args: (s) => ({ card_id: s.trigger.card_id, window_days: 14, around_ts: s.trigger.ts }) },
  { tool: 'graph_context', priority: 3, question: 'What is the 1-hop graph context of the entities in play?',
    how: 'gathers comprehensive graph context', ifPositive: 'context supports the concern', ifNegative: 'context is unremarkable',
    ready: () => true, args: (s) => ({ entity_ids: contextEntityIds(s), window_days: 14, around_ts: s.trigger.ts }) },
  { tool: 'card_centrality', priority: 3, question: 'Is this card among the most central in the recent fraud graph?',
    how: 'places the card in the graph-wide ranking', ifPositive: 'highly central card', ifNegative: 'peripheral card',
    ready: () => true, args: (s) => ({ window_days: 14, around_ts: s.trigger.ts, top_n: 10 }) },
];

function makeCandidate(state: InvestigationState, tool: string, args: Record<string, unknown>, q: string, priority: number, how: string, ifPos: string, ifNeg: string, hids: string[] = []): CandidateInvestigation {
  return {
    id: `cand-${state.budget.steps_taken}-${tool}`,
    tool, args, question: q, hypothesis_ids: hids,
    expected_impact: { could_change_decision: true, how, scenarios: { if_positive: ifPos, if_negative: ifNeg } },
    cost: 'low', priority,
  };
}

function suggestToolsForUnknown(unknown: any, toolNames: string[], state: InvestigationState): CandidateInvestigation[] {
  const out: CandidateInvestigation[] = [];
  const q = (unknown.question || '').toLowerCase();
  const hids = unknown.related_hypothesis_ids || [];
  const cardId = state.trigger.card_id;

  if (q.includes('device') || q.includes('shared')) {
    const dv = findDeviceInEvidence(state);
    if (dv && toolNames.includes('device_neighbors'))
      out.push(makeCandidate(state, 'device_neighbors', { device_id: dv, window_days: 14 }, unknown.question, 8, 'reveals other cards on same device', 'shared device', 'no shared device', hids));
  }
  if (q.includes('region') || q.includes('billing')) {
    const rg = findRegionInEvidence(state);
    if (rg && toolNames.includes('region_cluster'))
      out.push(makeCandidate(state, 'region_cluster', { region: rg, window_days: 7 }, unknown.question, 7, 'reveals other cards in same region', 'regional cluster', 'isolated', hids));
  }
  if (q.includes('email') || q.includes('recipient')) {
    const em = findEmailInEvidence(state);
    if (em && toolNames.includes('email_neighbors'))
      out.push(makeCandidate(state, 'email_neighbors', { email_domain: em, window_days: 14 }, unknown.question, 7, 'reveals other cards using same email', 'shared email', 'no shared email', hids));
  }
  if ((q.includes('pattern') || q.includes('similar')) && toolNames.includes('similar_closed_cases'))
    out.push(makeCandidate(state, 'similar_closed_cases', extractSimilarCaseFeatures(state), unknown.question, 6, 'provides precedent context', 'similar past cases', 'no similar cases', hids));
  if ((q.includes('card testing') || q.includes('small')) && toolNames.includes('card_testing_scan'))
    out.push(makeCandidate(state, 'card_testing_scan', { card_id: cardId, hours: 4 }, 'Is there a card testing pattern?', 9, 'detects R5 card testing', 'matches R5', 'no card testing', hids));
  if ((q.includes('connectivity') || q.includes('connected')) && toolNames.includes('card_component'))
    out.push(makeCandidate(state, 'card_component', { card_id: cardId, window_days: 14 }, 'What is the connected component?', 6, 'shows fraud ring connectivity', 'large component', 'isolated card', hids));

  return out;
}

