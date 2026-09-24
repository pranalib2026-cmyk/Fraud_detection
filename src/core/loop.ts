/** @module core — Investigation loop */

import { InvestigationState, Trigger, EvidenceItem } from './types.js';
import { createInvestigationState, addEvidence, logStep, evaluatePolicy } from './index.js';
import { evaluateSufficiency } from './stop.js';
import { refreshUncertainty } from './uncertainty.js';
import { buildSarDecision } from '../policy/sar.js';
import { persistCase } from './persist.js';
import { generateCandidateInvestigations } from './candidates.js';
import { GRAPH_TOOL_NAMES } from '../graph/contract.js';
import { GraphBackend } from '../graph/contract.js';

export interface InvestigationEngineOptions {
  backend: GraphBackend;
  maxSteps?: number;
  maxEvidence?: number;
  /**
   * Assessment hook: called after every evidence add and once before the
   * recommendation. Hosts inject it (`makeAssessor(llm, backend)`) so this module
   * stays free of any LLM import; it writes `fraud_probability` / `assessed_pattern`
   * back onto the state.
   */
  assess?: (state: InvestigationState) => any;
}

export class InvestigationEngine {
  backend: GraphBackend;
  maxSteps: number;
  maxEvidence: number;
  private assess: ((state: InvestigationState) => any) | undefined;
  state: InvestigationState | null = null;

  constructor(opts: InvestigationEngineOptions) {
    this.backend = opts.backend;
    this.maxSteps = opts.maxSteps ?? 12;
    this.maxEvidence = opts.maxEvidence ?? 30;
    this.assess = opts.assess;
  }

  async step(): Promise<{ stopped: boolean; state: InvestigationState }> {
    const s = this.state;
    if (!s) throw new Error('No active investigation');

    if (s.steps.length >= this.maxSteps) { s.stop_reason = 'Max steps'; s.status = 'stopped_insufficient'; return { stopped: true, state: s }; }
    if (s.evidence.length >= this.maxEvidence) { s.stop_reason = 'Max evidence'; s.status = 'stopped_insufficient'; return { stopped: true, state: s }; }

    // INITIAL NBA: recorded before any additional evidence is requested (Phase 10).
    if (!s.nba_initial) this.recordInitialNba(s);

    const candidates = generateCandidateInvestigations(s, GRAPH_TOOL_NAMES);
    logStep(s, { type: 'candidate_generation', description: `${candidates.length} candidates`, details: candidates.map((c: any) => c.tool).join(', ') });

    if (!candidates.length) {
      refreshUncertainty(s);
      const suff0 = evaluateSufficiency(s);
      if (suff0.sufficient) {
        this.makeRecommendation();
        s.stop_reason = 'evidence_sufficient'; s.status = 'sufficient';
        logStep(s, { type: 'stop', description: 'STOP', details: 'no candidates left; evidence sufficient' });
        return { stopped: true, state: s };
      }
      s.stop_reason = 'no_useful_evidence'; s.status = 'stopped_insufficient';
      return { stopped: true, state: s };
    }

    const selected = candidates[0];
    logStep(s, { type: 'evidence_acquisition', description: `Selected: ${selected.tool}`, details: selected.question });

    const result = await this.runTool(selected);
    if (result.ok) {
      addEvidence(s, makeEvidence(s, `e-${s.evidence.length + 1}`, selected.question, result.data ?? {}, [selected.tool]));
      try {
        await this.assess?.(s);
      } catch (err: any) {
        logStep(s, { type: 'assessment_failed', description: 'Assessment error', details: err?.message ?? String(err) });
      }
    } else {
      logStep(s, { type: 'tool_failed', description: `Failed: ${selected.tool}`, details: result.error ?? 'error' });
    }
    refreshUncertainty(s);

    const suff = evaluateSufficiency(s);
    if (suff.sufficient) {
      this.makeRecommendation();
      s.stop_reason = 'evidence_sufficient';
      s.status = 'sufficient';
      logStep(s, { type: 'stop', description: 'STOP', details: `evidence_sufficient (${suff.graph_evidence} graph items, pattern=${s.assessed_pattern})` });
      return { stopped: true, state: s };
    }

    return { stopped: false, state: s };
  }

