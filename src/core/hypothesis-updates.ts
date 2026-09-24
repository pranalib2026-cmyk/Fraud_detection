/** @module core/hypothesis-updates — Link evidence to hypotheses and track confidence.
 *
 * After every assessment the assessor calls `applyEvidenceToHypotheses`, which records a
 * hypothesis, confidence_before, the evidence considered, the impact, confidence_after
 * and a status (SUPPORTED / WEAKENED / UNRESOLVED / REJECTED semantics via the
 * Hypothesis.status union). Nothing is fabricated: movement derives from the actual
 * probability delta and decisive stances recorded on the evidence.
 */
import { InvestigationState, Hypothesis, HypothesisUpdate } from './types.js';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * @param newEvidenceIds evidence ids considered in this assessment round (may be empty)
 * @param pBefore / pAfter the fraud probability before and after this assessment
 */
export function applyEvidenceToHypotheses(
  state: InvestigationState,
  newEvidenceIds: string[],
  pBefore: number | null,
  pAfter: number | null,
): HypothesisUpdate[] {
  if (!state.hypotheses.length) return [];
  const delta = pBefore !== null && pAfter !== null ? pAfter - pBefore : 0;
  const newItems = state.evidence.filter((e) => newEvidenceIds.includes(e.id));
  const updates: HypothesisUpdate[] = [];

  for (const h of state.hypotheses) {
    const before = h.confidence;
    const isFraud = h.kind === 'fraud_explanation';
    const direction = isFraud ? 1 : -1;

    let stanceEffect = 0;
    let supportCount = 0;
    let contraCount = 0;
    for (const e of newItems) {
      if (e.stance === 'supports') { supportCount++; stanceEffect += isFraud ? 0.05 : -0.05; }
      else if (e.stance === 'contradicts') { contraCount++; stanceEffect += isFraud ? -0.05 : 0.05; }
    }
    const after = clamp01(before + delta * 0.8 * direction + stanceEffect);
    const change = after - before;

    let status: Hypothesis['status'];
    if (after <= 0.25) status = 'rejected';
    else if (change <= -0.02) status = 'weakened';
    else if (change >= 0.02 && after >= 0.55) status = 'supported';
    else if (Math.abs(change) < 0.02 && before >= 0.55 && !newItems.length) status = 'supported';
    else status = newItems.length || pAfter !== null ? 'unresolved' : h.status;

    h.confidence = Number(after.toFixed(3));
    h.status = status;
    if (pAfter !== null && h.pattern === undefined && isFraud && state.assessed_pattern) h.pattern = state.assessed_pattern;

    const update: HypothesisUpdate = {
      hypothesis_id: h.id,
      confidence_before: Number(before.toFixed(3)),
      evidence_ids: newEvidenceIds.slice(),
      impact: [
        pBefore !== null && pAfter !== null ? `p ${pBefore.toFixed(2)}→${pAfter.toFixed(2)}` : 'no probability yet',
        supportCount ? `${supportCount} support` : '',
        contraCount ? `${contraCount} contradict` : '',
        !supportCount && !contraCount && !newItems.length ? 'seeded' : '',
      ].filter(Boolean).join(', '),
      confidence_after: Number(after.toFixed(3)),
      status,
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    updates.push(update);
    state.hypothesis_updates.push(update);
  }
  return updates;
}
