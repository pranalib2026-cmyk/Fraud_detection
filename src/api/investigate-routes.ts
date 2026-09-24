/** @module api/investigate-routes — The two investigation endpoints.

 * `POST /api/v1/investigate` runs the loop to a STOP condition and returns the full
 * result. `POST /api/v1/investigate/step` runs exactly one loop step, which is what an
 * interactive dashboard or a human-in-the-loop review uses.
 *
 * Both accept the same trigger body. A trigger needs a transaction id, a card id, a
 * customer id, and at least one of an amount or a risk score.
 */

import type { Express, Request, Response } from 'express';
import { InvestigationEngine } from '../core/loop.js';
import { createInvestigationState } from '../core/index.js';
import { buildTrigger, caseIdFor, triggerProblem } from '../agent/trigger.js';
import { buildResult } from '../agent/result.js';
import { assessState } from '../agent/assess.js';
import { createLlmAdapter } from '../llm/index.js';
import { routePath, type AppState } from './routes.js';

function llm(): ReturnType<typeof createLlmAdapter> {
  return createLlmAdapter({
    provider: process.env.HHGOA_LLM_PROVIDER ?? 'deterministic',
    model: process.env.HHGOA_LLM_MODEL ?? 'deterministic',
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.HHGOA_LLM_BASE_URL ?? '',
    maxTokens: Number(process.env.HHGOA_LLM_MAX_TOKENS ?? 2000),
    temperature: Number(process.env.HHGOA_LLM_TEMPERATURE ?? 0),
  });
}

export function registerInvestigationRoutes(app: Express, state: AppState): void {
  const backend = state.backend;
  const meta = () => ({ kind: backend.kind, degraded: backend.degraded });

  app.post(routePath('/api/v1/investigate'), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = triggerProblem(body);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const maxSteps = body.max_steps === undefined ? undefined : Number(body.max_steps);
    const maxEvidence = body.max_evidence === undefined ? undefined : Number(body.max_evidence);
    const started = Date.now();

    try {
      const trigger = buildTrigger(body);
      const adapter = llm();
      const engine = new InvestigationEngine({ backend, maxSteps, maxEvidence, assess: (st) => assessState(st, adapter, backend) });
      const st = createInvestigationState(trigger, caseIdFor(trigger));
      engine.state = st;
      await engine.runUntilStop();
      res.json({ ok: true, ...meta(), elapsed_ms: Date.now() - started, result: await buildResult(st, adapter, backend) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post(routePath('/api/v1/investigate/step'), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = triggerProblem(body);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const maxSteps = body.max_steps === undefined ? undefined : Number(body.max_steps);
    const maxEvidence = body.max_evidence === undefined ? undefined : Number(body.max_evidence);

    try {
      const trigger = buildTrigger(body);
      const adapter = llm();
      const engine = new InvestigationEngine({ backend, maxSteps, maxEvidence, assess: (st) => assessState(st, adapter, backend) });
      const st = createInvestigationState(trigger, caseIdFor(trigger));
      engine.state = st;
      const { stopped } = await engine.step();
      // Complete the cycle on stop so the step endpoint persists like a full run does.
      if (stopped) await engine.finalize();
      res.json({
        ok: true,
        ...meta(),
        stopped,
        case_id: st.case_id,
        status: st.status,
        decision_state: st.decision_state,
        fraud_probability: st.fraud_probability,
        assessed_pattern: st.assessed_pattern,
        recommendation: st.recommendation,
        steps: st.steps.length,
        evidence: st.evidence.length,
        stop_reason: st.stop_reason,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });
}