  async runUntilStop(): Promise<InvestigationState> {
    while (true) {
      const { stopped } = await this.step();
      if (stopped) break;
    }
    await this.finalize();
    return this.state!;
  }

  /** Final assessment, recommendation (when not yet made), SAR decision and persistence. */
  async finalize(): Promise<void> {
    const s = this.state;
    if (!s) return;
    try {
      await this.assess?.(s);
      refreshUncertainty(s);
      logStep(s, {
        type: 'assessment',
        description: `Assessed p=${s.fraud_probability != null ? s.fraud_probability.toFixed(2) : 'n/a'} pattern=${s.assessed_pattern ?? 'none'}`,
        details: `decision_state=${s.decision_state} evidence=${s.evidence.length}`,
      });
    } catch (err: any) {
      logStep(s, { type: 'assessment_failed', description: 'Assessment error', details: err?.message ?? String(err) });
    }
    if (!s.recommendation) this.makeRecommendation();
    const outcome = await persistCase(s, this.backend);
    if (!outcome.persisted) {
      logStep(s, { type: 'persist_failed', description: 'Case persistence failed', details: outcome.reason ?? 'unknown' });
    }
  }

  private async runTool(candidate: any): Promise<any> {
    const map: Record<string, (a: any) => Promise<any>> = {
      txn_detail: a => this.backend.txnDetail(a),
      card_window: a => this.backend.cardWindow(a),
      card_history: a => this.backend.cardHistory(a),
      device_neighbors: a => this.backend.deviceNeighbors(a),
      region_cluster: a => this.backend.regionCluster(a),
      email_neighbors: a => this.backend.emailNeighbors(a),
      linked_cards: a => this.backend.linkedCards(a),
      card_component: a => this.backend.cardComponent(a),
      card_centrality: a => this.backend.cardCentrality(a),
      shortest_card_path: a => this.backend.shortestCardPath(a),
      card_testing_scan: a => this.backend.cardTestingScan(a),
      similar_closed_cases: a => this.backend.similarClosedCases(a),
      graph_context: a => this.backend.graphContext(a),
    };
    const fn = map[candidate.tool];
    if (!fn) return { ok: false, error: `Unknown: ${candidate.tool}` };
    try { return await fn(candidate.args); } catch (e: any) { return { ok: false, error: e.message }; }
  }

  /** INITIAL NBA — recorded before any additional evidence is requested (answer-format part 3). */
  private recordInitialNba(s: InvestigationState): void {
    const p = s.fraud_probability ?? s.trigger.risk_score ?? 0.5;
    const pd = evaluatePolicy({
      fraud_probability: p,
      fraud_confirmed_or_strong: p >= 0.7,
      exposure_usd: s.trigger.amount_usd,
      shared_element_link: false,
      coordinated_or_undocumented: false,
      evidence_requested: true,
      disputed: s.trigger.type === 'customer_report',
      pattern_id: null,
      customer_confirms: null,
      customer_denies: null,
      no_reply: null,
      card_testing_pattern: false,
    });
    const actions = [{ action: pd.action, route: pd.route, reason: pd.reason }];
    if (pd.create_case && pd.action !== 'CREATE_CASE') {
      actions.push({ action: 'CREATE_CASE', route: 'auto', reason: 'Case opened: probability ≥ 0.30 or evidence requested (README §3a)' });
    }
    s.nba_initial = {
      phase: 'initial',
      selected_action: pd.action,
      reason: pd.reason,
      expected_impact: 'Recorded before any additional evidence is requested; may change as graph evidence arrives.',
      hypotheses_affected: [],
      approval_route: pd.route,
      evidence_used: [],
      citing_rules: pd.citing_rules,
      actions,
      fraud_probability: p,
      timestamp: new Date().toISOString(),
    };
    logStep(s, { type: 'nba_initial', description: `Initial NBA: ${pd.action}`, details: `${pd.reason} (route ${pd.route})` });
  }

