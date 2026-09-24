#!/usr/bin/env node
/** MCP stdio smoke test: spawn the server, initialize, list tools, call health.
 *
 * Run: node scripts/smoke-mcp.mjs
 * Exits 0 when the server starts, registers the expected tools and answers a call;
 * exits 1 with stderr diagnostics otherwise.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp/stdio-server.ts'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let stderr = '';
let finished = false;
const pending = new Map();

child.stderr.on('data', (d) => { stderr += d.toString(); });
// Fail fast if the server dies during startup instead of waiting for the full timeout.
child.on('exit', (code) => {
  if (finished) return;
  console.error(`[smoke-mcp] server exited early (code ${code})`);
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  process.exit(1);
});
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const request = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, { resolve, reject });
  send({ jsonrpc: '2.0', id, method, params });
});

const timer = setTimeout(() => {
  console.error('[smoke-mcp] TIMEOUT waiting for the server');
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  child.kill();
  process.exit(1);
}, 30_000);

const fail = (e) => {
  finished = true;
  console.error('[smoke-mcp] FAIL:', e?.message ?? e);
  if (stderr) console.error('stderr:', stderr.slice(-2000));
  child.kill();
  process.exit(1);
};

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hhgoa-smoke', version: '0.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request(2, 'tools/list', {});
  const names = (list.tools ?? []).map((t) => t.name);
  console.log(`[smoke-mcp] server=${init?.serverInfo?.name ?? 'unknown'} tools=${names.length}`);

  if (names.length < 10) throw new Error(`expected >=10 tools, got ${names.length}: ${names.join(', ')}`);
  for (const suffix of ['txn_detail', 'card_testing_scan', 'card_window', 'investigate', 'health']) {
    if (!names.some((n) => n === suffix || n.endsWith(`__${suffix}`))) throw new Error(`missing tool: ${suffix}`);
  }

  const healthName = names.find((n) => n === 'health' || n.endsWith('__health'));
  const health = await request(3, 'tools/call', { name: healthName, arguments: {} });
  const text = health?.content?.[0]?.text ?? '';
  console.log(`[smoke-mcp] health: ${String(text).slice(0, 160)}`);
  if (!text) throw new Error('health call returned no text content');

  console.log('[smoke-mcp] OK');
  clearTimeout(timer);
  finished = true;
  child.kill();
  process.exit(0);
} catch (e) {
  fail(e);
}
