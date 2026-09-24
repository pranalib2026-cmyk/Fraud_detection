/** @module llm/provider-http — Raw HTTPS transport for REAL LLM providers (no SDK).
 * Classifies HTTP failures (authentication_failed / rate_limited / provider_unavailable /
 * invalid_response) and enforces a timeout via AbortController.
 */
import { PATTERNS } from '../policy/policy.js';
import type { ClosedStats, EvidenceSummary, LlmConfig, TriggerSummary } from './types.js';

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const TIMEOUT_MS = () => Number(process.env.HHGOA_LLM_TIMEOUT_MS ?? 30000);

export function classify(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('authentication_failed', `provider rejected credentials (HTTP ${status})`);
  if (status === 429) return new ProviderError('rate_limited', `provider rate limited (HTTP ${status})`);
  return new ProviderError('provider_unavailable', `provider error (HTTP ${status}): ${body.slice(0, 180)}`);
}

export async function callProvider(config: LlmConfig, system: string, user: string, maxTokens: number): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
  try {
    if (config.provider === 'anthropic') {
      const res = await fetch(`${config.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: config.model || 'claude-sonnet-4-5',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw classify(res.status, await res.text().catch(() => ''));
      const json: any = await res.json();
      const text = Array.isArray(json?.content) ? json.content.map((c: any) => c?.text ?? '').join('') : '';
      if (!text) throw new ProviderError('invalid_response', 'empty model response');
      return { text, ms: Date.now() - started };
    }
    const res = await fetch(`${config.baseUrl || 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        max_tokens: maxTokens,
        temperature: config.temperature ?? 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ''));
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError('invalid_response', 'empty model response');
    return { text, ms: Date.now() - started };
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    if (e?.name === 'AbortError') throw new ProviderError('provider_unavailable', `timeout after ${TIMEOUT_MS()}ms`);
    throw new ProviderError('provider_unavailable', e?.message ?? String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a JSON object out of a model reply (handles ```json fences and prose). */
export function extractJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError('invalid_response', 'no JSON object in model output');
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { throw new ProviderError('invalid_response', 'malformed JSON in model output'); }
}

export function reasonPrompt(e: EvidenceSummary, t: TriggerSummary, s: ClosedStats): string {
  const graph = e.items.filter((i) => i.source === 'graph');
  const docs = e.items.filter((i) => i.source === 'document');
  const other = e.items.filter((i) => i.source !== 'graph' && i.source !== 'document');
  const line = (i: any) => `- [${i.source}/${i.kind}${i.stance !== 'neutral' ? `/${i.stance}` : ''}] ${i.claim} (ref: ${i.ref})`;
  return [
    'You are a fraud investigator. Assess the case from the evidence below and answer as STRICT JSON only.',
    `JSON shape: {"fraud_probability":0.0-1.0,"assessed_pattern":"${(PATTERNS as readonly string[]).join('|')}","confidence":"high|medium|low","hypotheses":["fraud...","legitimate..."],"reasoning":"3-5 sentences citing evidence refs","pattern_description":"""}`,
    `TRIGGER: ${t.type} txn=${t.transaction_id} card=${t.card_id} customer=${t.customer_id} risk=${t.risk_score ?? 'n/a'} amount=${t.amount_usd} — ${t.description}`,
    s.overall ? `CLOSED-CASE BASE RATE: ${(s.overall.confirmed_fraud_rate * 100).toFixed(1)}% of ${s.overall.total} closed cases were confirmed fraud.` : '',
    `GRAPH EVIDENCE (${graph.length}):`, ...graph.map(line),
    `DOCUMENT EVIDENCE (${docs.length}, retrieved policy/source text — guidance, not facts about this case):`, ...docs.map(line),
    ...(other.length ? [`OTHER EVIDENCE (${other.length}):`, ...other.map(line)] : []),
    'Return ONLY the JSON object.',
  ].filter(Boolean).join('\n');
}

export const SYSTEM_PROMPT = 'You are a fraud investigation reasoning engine. You never invent graph facts; you interpret provided evidence and cite refs.';