  private makeRecommendation(): void {
    const s = this.state;
    if (!s || s.recommendation) return;

    // A shared element (device/region/email) linked other cards in a window (R6/R9).
    let sharedCards = 0;
    const sharedElementLink = s.evidence.some((e) => {
      const d = e.data as any;
      return d && (d.kind === 'device' || d.kind === 'region' || d.kind === 'email')
        && Array.isArray(d.cards) && d.cards.length > 0;
    });
    const seenCardIds = new Set<string>();
    for (const e of s.evidence) {
      const d = e.data as any;
      if (Array.isArray(d?.cards)) for (const c of d.cards) if (c?.card_id) seenCardIds.add(String(c.card_id));
    }
    sharedCards = seenCardIds.size;

    const pd = evaluatePolicy({
      fraud_probability: s.fraud_probability ?? 0.5,
      fraud_confirmed_or_strong: (s.fraud_probability ?? 0) >= 0.7,
      exposure_usd: s.trigger.amount_usd,
      shared_element_link: sharedElementLink,
      coordinated_or_undocumented: s.assessed_pattern === 'undocumented',
      evidence_requested: false,
      disputed: false,
      pattern_id: s.assessed_pattern,
      customer_confirms: null,
      customer_denies: null,
      no_reply: null,
      card_testing_pattern: s.assessed_pattern === 'card_testing',
    });

    // SAR decision is carried through recommendation → result → API/MCP/evaluator/answers.
    const txnFacts = s.evidence.map((e) => (e.data as any)?.txn).find((t) => Boolean(t)) ?? null;
    s.sar = buildSarDecision({
      case_id: s.case_id,
      fraud_probability: s.fraud_probability ?? 0.5,
      fraud_confirmed_or_strong: (s.fraud_probability ?? 0) >= 0.7,
      exposure_usd: s.trigger.amount_usd,
      shared_element_link: sharedElementLink,
      coordinated_or_undocumented: s.assessed_pattern === 'undocumented',
      pattern: s.assessed_pattern,
      citing_rules: pd.citing_rules,
      evidence_refs: s.evidence.map((e) => e.ref),
      trigger: {
        transaction_id: s.trigger.transaction_id,
        card_id: s.trigger.card_id,
        customer_id: s.trigger.customer_id,
        ts: s.trigger.ts,
        description: s.trigger.description,
        channel: txnFacts?.channel,
        region: txnFacts?.region,
      },
      connected_card_count: sharedCards,
    });

    s.recommendation = {
      action: pd.action,
      route: pd.route,
      reason: pd.reason,
      citing_rules: pd.citing_rules,
      phase: 'final',
      file_report: s.sar.required,
      report_filed: false,
      timestamp: new Date().toISOString(),
    };

    const actions = [{ action: pd.action, route: pd.route, reason: pd.reason }];
    if (s.sar.required) {
      actions.push({ action: 'FILE_REPORT', route: 'L2', reason: `SAR required: ${s.sar.rationale}` });
    } else if (pd.create_case && pd.action !== 'CREATE_CASE') {
      actions.push({ action: 'CREATE_CASE', route: 'auto', reason: 'Case opened per README §3a' });
    }
    s.nba_final = {
      phase: 'final',
      selected_action: pd.action,
      reason: pd.reason,
      expected_impact: 'Final recommendation after all gathered evidence; supersedes the initial NBA where it differs.',
      hypotheses_affected: s.hypotheses.map((h) => h.id),
      approval_route: pd.route,
      evidence_used: s.evidence.map((e) => e.ref),
      citing_rules: pd.citing_rules,
      actions,
      fraud_probability: s.fraud_probability,
      timestamp: new Date().toISOString(),
    };
    s.decision_state = 'sufficient';
    logStep(s, {
      type: 'recommendation',
      description: `Rec: ${pd.action}`,
      details: `${pd.reason} | SAR: ${s.sar.status}`,
    });
  }
}

function makeEvidence(s: InvestigationState, id: string, claim: string, data: any, tools: string[]): EvidenceItem {
  return {
    id, case_id: s.case_id, claim, kind: 'graph_derived', source: 'graph',
    ref: `query:${tools.join(',')}`, entity_ids: extractIds(data), hypothesis_id: null, stance: 'neutral',
    created_at: new Date().toISOString(), data,
  };
}

function extractIds(data: any): string[] {
  const ids: string[] = [];
  for (const k of ['card_id','customer_id','device_id','region','email_domain']) if (data[k]) ids.push(data[k]);
  if (data.cards) for (const c of data.cards) if (c.card_id) ids.push(c.card_id);
  // Cap the id list: shared-element queries can return hundreds of cards, and the id
  // list travels in every result payload (UI, answer files, MCP responses).
  return [...new Set(ids)].slice(0, 20);
}
