#!/usr/bin/env node
/** @module api/app — Express application assembly.

 * This is the integration point for external systems (case management, analyst
 * dashboards, alerting) that want to drive an investigation or query the graph without
 * speaking MCP. It uses the same `GraphBackend` and the same tool dispatch table as the
 * MCP server, so a tool call over HTTP and a tool call over MCP return identical payloads
 * — including the `backend` / `degraded` markers.

 * Routes (all relative to API_BASE_PATH, default "/"):
 *   GET  /                        service descriptor
 *   GET  /health                  backend health + projection summary
 *   GET  /config                  backend configuration visible to this process
 *   GET  /tools                   the graph tools and their descriptions
 *   POST /tools/:tool             call one graph tool
 *   GET  /api/v1/cases            list locally stored cases
 *   POST /api/v1/investigate      run a full investigation
 *   POST /api/v1/investigate/step run a single loop step
 *   GET  /api/v1/investigate/:id  read a case with its evidence and audit trail
 *   POST /api/v1/investigate/:id  patch a case record
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { loadEnv } from '../config.js';
import { selectBackend } from '../graph/select.js';
import type { GraphBackend } from '../graph/contract.js';
import { registerRoutes } from './routes.js';

loadEnv();

export const API_VERSION = '1.0.0';

/** The request path prefix given to every route. Empty string means the site root. */
export function basePathOf(): string {
  return `/${(process.env.API_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
}

/** Select the configured backend. Local simulation remains an explicit fallback. */
export async function createBackend(): Promise<GraphBackend> {
  return selectBackend();
}

export function createApp(backend: GraphBackend): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const origin = process.env.CORS_ORIGIN;
  if (origin) app.use(cors({ origin: origin.split(',').map((s) => s.trim()) }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.setHeader('x-request-id', String(req.headers['x-request-id'] ?? `req-${startedAt}-${Math.random().toString(36).slice(2, 8)}`));
    res.on('finish', () => {
      if (process.env.API_LOG !== 'false') {
        process.stderr.write(`[api] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - startedAt}ms)\n`);
      }
    });
    next();
  });

  registerRoutes(app, { backend });
  return app;
}
