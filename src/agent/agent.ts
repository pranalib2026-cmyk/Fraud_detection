/** @module agent/agent — Stateful investigation agent (for step-wise / interactive hosts).

 * `runInvestigation` in `index.ts` is the one-shot API. This module adds a stateful
 * wrapper for hosts that want to drive the loop themselves: the demo CLI's `step`
 * command, the REST `/investigate/step` endpoint, and MCP clients that inspect state
 * between tool calls.
 */

import { createLlmAdapter } from '../llm/index.js';
import { createInvestigationState } from '../core/index.js';
import { InvestigationEngine } from '../core/loop.js';
import { selectBackend } from '../graph/select.js';
import { buildTrigger, caseIdFor } from './trigger.js';
import { buildResult } from './result.js';
import { assessState } from './assess.js';
import type { InvestigationState, Trigger } from '../core/types.js';
import type { GraphBackend } from '../graph/contract.js';
import type { InvestigationResult } from './result.js';

/** Internal construction contract: a selected graph backend is always required. */
export interface AgentConfig {
  trigger: Trigger;
  caseId?: string;
  maxSteps?: number;
  maxEvidence?: number;
  llmProvider?: string;
  llmModel?: string;
  llmApiKey?: string;
  backend: GraphBackend;
}

/** Public options: callers may inject a backend; otherwise it is selected asynchronously. */
export type AgentOptions = Omit<AgentConfig, 'trigger' | 'backend'> & { backend?: GraphBackend };

export class FraudAgent {
  backend: GraphBackend;
  llm: ReturnType<typeof createLlmAdapter>;
  engine: InvestigationEngine;
  caseId: string;
  private trigger: Trigger;

  constructor(config: AgentConfig) {
    this.trigger = config.trigger;
    this.caseId = config.caseId ?? caseIdFor(config.trigger);
    this.backend = config.backend;
    this.llm = createLlmAdapter({
      provider: config.llmProvider ?? process.env.HHGOA_LLM_PROVIDER ?? 'deterministic',
      model: config.llmModel ?? process.env.HHGOA_LLM_MODEL ?? 'deterministic',
      apiKey: config.llmApiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.HHGOA_LLM_BASE_URL ?? '',
      maxTokens: Number(process.env.HHGOA_LLM_MAX_TOKENS ?? 2000),
      temperature: Number(process.env.HHGOA_LLM_TEMPERATURE ?? 0),
    });
    this.engine = new InvestigationEngine({
      backend: this.backend,
      maxSteps: config.maxSteps,
      maxEvidence: config.maxEvidence,
      assess: (state) => assessState(state, this.llm, this.backend),
    });
    this.engine.state = createInvestigationState(this.trigger, this.caseId);
  }

  get state(): InvestigationState {
    return this.engine.state as InvestigationState;
  }

  /** Build an agent using centralized backend selection, unless a backend is explicitly injected. */
  static async create(trigger: Trigger, options?: AgentOptions): Promise<FraudAgent> {
    const backend = options?.backend ?? await selectBackend();
    return new FraudAgent({ trigger, ...options, backend });
  }

  /** Advance the loop one step. */
  async step(): Promise<{ stopped: boolean; state: InvestigationState }> {
    const { stopped } = await this.engine.step();
    return { stopped, state: this.state };
  }

  /** Advance the loop to a STOP condition and return the serialisable result. */
  async run(): Promise<InvestigationResult> {
    const state = await this.engine.runUntilStop();
    return await buildResult(state, this.llm, this.backend);
  }
}

/** One-shot convenience: build a fresh agent and run it to completion. */
export async function investigate(trigger: Trigger, options?: AgentOptions): Promise<InvestigationResult> {
  return (await FraudAgent.create(trigger, options)).run();
}

/** Advance one step only — useful for interactive hosts. */
export async function stepOnce(
  trigger: Trigger,
  options?: AgentOptions,
): Promise<{ stopped: boolean; result: InvestigationResult }> {
  const agent = await FraudAgent.create(trigger, options);
  const { stopped } = await agent.step();
  // When the loop stopped, complete the cycle (recommendation/SAR/persist) so step-wise
  // hosts return the same finished state as a full run.
  if (stopped) await agent.engine.finalize();
  return { stopped, result: await buildResult(agent.state, agent.llm, agent.backend) };
}

/** Build a trigger from raw fields and run it — the single entry point hosts use. */
export async function investigateFromInput(
  input: Record<string, unknown>,
  options?: AgentOptions,
): Promise<InvestigationResult> {
  return investigate(buildTrigger(input), options);
}
