/** @module llm/deterministic — Deterministic LLM adapter (default).

 * The challenge makes the agent framework and LLM optional. When present, the LLM
 * supports reasoning, tool selection, evidence synthesis and explanation — it never
 * replaces deterministic graph analysis. This adapter is the default: a rule-based
 * reasoning layer that runs without an external API key.
 *
 * Every claim the adapter produces is labelled `llm_interpretation` in evidence, so the
 * provenance chain stays honest (README §7 Explaining).
 */

import { deterministicReasoning } from './reasoning.js';
import { deterministicActions } from './actions.js';
import { explainSelection, synthesize, synthesizeEvidence } from './explain.js';
import { createProviderAdapter } from './provider.js';
import type {
  ActionSuggestion, CandidateSummary, ChatMessage, ClosedStats, EventContext, EvidenceItem,
  EvidenceSummary, LlmAdapter, LlmConfig, ReasoningResult, TriggerSummary,
} from './types.js';

/** Build an adapter for the configured provider. */
export function createLlmAdapter(config: LlmConfig): LlmAdapter {
  const provider = (config.provider ?? 'deterministic').toLowerCase();
  if (provider === 'anthropic' || provider === 'openai') {
    if (config.apiKey) {
      // Real provider path (src/llm/provider.ts) — verified only when a real request succeeds.
      return createProviderAdapter(config);
    }
    // Honest state: a provider was asked for but no key exists. Never fakes a model call.
    return createDeterministicAdapter({
      ...config,
      model: `${config.model || provider}+unavailable:no-api-key`,
      meta: { mode: 'unconfigured', last_error: 'no-api-key' },
    } as LlmConfig);
  }
  return createDeterministicAdapter({ ...config, meta: { mode: 'deterministic' } } as LlmConfig);
}

export function createDeterministicAdapter(config: LlmConfig): LlmAdapter {
  return {
    config,
    meta: (config as any).meta ?? { mode: 'deterministic' },

    reason(evidence: EvidenceSummary, trigger: TriggerSummary, closedStats: ClosedStats): ReasoningResult {
      return deterministicReasoning(evidence, trigger, closedStats);
    },

    suggestActions(reasoning: ReasoningResult, event: EventContext): ActionSuggestion[] {
      return deterministicActions(reasoning, event);
    },

    synthesizeEvidence(items: EvidenceItem[]): string {
      return synthesizeEvidence(items);
    },

    explainSelection(chosen: CandidateSummary, alternatives: CandidateSummary[]): string {
      return explainSelection(chosen, alternatives);
    },

    synthesize(prompt: string, context?: Record<string, unknown>): string {
      return synthesize(prompt, context);
    },

    async chat(messages: ChatMessage[]): Promise<string> {
      const last = messages.filter((m) => m.role === 'user').pop();
      return last
        ? `[deterministic adapter] No external LLM is configured. Last user message was: ${last.content.slice(0, 400)}`
        : '[deterministic adapter] No external LLM is configured.';
    },
  };
}
