/** @module api/routes — REST route table.

 * Kept separate from `app.ts` so the route surface can be read in one place and driven
 * against an in-memory backend without binding a port. Tool calls go through the same
 * dispatch table the MCP server uses, so HTTP and MCP return identical payloads.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { GRAPH_TOOL_NAMES, type GraphBackend } from '../graph/contract.js';
import { DESCRIPTION } from '../mcp/names.js';
import { dispatchTool, listLocalCases, readAudit, readEvidence } from '../mcp/dispatch.js';
import { paths } from '../config.js';
import { registerInvestigationRoutes } from './investigate-routes.js';

export interface AppState { backend: GraphBackend; }

export function routePath(path: string): string {
  const base = `/${(process.env.API_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  return `${base}${path}`;
}

export function registerRoutes(app: Express, state: AppState): void {
  const backend = state.backend;
  const r = routePath;
  const meta = () => ({ kind: backend.kind, degraded: backend.degraded });

  app.get(r('/'), (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: 'TigerGraph Agentic Fraud Investigation API',
      version: '1.0.0',
      backend: meta(),
      endpoints: [
        { method: 'GET', path: r('/health') },
        { method: 'GET', path: r('/config') },
        { method: 'GET', path: r('/tools') },
        { method: 'POST', path: r('/tools/:tool') },
        { method: 'POST', path: r('/api/v1/investigate') },
        { method: 'POST', path: r('/api/v1/investigate/step') },
        { method: 'GET', path: r('/api/v1/investigate/:caseId') },
        { method: 'POST', path: r('/api/v1/investigate/:caseId') },
        { method: 'GET', path: r('/api/v1/cases') },
      ],
    });
  });

  app.get(r('/health'), async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, api_version: '1.0.0', ...(await backend.health()), timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get(r('/config'), (_req: Request, res: Response) => {
    res.json({
      ok: true,
      ...meta(),
      notes: backend.notes ?? [],
      load_ms: backend.loadMs,
      projection: paths.projection,
      raw_dir: paths.raw,
      memory_dir: paths.memory,
      tools: GRAPH_TOOL_NAMES,
      llm_provider: process.env.HHGOA_LLM_PROVIDER ?? 'deterministic',
      timestamp: new Date().toISOString(),
    });
  });

  app.get(r('/tools'), (_req: Request, res: Response) => {
    res.json({
      ok: true,
      count: GRAPH_TOOL_NAMES.length,
      tools: GRAPH_TOOL_NAMES.map((t) => ({ name: t, description: DESCRIPTION[t] ?? 'Graph tool.' })),
    });
  });

  app.post(r('/tools/:tool'), async (req: Request, res: Response) => {
    const tool = String(req.params.tool);
    if (!GRAPH_TOOL_NAMES.includes(tool)) {
      return res.status(400).json({ ok: false, error: `Unknown tool: ${tool}`, available: GRAPH_TOOL_NAMES });
    }
    try {
      const payload = await dispatchTool(backend, tool, (req.body ?? {}) as Record<string, unknown>);
      res.json({ ok: true, tool, ...meta(), result: payload, timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ ok: false, tool, error: e?.message ?? String(e) });
    }
  });

  app.get(r('/api/v1/cases'), (_req: Request, res: Response) => {
    const cases = listLocalCases(backend);
    res.json({ ok: true, ...meta(), count: cases.length, cases });
  });

  app.get(r('/api/v1/investigate/:caseId'), async (req: Request, res: Response) => {
    const caseId = String(req.params.caseId);
    try {
      const record = await backend.readCase({ case_id: caseId });
      res.json({ ok: true, ...meta(), case_id: caseId, record, evidence: readEvidence(backend, caseId), audit: readAudit(backend, caseId) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post(r('/api/v1/investigate/:caseId'), async (req: Request, res: Response) => {
    const caseId = String(req.params.caseId);
    try {
      const updated = await backend.updateCase(caseId, (req.body ?? {}) as Record<string, unknown>);
      await backend.writeAudit({ events: [{ case_id: caseId, type: 'case_updated', actor: 'api', timestamp: new Date().toISOString() }] });
      res.json({ ok: true, ...meta(), case_id: caseId, updated });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  registerInvestigationRoutes(app, state);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(`[api] unhandled error: ${err?.message ?? err}\n`);
    res.status(500).json({ ok: false, error: err?.message ?? 'Internal error' });
  });
}
