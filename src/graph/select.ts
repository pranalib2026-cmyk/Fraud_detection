/** @module graph/select — Honest backend selection (Phase 1).
 *
 * Selection rules:
 *   - HHGOA_GRAPH_BACKEND=local            → local, labelled "deliberately not used"
 *   - TG_HOST set                          → TigerGraph backend; probe it first
 *     · probe OK                           → real TigerGraph (degraded=false)
 *     · probe fails + fallback allowed     → local with an explicit "configured but
 *                                            unreachable" note (never presented as TG)
 *     · probe fails + fallback disabled    → TigerGraph backend that errors loudly
 *   - nothing configured                   → local simulation (default dev mode)
 * Every backend exposes kind + degraded, so downstream payloads always tell the truth.
 */
import { graphConfig, loadEnv, paths } from '../config.js';
import { createLocalBackend } from './local/backend.js';
import { createTigerGraphBackend } from './tigergraph/backend.js';
import type { GraphBackend } from '../graph/contract.js';
import type { TigerGraphBackend } from './tigergraph/backend.js';

interface SelectedTigerGraphBackend extends TigerGraphBackend {
  tigergraph?: Record<string, unknown>;
}

function localBackend(notes: string[], tgInfo?: Record<string, unknown>): GraphBackend {
  const backend = createLocalBackend({ projectionFile: paths.projection, rawDir: paths.raw, memoryDir: paths.memory }) as GraphBackend & { tigergraph?: Record<string, unknown> };
  backend.notes = [...notes, ...(backend.notes ?? [])];
  if (tgInfo) backend.tigergraph = tgInfo;
  return backend;
}

export async function selectBackend(): Promise<GraphBackend> {
  loadEnv();
  const cfg = graphConfig();
  const explicitLocal = (process.env.HHGOA_GRAPH_BACKEND ?? '').toLowerCase() === 'local';

  if (explicitLocal) {
    return localBackend(['HHGOA_GRAPH_BACKEND=local — TigerGraph deliberately not used (LOCAL SIMULATION).']);
  }

  if (cfg.configured && cfg.requested !== 'local') {
    const tg = createTigerGraphBackend(cfg.tigerGraph) as SelectedTigerGraphBackend;
    const probe = await tg.probe(Math.min(3000, cfg.tigerGraph.requestTimeoutMs));
    if (probe.ok) {
      tg.notes = [`TigerGraph reachable at ${cfg.tigerGraph.host} (probe ${probe.ms}ms).`, ...(tg.notes ?? [])];
      tg.tigergraph = { configured: true, reachable: true, host: cfg.tigerGraph.host, graph: cfg.tigerGraph.graph };
      return tg;
    }
    if (cfg.allowFallback) {
      return localBackend(
        [`TigerGraph configured at ${cfg.tigerGraph.host} but unreachable (${probe.error}). LOCAL SIMULATION fallback (HHGOA_ALLOW_LOCAL_FALLBACK=true) — degraded=true and never presented as TigerGraph.`],
        { configured: true, reachable: false, host: cfg.tigerGraph.host, error: probe.error },
      );
    }
    tg.notes = [`TigerGraph configured but unreachable (${probe.error}); local fallback disabled — tool calls will fail loudly.`];
    tg.tigergraph = { configured: true, reachable: false, host: cfg.tigerGraph.host, error: probe.error };
    return tg;
  }

  if (cfg.requested === 'tigergraph' && !cfg.configured) {
    return localBackend(
      ['TigerGraph was requested but required configuration is incomplete (TG_HOST, TG_GRAPH/TG_GRAPHNAME, and token/secret or username+password are required). LOCAL SIMULATION fallback; degraded=true.'],
      { configured: false, reachable: false, requested: 'tigergraph', error: 'invalid_configuration' },
    );
  }

  return localBackend(['TigerGraph not configured — LOCAL SIMULATION mode.'], { configured: false, reachable: false, error: 'not_configured' });
}
