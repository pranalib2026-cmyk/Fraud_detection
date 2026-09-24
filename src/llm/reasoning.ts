/** @module llm/reasoning — Rule-based interpretation of gathered evidence.

 * The default reasoning path: requires no API key and produces a defensible,
 * reproducible probability, pattern assessment and hypothesis set from the evidence
 * already gathered by the graph. Every threshold applied comes from the policy module
 * or the challenge README — no number is invented here.
 */

import type { PatternId } from '../core/types.js';
import type { ClosedStats, EvidenceItem, EvidenceSummary, ReasoningResult, TriggerSummary } from './types.js';
import { confidenceLevel, patternDescription, reasoningText, summarizeEvidence } from './explain.js';

export const clampProbability = (p: number): number => Math.max(0, Math.min(1, p));

/** Interpret the gathered evidence: probability + pattern + hypotheses. */
export function deterministicReasoning(
  evidence: EvidenceSummary,
  trigger: TriggerSummary,
  closedStats: ClosedStats,
): ReasoningResult {
  const items = evidence.items;
  const pattern = evidence.assessed_pattern;
  const prob = clampProbability(estimateProbability(items, trigger, pattern, closedStats));
  const hypotheses = buildHypotheses(items, trigger, pattern, prob);
  return {
    fraud_probability: prob,
    assessed_pattern: pattern,
    pattern_description: patternDescription(pattern, items),
    hypotheses,
    reasoning: reasoningText(prob, pattern, hypotheses, items, trigger, closedStats),
    evidence_summary: summarizeEvidence(items, trigger),
    confidence: confidenceLevel(prob, items.length, pattern),
  };
}

/**
 * Starts from the model risk score (an input signal, not a verdict), then graph-derived
 * and customer-sourced evidence adjust it. Adjustments are bounded so no single item
 * can swing the verdict.
 */
function estimateProbability(
  items: EvidenceItem[],
  trigger: TriggerSummary,
  pattern: PatternId | null,
  stats: ClosedStats,
): number {
  let p = trigger.risk_score ?? 0.5;

  let supports = 0;
  let contradicts = 0;
  for (const item of items) {
    if (item.source === 'graph') {
      if (item.stance === 'supports') supports++;
      else if (item.stance === 'contradicts') contradicts++;
    } else if (item.source === 'customer') {
      const lower = item.claim.toLowerCase();
      if (lower.includes('not') || lower.includes('denied') || lower.includes('did not')) contradicts++;
      else if (lower.includes('yes') || lower.includes('made') || lower.includes('recognize')) supports++;
    }
  }

  if (pattern && pattern !== 'none') p += 0.08;
  else if (pattern === 'none' && items.length >= 2) p -= 0.05;
  if (trigger.type === 'customer_report') p += 0.15;
  if (trigger.type === 'analyst') p += 0.10;
  if (supports > 0) p += Math.min(0.12, supports * 0.03);
  if (contradicts > 0) p -= Math.min(0.12, contradicts * 0.03);

  // Base-rate anchor: narrows toward the historical rate, never overrides it.
  const rate = stats.overall?.confirmed_fraud_rate;
  if (typeof rate === 'number' && Number.isFinite(rate)) p = p * 0.85 + rate * 0.15;

  return p;
}

function buildHypotheses(
  items: EvidenceItem[],
  trigger: TriggerSummary,
  pattern: PatternId | null,
  prob: number,
): string[] {
  const h: string[] = [];
  h.push(`The flagged transaction ${trigger.transaction_id} on card ${trigger.card_id} may be fraudulent`);
  h.push(`The flagged transaction ${trigger.transaction_id} on card ${trigger.card_id} may be legitimate`);
  if (pattern && pattern !== 'none') h.push(`The activity fits the documented pattern "${pattern}"`);
  if (items.some((i) => i.claim.toLowerCase().includes('device'))) h.push('A shared device profile links this activity to other cards');
  if (items.some((i) => i.claim.toLowerCase().includes('region'))) h.push('A billing-region cluster links this activity to other cards');
  if (items.some((i) => i.claim.toLowerCase().includes('email'))) h.push('A shared recipient email links this activity to other cards');
  if (prob >= 0.7) h.push('Multiple independent signals support fraud');
  else if (prob <= 0.3) h.push('Multiple independent signals support legitimacy');
  return h;
}
