/** @module agent/assess — Evidence → probability/pattern write-back.
 *
 * This is the missing link between the graph and the reasoning layer: after evidence is
 * gathered the engine calls the assessor, which (1) infers the documented pattern from
 * the graph evidence, (2) lets the LLM adapter (`llm.reason`, deterministic by default)
 * interpret the evidence into a fraud probability, and (3) writes both back onto the
 * `InvestigationState` so `makeRecommendation`, the REST step endpoint, the MCP result
 * and the evaluator all see a real assessment instead of a permanent `null`.
 *
 * The engine receives the assessor by injection (`InvestigationEngineOptions.assess`),
 * so `src/core` stays free of any LLM import. Hosts build it with `makeAssessor(llm,
 * backend)` — one line at each construction site.
 */

import type { InvestigationState, Hypothesis } from '../core/types.js';
import type { GraphBackend } from '../graph/contract.js';
import type {
  ClosedStats, EvidenceSummary, LlmAdapter, ReasoningResult, TriggerSummary,
} from '../llm/types.js';
import { toLlmEvidence } from './result.js';
import { inferPattern } from '../core/pattern-inference.js';
import { applyEvidenceToHypotheses } from '../core/hypothesis-updates.js';
import { getRag } from '../rag/index.js';

const EMPTY_STATS: ClosedStats = { overall: null, by_pattern: [] };

/**
 * Refresh DOCUMENT evidence for the reasoning context (Phase 6/7). Retrieved chunks
 * carry provenance (document/section/chunk_id/relevance) and are labelled source=
 * 'document' so the LLM sees GRAPH and DOCUMENT evidence as distinct kinds. Retrieval
 * never asserts facts: it quotes policy/source text only.
 */
function refreshDocumentEvidence(state: InvestigationState): void {
  try {
    const rag = getRag();
    if (!rag.ready) return;
    const query = [state.trigger.description, state.assessed_pattern ?? '', 'fraud policy pattern'].join(' ');
    const hits = rag.retrieve(query, 3);
    state.evidence = state.evidence.filter((e) => e.source !== 'document');
    hits.forEach((h, i) => {
      state.evidence.push({
        id: `d-${i + 1}`,
        case_id: state.case_id,
        claim: `${h.section}: ${h.text.slice(0, 140).replace(/\s+/g, ' ')}…`,
        kind: 'direct',
        source: 'document',
        ref: `document:${h.chunk_id}`,
        entity_ids: [],
        hypothesis_id: null,
        stance: 'neutral',
        created_at: new Date().toISOString(),
        data: {
          provenance: { document: h.document_title, section: h.section, chunk_id: h.chunk_id, relevance: h.relevance },
          text: h.text.slice(0, 900),
        },
      });
    });
  } catch { /* retrieval failure must never break assessment */ }
}

/** Read the backend's aggregate closed-case statistics (local backend carries them). */
export function closedStatsFor(backend: GraphBackend): ClosedStats {
  const s = (backend as any)?.statistics;
  if (!s?.overall) return EMPTY_STATS;
  return {
    overall: {
      total: Number(s.overall.total ?? 0),
      confirmed_fraud_rate: Number(s.overall.confirmed_fraud_rate ?? 0),
    },
    by_pattern: Array.isArray(s.by_pattern)
      ? s.by_pattern.map((p: any) => ({
          pattern: String(p.pattern),
          total: Number(p.total ?? 0),
          confirmed_fraud_rate: Number(p.confirmed_fraud_rate ?? 0),
        }))
      : [],
  };
}

/**
 * Stance relative to the fraud hypothesis, only where the detector result is decisive:
 * a confirmed card-testing sequence supports fraud, a clean scan contradicts it, and a
 * `New` device on an online flagged txn supports it (README pattern 3). Everything else
 * stays neutral — graph facts are observations, not verdicts.
 */
function annotateStances(state: InvestigationState): void {
  for (const e of state.evidence) {
    const d = e.data as any;
    if (!d) continue;
    if (e.ref?.includes('card_testing_scan') && Array.isArray(d.sequences)) {
      e.stance = d.sequences.length > 0 ? 'supports' : 'contradicts';
    } else if (e.ref?.includes('txn_detail') && d.txn?.device_new_or_found === 'New') {
      e.stance = 'supports';
    }
  }
}

/**
 * Record the adapter's hypothesis strings on the state (once), so the loop's
 * hypothesis-driven test suggestions have something to work from. The first string is
 * the fraud explanation, the second the legitimate one (see llm/reasoning.buildHypotheses).
 */
function seedHypotheses(state: InvestigationState, result: ReasoningResult): void {
  if (state.hypotheses.length > 0 || result.hypotheses.length === 0) return;
  const confidence = result.confidence === 'high' ? 0.7 : result.confidence === 'medium' ? 0.5 : 0.3;
  result.hypotheses.slice(0, 2).forEach((claim, i) => {
    const h: Hypothesis = {
      id: `h-${i + 1}`,
      claim,
      kind: i === 0 ? 'fraud_explanation' : 'legitimate_explanation',
      supporting: [],
      contradicting: [],
      confidence,
      falsifiers: [],
      status: 'active',
    };
    if (i === 0 && state.assessed_pattern) h.pattern = state.assessed_pattern;
    state.hypotheses.push(h);
  });
}

/** Infer the pattern, reason over the evidence, and write the assessment onto the state.
 * Async: a real LLM provider adapter performs network I/O inside `llm.reason`. */
export async function assessState(
  state: InvestigationState,
  llm: LlmAdapter,
  backend: GraphBackend,
): Promise<ReasoningResult> {
  const pBefore = state.fraud_probability;
  state.assessed_pattern = inferPattern(state);
  refreshDocumentEvidence(state);
  annotateStances(state);

  const items = toLlmEvidence(state);
  const summary: EvidenceSummary = {
    items,
    assessed_pattern: state.assessed_pattern,
    evidence_count: items.length,
    graph_evidence_count: items.filter((i) => i.source === 'graph').length,
    customer_evidence_count: items.filter((i) => i.source === 'customer').length,
  };
  const trigger: TriggerSummary = {
    type: state.trigger.type,
    transaction_id: state.trigger.transaction_id,
    card_id: state.trigger.card_id,
    customer_id: state.trigger.customer_id,
    risk_score: state.trigger.risk_score,
    amount_usd: state.trigger.amount_usd,
    description: state.trigger.description,
  };

  const result = await llm.reason(summary, trigger, closedStatsFor(backend));
  state.fraud_probability = result.fraud_probability;
  state.assessed_pattern = result.assessed_pattern ?? state.assessed_pattern;
  seedHypotheses(state, result);
  // Phase 8: link this round's evidence to the hypotheses and record confidence movement.
  try {
    const covered = new Set((state.hypothesis_updates ?? []).flatMap((u) => u.evidence_ids));
    const newIds = state.evidence.map((e) => e.id).filter((id) => !covered.has(id));
    applyEvidenceToHypotheses(state, newIds, pBefore, state.fraud_probability);
  } catch { /* hypothesis bookkeeping must never break assessment */ }
  return result;
}

/** Adapter for `InvestigationEngineOptions.assess` (async: writes back after awaiting). */
export function makeAssessor(llm: LlmAdapter, backend: GraphBackend): (state: InvestigationState) => Promise<void> {
  return async (state: InvestigationState) => {
    await assessState(state, llm, backend);
  };
}