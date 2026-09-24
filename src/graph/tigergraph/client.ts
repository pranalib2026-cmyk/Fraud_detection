/** @module graph/tigergraph/client — Small, real TigerGraph RESTPP client.
 *
 * This layer deliberately does not load the local projection. It is only used after
 * a caller has supplied an explicit TigerGraph host. Credentials are never returned
 * or logged; authentication is either a bearer token or basic username/password.
 *
 * Query execution is restricted to named installed GSQL queries. There is no
 * caller-supplied raw GSQL execution in the investigation adapter.
 */

export interface TigerGraphConfig {
  host: string;
  restppPort: number;
  graph: string;
  username: string;
  password: string;
  secret: string;
  token: string;
  requestTimeoutMs: number;
}

export class TigerGraphClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'TigerGraphClientError';
    this.code = code;
    this.status = status;
  }
}

function endpoint(config: TigerGraphConfig, endpointPath: string): string {
  const base = config.host.replace(/\/+$/, '');
  return `${base}:${config.restppPort}/${endpointPath.replace(/^\/+/, '')}`;
}

function authHeaders(config: TigerGraphConfig): Record<string, string> {
  if (config.token) return { authorization: `Bearer ${config.token}` };
  const secret = config.secret || config.password;
  return { authorization: `Basic ${Buffer.from(`${config.username}:${secret}`).toString('base64')}` };
}

function safeDetail(body: string): string {
  return body.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

export function publicTigerGraphConfig(config: TigerGraphConfig): Record<string, unknown> {
  return {
    host: `${config.host}:${config.restppPort}`,
    graph: config.graph,
    authentication: config.token ? 'token' : config.secret ? 'secret' : 'basic',
    request_timeout_ms: config.requestTimeoutMs,
  };
}

async function requestJson<T>(
  config: TigerGraphConfig,
  method: 'GET' | 'POST',
  endpointPath: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = new URL(endpoint(config, endpointPath));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, config.requestTimeoutMs));
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...authHeaders(config) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'authentication_failed'
        : response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : 'tigergraph_error';
      throw new TigerGraphClientError(code, `TigerGraph HTTP ${response.status}: ${safeDetail(text)}`, response.status);
    }
    try { return JSON.parse(text) as T; } catch {
      throw new TigerGraphClientError('invalid_response', `TigerGraph returned non-JSON: ${safeDetail(text)}`, response.status);
    }
  } catch (error) {
    if (error instanceof TigerGraphClientError) throw error;
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new TigerGraphClientError('timeout', `TigerGraph request timed out after ${config.requestTimeoutMs}ms`);
    }
    throw new TigerGraphClientError('unavailable', (error as Error)?.message ?? String(error));
  } finally {
    clearTimeout(timer);
  }
}

interface RestppEnvelope<T> { result?: T; message?: string; code?: number; }
interface RestppList<T> { data?: T[]; [key: string]: unknown; }

export interface TigerGraphVertex { id?: string | number; v?: Record<string, unknown>; [key: string]: unknown; }
export interface TigerGraphEdge { from_id?: string | number; to_id?: string | number; from_type?: string; to_type?: string; e?: Record<string, unknown>; [key: string]: unknown; }

function rows<T>(payload: RestppEnvelope<RestppList<T>[]> | RestppEnvelope<RestppList<T>>): T[] {
  const value = payload?.result;
  if (Array.isArray(value)) return value.flatMap((entry) => Array.isArray(entry?.data) ? entry.data : []);
  return Array.isArray(value?.data) ? value.data : [];
}

export async function health(config: TigerGraphConfig): Promise<Record<string, unknown>> {
  const response = await requestJson<Record<string, unknown>>(config, 'GET', 'health');
  return { ...response, graph: config.graph, connection: 'tigergraph-restpp' };
}

export async function schema(config: TigerGraphConfig): Promise<Record<string, unknown>> {
  const response = await requestJson<Record<string, unknown>>(config, 'GET', `graphs/${encodeURIComponent(config.graph)}/schema`);
  return { graph: config.graph, schema: response };
}

export async function vertices(config: TigerGraphConfig, vertexType: string, limit = 1, id?: string): Promise<TigerGraphVertex[]> {
  const query = { limit, ...(id ? { id } : {}) };
  return rows<TigerGraphVertex>(await requestJson(config, 'GET', `graph/${encodeURIComponent(config.graph)}/vertices/${encodeURIComponent(vertexType)}`, undefined, query));
}

export async function edges(config: TigerGraphConfig, edgeType: string, limit = 1): Promise<TigerGraphEdge[]> {
  return rows<TigerGraphEdge>(await requestJson(config, 'GET', `graph/${encodeURIComponent(config.graph)}/edges/${encodeURIComponent(edgeType)}`, undefined, { limit }));
}

export async function executeInstalledQuery<T = unknown>(config: TigerGraphConfig, queryName: string, parameters: Record<string, unknown> = {}): Promise<T[]> {
  const response = await requestJson<RestppEnvelope<T[]>>(config, 'POST', `query/${encodeURIComponent(config.graph)}/${encodeURIComponent(queryName)}`, parameters);
  if (response?.code && response.code !== 0) {
    throw new TigerGraphClientError('query_error', response.message ?? `Installed query ${queryName} failed`);
  }
  return Array.isArray(response?.result) ? response.result : [];
}

export function queryFailure(error: unknown): { code: string; message: string } {
  if (error instanceof TigerGraphClientError) return { code: error.code, message: error.message };
  return { code: 'tigergraph_error', message: (error as Error)?.message ?? String(error) };
}

