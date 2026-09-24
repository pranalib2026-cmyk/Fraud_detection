/** @module llm/provider — REAL LLM provider adapter (anthropic / openai).
 *
 * Wires the raw transport (provider-http) into the LlmAdapter contract. On ANY reasoning
 * failure the adapter records `meta.last_error`, flips `meta.mode` to 'fallback' and
 * delegates to the deterministic reasoner — an honest, labelled degradation, never a fake
 * success. `testConnection()` performs the real "LLM_CONNECTION_TEST_OK" round-trip and
 * never exposes the API key.
 */
import { deterministicReasoning } from './reasoning.js';
import { deterministicActions } from './actions.js';
import { explainSelection, synthesizeEvidence, summarizeEvidence } from './explain.js';
import { callProvider, extractJson, reasonPrompt, ProviderError, SYSTEM_PROMPT } from './provider-http.js';
import { PATTERNS } from '../policy/policy.js';
import type {
  ActionSuggestion, CandidateSummary, ChatMessage, ClosedStats, EvidenceItem, EventContext,
  EvidenceSummary, LlmAdapter, LlmConfig, ReasoningResult, TriggerSummary,
} from './types.js';

export { ProviderError } from './provider-http.js';

/** Build the REAL provider adapter; reasoning failures fall back to deterministic, labelled. */
export function createProviderAdapter(config: LlmConfig): LlmAdapter {
  const adapter: LlmAdapter = {
    config,
    meta: { mode: 'live' },

    async reason(evidence: EvidenceSummary, trigger: TriggerSummary, closedStats: ClosedStats): Promise<ReasoningResult> {
      try {
        const { text } = await callProvider(config, SYSTEM_PROMPT, reasonPrompt(evidence, trigger, closedStats), Math.min(config.maxTokens || 2000, 1500));
        const parsed = extractJson(text);
        const p = Number(parsed?.fraud_probability);
        if (!Number.isFinite(p) || p < 0 || p > 1) throw new ProviderError('invalid_response', 'fraud_probability out of range');
        const pattern = (PATTERNS as readonly string[]).includes(parsed?.assessed_pattern) ? parsed.assessed_pattern : evidence.assessed_pattern;
        const confidence = ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'low';
        const hypotheses = Array.isArray(parsed?.hypotheses) ? parsed.hypotheses.map(String).slice(0, 6) : [];
        if (!hypotheses.length) throw new ProviderError('invalid_response', 'hypotheses missing');
        return {
          fraud_probability: p,
          assessed_pattern: pattern,
          pattern_description: String(parsed?.pattern_description ?? ''),
          hypotheses,
          reasoning: String(parsed?.reasoning ?? ''),
          evidence_summary: summarizeEvidence(evidence.items, trigger),
          confidence,
        };
      } catch (e: any) {
        adapter.meta = { mode: 'fallback', last_error: `${e?.code ?? 'error'}: ${e?.message ?? String(e)}`.slice(0, 160) };
        return deterministicReasoning(evidence, trigger, closedStats);
      }
    },

    suggestActions(reasoning: ReasoningResult, event: EventContext): ActionSuggestion[] {
      return deterministicActions(reasoning, event);
    },
    synthesizeEvidence(items: EvidenceItem[]): string { return synthesizeEvidence(items); },
    explainSelection(chosen: CandidateSummary, alternatives: CandidateSummary[]): string { return explainSelection(chosen, alternatives); },
    synthesize(prompt: string, context?: Record<string, unknown>): string {
      const ctx = context ? Object.entries(context).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n') : '';
      return ctx ? `${prompt}\nContext:\n${ctx}` : prompt;
    },
    /** Async variant used by buildResult for LLM-authored SAR narratives. */
    async synthesizeAsync(prompt: string, context?: Record<string, unknown>): Promise<string> {
      const ctx = context ? Object.entries(context).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n') : '';
      const { text } = await callProvider(config, SYSTEM_PROMPT, `${prompt}\n${ctx}`, Math.min(config.maxTokens || 2000, 1200));
      return text;
    },
    async chat(messages: ChatMessage[]): Promise<string> {
      const last = messages.filter((m) => m.role === 'user').pop();
      if (!last) throw new ProviderError('invalid_response', 'no user message');
      const { text } = await callProvider(config, 'Follow the instruction exactly.', String(last.content), 256);
      return text;
    },
    /** Real round-trip verification for verify-backends / status endpoints. */
    async testConnection(): Promise<{ ok: boolean; matched: boolean; sample: string; latency_ms: number; error?: string }> {
      try {
        const { text, ms } = await callProvider(config, 'Follow the instruction exactly.', 'Return exactly LLM_CONNECTION_TEST_OK', 64);
        return { ok: true, matched: text.includes('LLM_CONNECTION_TEST_OK'), sample: text.slice(0, 120), latency_ms: ms };
      } catch (e: any) {
        return { ok: false, matched: false, sample: '', latency_ms: 0, error: `${e?.code ?? 'error'}: ${e?.message ?? String(e)}` };
      }
    },
  } as LlmAdapter & {
    synthesizeAsync?: (p: string, c?: Record<string, unknown>) => Promise<string>;
    testConnection?: () => Promise<{ ok: boolean; matched: boolean; sample: string; latency_ms: number; error?: string }>;
  };
  return adapter;
}
