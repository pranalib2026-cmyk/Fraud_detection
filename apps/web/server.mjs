import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.UI_PORT ?? 4173);
const apiTarget = new URL(process.env.HHGOA_API_URL ?? 'http://127.0.0.1:3000');
const proxyPrefixes = ['/api/', '/health', '/config', '/tools'];
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function proxy(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) {
      sendJson(res, 413, { ok: false, error: 'Request body too large' });
      return;
    }
    chunks.push(chunk);
  }
  const headers = { accept: req.headers.accept ?? 'application/json' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  try {
    const response = await fetch(new URL(req.url, apiTarget), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const responseHeaders = { 'cache-control': 'no-store' };
    const contentType = response.headers.get('content-type');
    if (contentType) responseHeaders['content-type'] = contentType;
    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, { ok: false, error: `Investigation API unavailable at ${apiTarget.origin}`, detail: error instanceof Error ? error.message : String(error) });
  }
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const file = path.resolve(here, relative);
  if (!file.startsWith(path.resolve(here) + path.sep)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  fs.stat(file, (error, info) => {
    if (error || !info.isFile()) return sendJson(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (proxyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) return void proxy(req, res);
  serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[web] HHGOA investigation workspace: http://127.0.0.1:${port} (API proxy: ${apiTarget.origin})\n`);
});
