import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FraudAgent } from '../src/agent/agent.js';
import { createBackend } from '../src/api/app.js';
import { selectBackend } from '../src/graph/select.js';
import type { GraphBackend } from '../src/graph/contract.js';
import type { Trigger } from '../src/core/types.js';

const ENV_KEYS = [
  'TG_HOST', 'TG_GRAPH', 'TG_GRAPHNAME', 'TG_TOKEN', 'TG_API_TOKEN',
  'TG_SECRET', 'TG_USERNAME', 'TG_PASSWORD', 'TG_TIMEOUT_MS',
  'HHGOA_GRAPH_BACKEND', 'HHGOA_ALLOW_LOCAL_FALLBACK',
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const trigger: Trigger = {
  type: 'risk_score', transaction_id: '3514030', card_id: 'C12382-K1', customer_id: 'C12382',
  risk_score: 0.61, amount_usd: 77.07, ts: '2016-12-05 01:55:28', description: 'selection test',
};

function clearTigerGraphEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(clearTigerGraphEnv);
afterEach(() => {
  clearTigerGraphEnv();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe('central backend selection', () => {
  it('preserves an explicitly injected backend on FraudAgent.create()', async () => {
    const injected = { kind: 'injected-test', degraded: false } as unknown as GraphBackend;
    const agent = await FraudAgent.create(trigger, { backend: injected });
    expect(agent.backend).toBe(injected);
  });

  it('selects TigerGraph only when a complete configuration is present and its health call succeeds', async () => {
    process.env.HHGOA_GRAPH_BACKEND = 'tigergraph';
    process.env.TG_HOST = 'http://127.0.0.1';
    process.env.TG_GRAPH = 'hhgoa_test';
    process.env.TG_TOKEN = 'test-token-not-a-secret';
    process.env.HHGOA_ALLOW_LOCAL_FALLBACK = 'false';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok' }),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const backend = await selectBackend();
    expect(backend.kind).toBe('tigergraph');
    expect(backend.degraded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not claim TigerGraph when requested configuration is incomplete', async () => {
    process.env.HHGOA_GRAPH_BACKEND = 'tigergraph';
    process.env.TG_HOST = 'http://127.0.0.1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const backend = await selectBackend();
    expect(backend.kind).toBe('local-simulated');
    expect(backend.degraded).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backend.notes?.join(' ')).toContain('configuration is incomplete');
  });

  it('keeps an unreachable configured graph as an explicit local fallback', async () => {
    process.env.HHGOA_GRAPH_BACKEND = 'tigergraph';
    process.env.TG_HOST = 'http://127.0.0.1';
    process.env.TG_GRAPHNAME = 'hhgoa_test';
    process.env.TG_USERNAME = 'test-user';
    process.env.TG_PASSWORD = 'test-password';
    process.env.HHGOA_ALLOW_LOCAL_FALLBACK = 'true';
    process.env.TG_TIMEOUT_MS = '250';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));

    const backend = await selectBackend();
    expect(backend.kind).toBe('local-simulated');
    expect(backend.degraded).toBe(true);
    expect(backend.notes?.join(' ')).toContain('unreachable');
  });

  it('keeps API, CLI, evaluator, benchmark and agent on the centralized path', async () => {
    process.env.HHGOA_GRAPH_BACKEND = 'local';
    expect((await createBackend()).kind).toBe('local-simulated');

    const expectedImports: Record<string, string> = {
      'src/agent/agent.ts': 'selectBackend',
      'src/api/app.ts': 'selectBackend',
      'src/cli/benchmark.ts': 'selectBackend',
      'src/evaluator/runner.ts': 'selectBackend',
      'src/cli/investigate.ts': 'investigate',
      'src/cli/demo.ts': 'investigate',
    };
    for (const [file, symbol] of Object.entries(expectedImports)) {
      expect(fs.readFileSync(path.join(process.cwd(), file), 'utf8')).toContain(symbol);
    }

    const sourceRoot = path.join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
      }
    };
    walk(sourceRoot);
    const allowed = new Set([
      path.join(sourceRoot, 'graph', 'local', 'backend.ts'),
      path.join(sourceRoot, 'graph', 'select.ts'),
    ]);
    const directConstruction = files.filter((file) => !allowed.has(file) && /\bcreateLocalBackend\s*\(/.test(fs.readFileSync(file, 'utf8')));
    expect(directConstruction).toEqual([]);
  });
});
