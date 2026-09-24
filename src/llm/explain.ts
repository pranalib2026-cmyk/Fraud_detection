/** @module llm/explain — Narrative explanation and evidence rendering.

 * These helpers turn structured evidence into the plain-language text that appears in
 * case files, CLI output and the demo. They deliberately avoid asserting a verdict:
 * they describe what was observed and which policy rule applies.
 */

import type { PatternId } from '../core/types.js';
import type { CandidateSummary, ClosedStats, EvidenceItem, TriggerSummary } from './types.js';

/** Render evidence items into a readable, citable list. */
export function synthesizeEvidence(items: EvidenceItem[]): string {
  if (!items.length) return 'No evidence recorded.';
  return items.map((i) => {
    const tag = [i.kind, i.source].filter(Boolean).join(' / ') || 'evidence';
    const entities = (i.entity_ids || []).join(', ') || '—';
    return `[${tag}] ${i.claim} (ref: ${i.ref}, entities: ${entities})`;
  }).join('\n');
}

/** Explain why a candidate investigation was selected over its alternatives. */
export function explainSelection(chosen: CandidateSummary, alternatives: CandidateSummary[]): string {
  const alt = alternatives.slice(0, 3).map((a) => `- ${a.tool}: ${a.reason}`).join('\n');
  return `Selected ${chosen.tool} because ${chosen.reason}. Considered alternatives:\n${alt || 'none'}.`;
}

/** General-purpose text synthesis: joins a prompt with key/value context. */
export function synthesize(prompt: string, context?: Record<string, unknown>): string {
  if (!context || !Object.keys(context).length) return prompt;
  const ctx = Object.entries(context)
    .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
  return `${prompt}\nContext:\n${ctx}`;
}

export function summarizeEvidence(items: EvidenceItem[], trigger: TriggerSummary): string {
  if (!items.length) return `No evidence gathered yet for transaction ${trigger.transaction_id} on card ${trigger.card_id}.`;
  const graph = items.filter((i) => i.source === 'graph').length;
  const customer = items.filter((i) => i.source === 'customer').length;
  const parts = items.slice(0, 8).map((i) => `- [${i.kind} / ${i.source}] ${i.claim}`);
  return `Gathered ${items.length} evidence item(s) (${graph} from graph, ${customer} from customer). Key points:\n${parts.join('\n')}`;
}

export function reasoningText(
  prob: number,
  pattern: PatternId | null,
  hypotheses: string[],
  items: EvidenceItem[],
  trigger: TriggerSummary,
  stats: ClosedStats,
): string {
  const risk = trigger.risk_score !== null
    ? `The model risk score is ${trigger.risk_score.toFixed(2)}; this is an input signal, not a verdict.`
    : 'No model risk score was supplied for this trigger.';
  const patternText = pattern && pattern !== 'none'
    ? `The assessed pattern is "${pattern}".`
    : pattern === 'none'
      ? 'The activity does not fit a documented pattern cleanly; it is treated as "none" pending further evidence.'
      : 'No pattern has been assessed yet.';
  const prior = stats.overall
    ? `Across ${stats.overall.total} closed cases, ${(stats.overall.confirmed_fraud_rate * 100).toFixed(1)}% were confirmed fraud.`
    : '';
  return [
    `Trigger: ${trigger.description}`,
    risk,
    patternText,
    prior,
    'Hypotheses under consideration:',
    ...hypotheses.map((h) => `- ${h}`),
    `Evidence items considered: ${items.length}.`,
    `Assessed fraud probability: ${prob.toFixed(2)}.`,
  ].filter((l) => l !== '').join('\n');
}

export function patternDescription(pattern: PatternId | null, items: EvidenceItem[]): string {
  if (pattern && pattern !== 'none' && pattern !== 'undocumented') return `Documented pattern "${pattern}".`;
  if (pattern === 'undocumented') {
    const detail = items.find((i) => i.claim.toLowerCase().includes('device'))?.claim
      ?? items.find((i) => i.claim.toLowerCase().includes('region'))?.claim
      ?? 'coordinated activity across multiple cards in a short window';
    return `Activity fits none of the five documented patterns. Observed: ${detail}. Described in the agent's own words rather than forced into a known category (policy R9).`;
  }
  return 'No documented pattern matched.';
}

export function confidenceLevel(prob: number, itemCount: number, pattern: PatternId | null): 'high' | 'medium' | 'low' {
  if (itemCount >= 4 && pattern && pattern !== 'none' && (prob >= 0.7 || prob <= 0.3)) return 'high';
  if (itemCount >= 2) return 'medium';
  return 'low';
}
