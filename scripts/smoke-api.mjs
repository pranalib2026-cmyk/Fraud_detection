#!/usr/bin/env node
/** REST API smoke test: spawn the server, hit /, /health, /tools, a tool call and
 *  POST /api/v1/investigate, asserting the investigation endpoint returns a real assessment.
 *
 * Run: node scripts/smoke-api.mjs
 * Exits 0 when every endpoint answers correctly, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_API_PORT ?? 3177);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(PORT), API_HOST: '127.0.0.1', API_LOG: 'true' },
});

let stderr = '';
let finished = false;
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', () => { /* protocol noise: the API logs to stderr */ });
child.on('exit', (code) => {
  if (finished) return;
  console.error(`[smoke-api] server exited early (code ${code})`);
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  process.exit(1);
});

const timer = setTimeout(() => {
  console.error('[smoke-api] TIMEOUT');
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  finished = true;
  child.kill();
  process.exit(1);
}, 45_000);

const fail = (msg) => {
  console.error(`[smoke-api] FAIL: ${msg}`);
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  finished = true;
  child.kill();
  process.exit(1);
};

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never became healthy');
}

try {
  const health = await waitForHealth(Date.now() + 30_000);
  console.log(`[smoke-api] health: backend=${health.backend?.kind ?? health.kind} degraded=${health.degraded}`);

  const rootRes = await (await fetch(`${BASE}/`)).json();
  if (!rootRes.ok || !Array.isArray(rootRes.endpoints)) throw new Error('GET / did not list endpoints');
  console.log(`[smoke-api] / endpoints=${rootRes.endpoints.length}`);

  const tools = await (await fetch(`${BASE}/tools`)).json();
  if (!tools.ok || tools.count < 19) throw new Error(`GET /tools returned count=${tools?.count}, expected >=19`);
  console.log(`[smoke-api] /tools count=${tools.count}`);

  const toolCall = await (await fetch(`${BASE}/tools/txn_detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txn_id: '3514030' }),
  })).json();
  if (!toolCall.ok || !toolCall.result) throw new Error('POST /tools/txn_detail failed');
  console.log('[smoke-api] POST /tools/txn_detail ok');

  const invRes = await fetch(`${BASE}/api/v1/investigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: '3514030',
      card_id: 'C12382-K1',
      customer_id: 'C12382',
      amount_usd: 77.07,
      risk_score: 0.61,
      trigger_type: 'risk_score',
      ts: '2016-12-05 01:55:28',
      max_steps: 4,
    }),
  });
  const inv = await invRes.json();
  if (!inv.ok || !inv.result) throw new Error(`POST /api/v1/investigate failed: ${JSON.stringify(inv).slice(0, 400)}`);
  const r = inv.result;
  if (r.fraud_probability === null || r.fraud_probability === undefined) throw new Error('investigate returned null fraud_probability');
  if (!r.recommendation) throw new Error('investigate returned no recommendation');
  console.log(`[smoke-api] /api/v1/investigate p=${r.fraud_probability} rec=${r.recommendation.action} evidence=${r.evidence_count} steps=${r.steps_count}`);

  console.log('[smoke-api] OK');
  clearTimeout(timer);
  finished = true;
  child.kill();
  process.exit(0);
} catch (e) {
  fail(e?.message ?? String(e));
}
