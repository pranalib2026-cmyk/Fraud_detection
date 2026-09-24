/** @module llm/types — Shared LLM-layer types.

 * The LLM layer supports reasoning, tool selection, evidence synthesis and
 * explanation. It never replaces deterministic graph analysis. Two adapters exist:
 *   - deterministic : rule-based reasoning, no external API key required (default)
 *   - real provider : anthropic / openai, configured via environment
 *
 * Every claim the adapter produces is labelled `llm_interpretation` in evidence, so
 * the provenance chain stays honest (README §7 Explaining).
 */

import type { PatternId } from '../core/types.js';
import type { PolicyAction } from '../policy/policy.js';

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
}

/** A single piece of evidence as the LLM layer sees it. */
export interface EvidenceItem {
  id: string;
  claim: string;
  kind: 'direct' | 'graph_derived' | 'llm_interpretation';
  source: 'graph' | 'document' | 'customer' | 'external';
  ref: string;
  entity_ids: string[];
  stance: 'supports' | 'contradicts' | 'neutral';
}

export interface ClosedStats {
  overall: { total: number; confirmed_fraud_rate: number } | null;
  by_pattern: { pattern: string; total: number; confirmed_fraud_rate: number }[];
}

export interface TriggerSummary {
  type: string;
  transaction_id: string;
  card_id: string;
  customer_id: string;
  risk_score: number | null;
  amount_usd: number;
  description: string;
}

export interface EvidenceSummary {
  items: EvidenceItem[];
  assessed_pattern: PatternId | null;
  evidence_count: number;
  graph_evidence_count: number;
  customer_evidence_count: number;
}

export interface ReasoningResult {
  fraud_probability: number;
  assessed_pattern: PatternId | null;
  pattern_description: string;
  hypotheses: string[];
  reasoning: string;
  evidence_summary: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ActionSuggestion {
  action: PolicyAction;
  route: string;
  reason: string;
  citing_rules: string[];
}

/** Facts about the case that condition which policy rules apply. */
export interface EventContext {
  exposure_usd: number;
  fraud_confirmed_or_strong: boolean;
  shared_element_link: boolean;
  coordinated_or_undocumented: boolean;
  evidence_requested: boolean;
  disputed: boolean;
  customer_confirms: boolean | null;
  customer_denies: boolean | null;
  no_reply: boolean | null;
  card_testing_pattern: boolean;
  pattern: PatternId | null;
}

export interface CandidateSummary {
  id: string;
  tool: string;
  reason: string;
  priority: number;
  cost: 'low' | 'medium' | 'high';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The adapter surface. Both the deterministic and provider adapters implement it. */
export interface LlmAdapter {
  config: LlmConfig;
  /** Interpret evidence into a probability, pattern and hypotheses. */
  reason(evidence: EvidenceSummary, trigger: TriggerSummary, closedStats: ClosedStats): ReasoningResult | Promise<ReasoningResult>;
  /** Adapter mode: deterministic | live | fallback | unconfigured (plus last_error). */
  meta?: { mode: 'deterministic' | 'live' | 'fallback' | 'unconfigured'; last_error?: string };
  /** Map a reasoning result plus case facts onto policy actions (rule IDs cited). */
  suggestActions(reasoning: ReasoningResult, event: EventContext): ActionSuggestion[];
  /** Render evidence items into a readable, citable summary. */
  synthesizeEvidence(items: EvidenceItem[]): string;
  /** Explain why a candidate investigation was selected over its alternatives. */
  explainSelection(chosen: CandidateSummary, alternatives: CandidateSummary[]): string;
  /** General-purpose synthesis helper for narrative text. */
  synthesize(prompt: string, context?: Record<string, unknown>): string;
  /** Free-form chat (only the provider adapters implement this meaningfully). */
  chat(messages: ChatMessage[]): Promise<string>;
}
