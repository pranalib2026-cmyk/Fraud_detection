/**
 * Runtime configuration.
 *
 * Everything that could change between environments (dataset location, TigerGraph
 * connection, MCP transport, LLM provider, investigation weights and bounds) is
 * resolved here so the rest of the system never reads process.env directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

export function loadEnv() {
  // dotenv already called at module load; this is a no-op hook so callers can
  // explicitly trigger loading if they wish. Kept for API compatibility.
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');

export const paths = {
  repoRoot,
  data: process.env.HHGOA_DATA_DIR ? path.resolve(process.env.HHGOA_DATA_DIR) : path.join(repoRoot, 'data'),
  get raw() { return path.join(this.data, 'raw', 'HHGOA_IEEE'); },
  get derived() { return path.join(this.data, 'derived'); },
  get projection() { return path.join(this.data, 'derived', 'projection.bin'); },
  /** Local case/evidence/audit store used in degraded mode and by the MCP/API hosts. */
  get memory() { return process.env.HHGOA_MEMORY_DIR ? path.resolve(process.env.HHGOA_MEMORY_DIR) : path.join(repoRoot, 'outputs', 'memory'); },
  /** Benchmark / evaluation artefacts. */
  get outputs() { return process.env.HHGOA_OUTPUTS_DIR ? path.resolve(process.env.HHGOA_OUTPUTS_DIR) : path.join(repoRoot, 'outputs'); },
  get cases() { return path.join(repoRoot, 'cases'); },
  get docs() { return path.join(repoRoot, 'docs'); },
  get corpus() { return path.join(repoRoot, 'corpus'); },
  get config() { return path.join(repoRoot, 'config'); },
  get audit() { return process.env.HHGOA_AUDIT_DIR ? path.resolve(process.env.HHGOA_AUDIT_DIR) : path.join(repoRoot, '.audit'); },
};

export const requiredRawFiles = [
  'transactions.csv', 'identity.csv', 'closed_cases_history.csv', 'case_pack.csv', 'README.md',
];

export function rawDatasetAvailable(root = paths.raw) {
  return requiredRawFiles.every((f) => fs.existsSync(path.join(root, f)));
}

export function requireRawDataset(root = paths.raw) {
  if (!rawDatasetAvailable(root)) {
    throw new Error(
      `Dataset not found in ${root}. Place transactions.csv, identity.csv, closed_cases_history.csv, case_pack.csv and README.md there (see docs/setup.md).`,
    );
  }
  return root;
}

/** Graph backend selection. `tigergraph` is the real deployment; `local` is the documented degraded mode. */
export function graphConfig() {
  const host = (process.env.TG_HOST ?? '').trim();
  const graph = (process.env.TG_GRAPH ?? process.env.TG_GRAPHNAME ?? '').trim();
  const token = (process.env.TG_TOKEN ?? process.env.TG_API_TOKEN ?? '').trim();
  const username = (process.env.TG_USERNAME ?? '').trim();
  const password = (process.env.TG_PASSWORD ?? '').trim();
  const secret = (process.env.TG_SECRET ?? '').trim();
  const authenticationConfigured = Boolean(token || secret || (username && password));
  const requested = (process.env.HHGOA_GRAPH_BACKEND ?? (host ? 'tigergraph' : 'local')).toLowerCase();
  return {
    requested,
    /** TigerGraph mode requires an explicit host, graph, and authentication tuple. */
    configured: Boolean(host && graph && authenticationConfigured),
    tigerGraph: {
      host: host || 'http://localhost',
      restppPort: Number(process.env.TG_RESTPP_PORT ?? 14240),
      gsqlPort: Number(process.env.TG_GSQL_PORT ?? 14240),
      graph: graph || 'hhgoa_fraud',
      username: username || 'tigergraph',
      password: password || 'tigergraph',
      secret,
      token: token || process.env.TG_API_TOKEN || '',
      requestTimeoutMs: Number(process.env.TG_TIMEOUT_MS ?? 30_000),
    },
    allowFallback: (process.env.HHGOA_ALLOW_LOCAL_FALLBACK ?? 'true').toLowerCase() !== 'false',
  };
}

/** MCP configuration: either proxy the official TigerGraph MCP server, or run the in-process one. */
export function mcpConfig() {
  return {
    mode: (process.env.HHGOA_MCP_MODE ?? 'in-process').toLowerCase(),
    remoteCommand: process.env.TIGERGRAPH_MCP_COMMAND ?? '',
    remoteArgs: (process.env.TIGERGRAPH_MCP_ARGS ?? '').split(' ').filter(Boolean),
    remoteUrl: process.env.TIGERGRAPH_MCP_URL ?? '',
  };
}

export function llmConfig() {
  return {
    provider: (process.env.LLM_PROVIDER ?? process.env.HHGOA_LLM_PROVIDER ?? 'deterministic').toLowerCase(),
    model: process.env.LLM_MODEL ?? process.env.HHGOA_LLM_MODEL ?? '',
    apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.HHGOA_LLM_BASE_URL ?? '',
    maxTokens: Number(process.env.HHGOA_LLM_MAX_TOKENS ?? 2000),
    temperature: Number(process.env.HHGOA_LLM_TEMPERATURE ?? 0),
    /** True only when a key was actually provided (value never leaves this module). */
    keyPresent: Boolean(process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY),
  };
}

/** Document-side GraphRAG configuration (local index by default; no external service required). */
export function ragConfig() {
  return {
    provider: (process.env.DOCUMENT_RAG_PROVIDER ?? 'local-bm25').toLowerCase(),
    extraPath: process.env.DOCUMENT_RAG_PATH ?? '',
  };
}
