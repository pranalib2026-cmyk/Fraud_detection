/** @module mcp/handlers — Introspection tools and the investigation-loop MCP tool.

 * Kept apart from the transport wiring so the transports (stdio, and any future HTTP
 * transport) share exactly the same handlers. The investigation tool is the agent's main
 * entry point: one call runs the whole investigate → recommend → record cycle and returns
 * the serialisable result.
 */

import { InvestigationEngine } from '../core/loop.js';
import { createInvestigationState } from '../core/index.js';
import { GRAPH_TOOL_NAMES, type GraphBackend } from '../graph/contract.js';
import { paths } from '../config.js';
import { buildTrigger, caseIdFor, triggerProblem } from '../agent/trigger.js';
import { buildResult } from '../agent/result.js';
import { assessState } from '../agent/assess.js';
import { createLlmAdapter } from '../llm/index.js';
import { DESCRIPTION, NAMESPACE, toolName, wrap, wrapError } from './names.js';
import { SCHEMA } from './schemas.js';
import { listLocalCases } from './dispatch.js';

/** Tool names this module registers — the transport must not register them twice
 *  (the MCP SDK throws on duplicate registration). */
export const HANDLER_TOOL_NAMES: readonly string[] = [
  'health', 'backend_config', 'list_tools', 'list_cases', 'investigate',
];

export function llmFromEnv(): ReturnType<typeof createLlmAdapter> {
  return createLlmAdapter({
    provider: process.env.HHGOA_LLM_PROVIDER ?? 'deterministic',
    model: process.env.HHGOA_LLM_MODEL ?? 'deterministic',
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.HHGOA_LLM_BASE_URL ?? '',
    maxTokens: Number(process.env.HHGOA_LLM_MAX_TOKENS ?? 2000),
    temperature: Number(process.env.HHGOA_LLM_TEMPERATURE ?? 0),
  });
}

/** Register health / config / list-tools / list-cases. */
export function registerIntrospectionTools(server: any, getBackend: () => Promise<GraphBackend>, loadMs: () => number): void {
  server.registerTool(toolName('health'), { title: 'Backend health', description: DESCRIPTION.health, inputSchema: SCHEMA.health }, async () => {
    const b = await getBackend();
    try {
      return wrap(b, 'health', {}, await b.health());
    } catch (e: any) {
      return wrapError(b, 'health', {}, e?.message ?? String(e));
    }
  });

  server.registerTool(toolName('backend_config'), { title: 'Backend configuration', description: DESCRIPTION.backend_config, inputSchema: SCHEMA.backend_config }, async () => {
    const b = await getBackend();
    return wrap(b, 'backend_config', {}, {
      namespace: NAMESPACE,
      kind: b.kind,
      degraded: b.degraded,
      notes: b.notes ?? [],
      load_ms: b.loadMs ?? loadMs(),
      projection: paths.projection,
      raw_dir: paths.raw,
      memory_dir: paths.memory,
      tools: GRAPH_TOOL_NAMES,
    });
  });

  server.registerTool(toolName('list_tools'), { title: 'List tools', description: DESCRIPTION.list_tools, inputSchema: SCHEMA.list_tools }, async () => {
    const tools = Object.keys(DESCRIPTION).map((short) => ({ name: toolName(short), description: DESCRIPTION[short] }));
    return wrap(await getBackend(), 'list_tools', {}, { namespace: NAMESPACE, count: tools.length, tools });
  });

  server.registerTool(toolName('list_cases'), { title: 'List cases', description: DESCRIPTION.list_cases, inputSchema: SCHEMA.list_cases }, async () => {
    const b = await getBackend();
    const cases = listLocalCases(b);
    return wrap(b, 'list_cases', {}, { count: cases.length, cases });
  });
}

/** Register the full-investigation tool. */
export function registerInvestigationTool(server: any, getBackend: () => Promise<GraphBackend>): void {
  server.registerTool(toolName('investigate'), {
    title: 'Run a full investigation',
    description: DESCRIPTION.investigate,
    inputSchema: SCHEMA.investigate,
  }, async (args: Record<string, unknown>) => {
    const b = await getBackend();
    const problem = triggerProblem(args);
    if (problem) return wrapError(b, 'investigate', args, problem, 'INVALID_TRIGGER');

    const maxSteps = args.max_steps === undefined ? undefined : Number(args.max_steps);
    const maxEvidence = args.max_evidence === undefined ? undefined : Number(args.max_evidence);

    try {
      const trigger = buildTrigger(args);
      const adapter = llmFromEnv();
      const engine = new InvestigationEngine({ backend: b, maxSteps, maxEvidence, assess: (state) => assessState(state, adapter, b) });
      const state = createInvestigationState(trigger, caseIdFor(trigger));
      engine.state = state;
      await engine.runUntilStop();
      return wrap(b, 'investigate', args, await buildResult(state, adapter, b));
    } catch (e: any) {
      return wrapError(b, 'investigate', args, e?.message ?? String(e));
    }
  });
}
