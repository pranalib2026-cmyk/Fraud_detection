/** @module core/persist — Write the finished investigation to case memory.
 *
 * Called once per run from `InvestigationEngine.finalize()` so every host (CLI, REST,
 * MCP, evaluator, benchmark) persists identically: case record → evidence → audit trail,
 * through the backend's own write_case/write_evidence/write_audit contract. The local
 * backend stores them in the memory store and honestly reports written_to_graph=false;
 * the TigerGraph backend upserts vertices and reports written_to_graph=true only after a
 * successful graph write.
 */
import { InvestigationState } from './types.js';
import { GraphBackend } from '../graph/contract.js';

export interface PersistOutcome {
  persisted: boolean;
  written_to_graph: boolean;
  reason?: string;
  case_id: string;
}

function graphFlag(result: any): boolean {
  return Boolean(result?.data?.written_to_graph ?? result?.written_to_graph);
}

export async function persistCase(state: InvestigationState, backend: GraphBackend): Promise<PersistOutcome> {
  const case_id = state.case_id;
  if ((state as any).persisted_at) {
    return { persisted: true, written_to_graph: Boolean((state as any).persisted_written_to_graph), reason: 'already_persisted', case_id };
  }
  try {
    const record = {
      case_id,
      status: state.status,
      opened_at: state.opened_at,
      trigger: state.trigger,
      decision_state: state.decision_state,
      stop_reason: state.stop_reason,
      fraud_probability: state.fraud_probability,
      assessed_pattern: state.assessed_pattern,
      recommendation: state.recommendation,
      nba_initial: (state as any).nba_initial ?? null,
      nba_final: (state as any).nba_final ?? null,
      sar: (state as any).sar ?? null,
      hypotheses: state.hypotheses,
      hypothesis_updates: (state as any).hypothesis_updates ?? [],
      unknowns: state.unknowns,
      contradictions: state.contradictions,
      budget: state.budget,
      steps_count: state.steps.length,
      evidence_count: state.evidence.length,
      backend_kind: backend.kind,
      degraded: backend.degraded,
      persisted_at: new Date().toISOString(),
    };
    const writeResult = await (backend as any).writeCase(record);
    const written_to_graph = graphFlag(writeResult);

    const evidenceItems = state.evidence.map((e) => ({
      id: e.id, claim: e.claim, kind: e.kind, source: e.source, ref: e.ref,
      entity_ids: e.entity_ids, hypothesis_id: e.hypothesis_id, stance: e.stance,
      created_at: e.created_at, data: e.data,
    }));
    if (evidenceItems.length) await (backend as any).writeEvidence({ case_id, items: evidenceItems });

    const events = [
      { case_id, type: 'case_created', actor: 'agent', timestamp: record.persisted_at, detail: `status=${state.status}` },
      ...(state.recommendation ? [{ case_id, type: 'recommendation', actor: 'agent', timestamp: record.persisted_at, detail: `${state.recommendation.action}@${state.recommendation.route} [${state.recommendation.citing_rules.join(',')}]` }] : []),
      { case_id, type: 'stop', actor: 'agent', timestamp: record.persisted_at, detail: state.stop_reason ?? 'unknown' },
    ];
    await (backend as any).writeAudit({ events });

    (state as any).persisted_at = record.persisted_at;
    (state as any).persisted_written_to_graph = written_to_graph;
    return { persisted: true, written_to_graph, case_id };
  } catch (e: any) {
    return { persisted: false, written_to_graph: false, reason: e?.message ?? String(e), case_id };
  }
}
