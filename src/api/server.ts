#!/usr/bin/env node
/** @module api/server — HTTP entry point for the investigation API.

 * Thin wrapper over `createApp`: builds the backend, mounts the routes and listens.
 * Keeping the listener out of `app.ts` means tests can mount the same routes in-process
 * without occupying a port.
 *
 * Environment: API_PORT (3000) · API_HOST (127.0.0.1) · API_BASE_PATH (/) ·
 *              CORS_ORIGIN (comma-separated; unset = same-origin only) · API_LOG (false to silence)
 */

import { API_VERSION, basePathOf, createApp, createBackend } from './app.js';

const PORT = Number(process.env.API_PORT ?? 3000);
const HOST = process.env.API_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const backend = await createBackend();
  const app = createApp(backend);
  const base = basePathOf();

  const server = app.listen(PORT, HOST, () => {
    process.stderr.write(`[api] hhgoa-fraud-api v${API_VERSION} listening on http://${HOST}:${PORT}${base || '/'}\n`);
    process.stderr.write(`[api] backend=${backend.kind} degraded=${backend.degraded}\n`);
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`[api] ${signal} received, shutting down\n`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`[api] fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
