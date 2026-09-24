/** @module agent — Agent orchestration layer.

 * The agent prepares inputs for the investigation engine and translates its outputs
 * into actions the downstream system can execute. It does NOT run the loop itself —
 * the loop lives in `src/core/loop.ts` and is backend-agnostic.
 *
 * The optional LLM is slotted in here to interpret evidence and phrase the narrative,
 * while the deterministic core remains the source of truth for the decision. With no
 * LLM configured the deterministic adapter from `src/llm/` is used.
 */

import { createLlmAdapter } from '../llm/index.js';
import { createInvestigationState } from '../core/index.js';
import { InvestigationEngine } from '../core/loop.js';
import { selectBackend } from '../graph/select.js';
import { caseIdFor } from './trigger.js';
import { buildResult } from './result.js';
import { assessState } from './assess.js';
import type { AgentConfig, AgentOptions } from './agent.js';
import { FraudAgent } from './agent.js';
import type { Trigger } from '../core/types.js';

export { buildTrigger, caseIdFor, normaliseTriggerType, triggerProblem, TRIGGER_TYPES } from './trigger.js';
export { buildResult, summarizeResult, toLlmEvidence, type ActionRecord, type InvestigationResult } from './result.js';
export { FraudAgent, investigate, stepOnce, investigateFromInput, type AgentConfig, type AgentOptions } from './agent.js';
export { assessState, makeAssessor, closedStatsFor } from './assess.js';

/** Run a full investigation for a trigger with an injected backend and LLM. */
export async function runInvestigation(
  trigger: Trigger,
  options?: AgentOptions,
): Promise<{ result: import('./result.js').InvestigationResult; backend: import('../graph/contract.js').GraphBackend; state: import('../core/types.js').InvestigationState }> {
  const agent = await FraudAgent.create(trigger, options);
  const state = await agent.engine.runUntilStop();
  return { result: await buildResult(state, agent.llm, agent.backend), backend: agent.backend, state };
}
