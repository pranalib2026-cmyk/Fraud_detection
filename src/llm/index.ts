/** @module llm — LLM adapter barrel.

 * The LLM supports reasoning, tool selection, evidence synthesis and explanation.
 * It never replaces deterministic graph analysis. The deterministic adapter is the
 * default and needs no API key; the provider adapter is selected with
 * `HHGOA_LLM_PROVIDER` and falls back explicitly when unavailable.
 */

export { createLlmAdapter, createDeterministicAdapter } from './deterministic.js';
export { deterministicReasoning, clampProbability } from './reasoning.js';
export { deterministicActions } from './actions.js';
export { signalActions } from './actions-signal.js';
export { synthesize, synthesizeEvidence, explainSelection, summarizeEvidence, reasoningText, patternDescription, confidenceLevel } from './explain.js';
export * from './types.js';
