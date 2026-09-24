#!/usr/bin/env node
/** @module mcp/stdio-server — MCP server exposing the graph and the investigation loop.

 * Transport: stdio (one MCP session per process) — the transport Claude Desktop, Cursor,
 * VS Code and MCP SDK clients use by default. Tool names are namespaced (`hhgoa__*`) so
 * this server can run alongside the official TigerGraph MCP server without collision.

 * The server does not talk to TigerGraph directly. It delegates to the same
 * `GraphBackend` the CLI and REST API use, so every host shares one evidence path and one
 * provenance format. Which backend is live (`tigergraph` or `local-simulated`) is reported
 * on every result through the `backend` and `degraded` fields.

 * Run:              npx tsx src/mcp/stdio-server.ts
 * Inspect visually: npx @modelcontextprotocol/inspector npx tsx src/mcp/stdio-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { selectBackend } from '../graph/select.js';
import { GRAPH_TOOL_NAMES, type GraphBackend } from '../graph/contract.js';
import { DESCRIPTION, NAMESPACE, toolName, wrap, wrapError } from './names.js';
import { SCHEMA } from './schemas.js';
import { dispatchTool } from './dispatch.js';
import { HANDLER_TOOL_NAMES, registerIntrospectionTools, registerInvestigationTool } from './handlers.js';

export const MCP_VERSION = '1.0.0';

let backendPromise: Promise<GraphBackend> | null = null;
let loadStartedAt = 0;

export function getBackend(): Promise<GraphBackend> {
  if (!backendPromise) {
    loadStartedAt = Date.now();
    backendPromise = selectBackend();
  }
  return backendPromise;
}

const loadMs = (): number => Math.max(0, Date.now() - loadStartedAt);

/** Build the server with every tool registered. Exported so tests can drive it in-process. */
export function createMcpServer(): { server: McpServer; getBackend: () => Promise<GraphBackend> } {
  const server = new McpServer({ name: 'hhgoa-tigergraph-fraud-agent', version: MCP_VERSION });

  // One thin adapter per graph tool: validate → dispatch → wrap with provenance.
  for (const short of GRAPH_TOOL_NAMES) {
    // `health` (and any future overlap) is owned by the handlers below — the SDK throws
    // on duplicate tool names, so skip the loop copy and let the handler register it.
    if (HANDLER_TOOL_NAMES.includes(short)) continue;
    const inputSchema = (SCHEMA as Record<string, any>)[short] ?? {};
    server.registerTool(toolName(short), {
      title: short,
      description: DESCRIPTION[short] ?? 'Graph tool.',
      inputSchema,
    }, async (args: Record<string, unknown>) => {
      const b = await getBackend();
      try {
        return wrap(b, short, args, await dispatchTool(b, short, args));
      } catch (e: any) {
        return wrapError(b, short, args, e?.message ?? String(e));
      }
    });
  }

  registerIntrospectionTools(server, getBackend, loadMs);
  registerInvestigationTool(server, getBackend);

  return { server, getBackend };
}

async function main(): Promise<void> {
  const { server } = createMcpServer();
  try { await (await getBackend()).health(); } catch { /* an unavailable graph is reported by tool calls */ }
  await server.connect(new StdioServerTransport());
  // Backend selection was completed before connecting the transport.
  // stdout carries the protocol; diagnostics must go to stderr.
  process.stderr.write(`[mcp] hhgoa-tigergraph-fraud-agent v${MCP_VERSION} ready (namespace ${NAMESPACE}__, ${Object.keys(DESCRIPTION).length} tools)\n`);
}

// Only start the transport when run directly, not when imported by a test or the API.
const invokedDirectly = process.argv[1] ? /stdio-server\.(t|j)s$/.test(process.argv[1]) : false;
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`[mcp] fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
