/** @module core — Investigation state types */

export interface InvestigationState {
  case_id: string;
  trigger: Trigger;
  status: InvestigationStatus;
  trigger_ts: string;
  opened_at: string;
  current_ts: string;
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
  unknowns: Unknown[];
  contradictions: Contradiction[];
  fraud_probability: number | null;
  assessed_pattern: PatternId | null;
  decision_state: DecisionState;
  steps: Step[];
  candidate_investigations: CandidateInvestigation[];
  selected_investigation: SelectedInvestigation | null;
  recommendation: Recommendation | null;
  nba_initial: NbaRecord | null;
  nba_final: NbaRecord | null;
  sar: import('../policy/sar.js').SarDecision | null;
  hypothesis_updates: HypothesisUpdate[];
  authorization: Authorization | null;
  executed_actions: ExecutedAction[];
  budget: Budget;
  stop_reason: string | null;
}

export type PatternId = (typeof import('../policy/policy.js').PATTERNS)[number];
export type InvestigationStatus = 'open' | 'investigating' | 'sufficient' | 'stopped_insufficient' | 'closed';
export type DecisionState = 'insufficient' | 'sufficient' | 'uncertain';

export interface Trigger {
  type: 'risk_score' | 'customer_report' | 'analyst' | 'case_pack';
  transaction_id: string;
  card_id: string;
  customer_id: string;
  risk_score: number | null;
  amount_usd: number;
  ts: string;
  description: string;
}

export interface Hypothesis {
  id: string;
  claim: string;
  kind: 'fraud_explanation' | 'legitimate_explanation' | 'unknown';
  pattern?: PatternId;
  supporting: EvidenceReference[];
  contradicting: EvidenceReference[];
  confidence: number;
  falsifiers: string[];
  status: 'active' | 'supported' | 'contradicted' | 'resolved' | 'weakened' | 'rejected' | 'unresolved';
}

/** One evidence round's effect on one hypothesis (Phase 8 audit item). */
export interface HypothesisUpdate {
  hypothesis_id: string;
  confidence_before: number;
  evidence_ids: string[];
  impact: string;
  confidence_after: number;
  status: Hypothesis['status'];
  at: string;
}

/** Next-best-action record: one before evidence (initial), one after (final). */
export interface NbaRecord {
  phase: 'initial' | 'final';
  selected_action: string;
  reason: string;
  expected_impact: string;
  hypotheses_affected: string[];
  approval_route: string;
  evidence_used: string[];
  citing_rules: string[];
  actions: { action: string; route: string; reason: string }[];
  fraud_probability: number | null;
  timestamp: string;
}

export interface EvidenceItem {
  id: string;
  case_id: string;
  claim: string;
  kind: 'direct' | 'graph_derived' | 'llm_interpretation';
  source: 'graph' | 'document' | 'customer' | 'external';
  ref: string;
  entity_ids: string[];
  hypothesis_id: string | null;
  stance: 'supports' | 'contradicts' | 'neutral';
  created_at: string;
  data?: Record<string, unknown>;
}

export interface EvidenceReference {
  evidence_id: string;
  stance: 'supports' | 'contradicts';
}

export interface Unknown {
  id: string;
  question: string;
  why_it_matters: string;
  related_hypothesis_ids: string[];
  status: 'open' | 'addressed' | 'unaddressable';
  evidence_that_would_resolve: string;
}

export interface Contradiction {
  id: string;
  description: string;
  evidence_a: string[];
  evidence_b: string[];
  severity: 'low' | 'medium' | 'high';
  resolution: 'unresolved' | 'resolved' | 'carried_into_decision';
}

export interface Budget {
  max_steps: number;
  steps_taken: number;
  max_evidence_items: number;
  evidence_items: number;
  max_tools_per_step: number;
}

export interface Step {
  step_number: number;
  type: string;
  description: string;
  timestamp: string;
  details: string;
}

export interface CandidateInvestigation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  question: string;
  hypothesis_ids: string[];
  expected_impact: ImpactAssessment;
  cost: 'low' | 'medium' | 'high';
  priority: number;
}

export interface ImpactAssessment {
  could_change_decision: boolean;
  how: string;
  scenarios: { if_positive: string; if_negative: string; };
}

export interface SelectedInvestigation {
  candidate_id: string;
  reason: string;
  step_number: number;
}

export interface Recommendation {
  action: string;
  route: string;
  reason: string;
  citing_rules: string[];
  phase: 'initial' | 'final';
  /** SAR propagation (audit item 14): carried from sarFilingHolds through to every host. */
  file_report?: boolean;
  report_filed?: boolean;
  timestamp: string;
}

export interface Authorization {
  action: string;
  route: string;
  status: 'recommended' | 'authorized' | 'requires_human' | 'rejected';
  authorized_by: string | null;
  timestamp: string;
  reason: string;
}

export interface ExecutedAction {
  action: string;
  status: 'executed' | 'rejected' | 'pending';
  timestamp: string;
  reason: string;
}

export interface StopCheckResult {
  stop: boolean;
  reason: string;
  decision_state: DecisionState;
  sufficient_evidence: boolean;
  unresolved_uncertainty: boolean;
  budget_exhausted: boolean;
  contradictions_resolved: boolean;
}

export interface PolicyDecisionInput {
  fraud_probability: number;
  fraud_confirmed_or_strong: boolean;
  exposure_usd: number;
  shared_element_link: boolean;
  coordinated_or_undocumented: boolean;
  evidence_requested: boolean;
  disputed: boolean;
  pattern_id: PatternId | null;
  customer_confirms: boolean | null;
  customer_denies: boolean | null;
  no_reply: boolean | null;
  card_testing_pattern: boolean;
}

export interface PolicyDecision {
  action: string;
  route: string;
  reason: string;
  citing_rules: string[];
  create_case: boolean;
  file_report: boolean;
  report_filed: boolean;
  pattern: PatternId | null;
}

export type PolicyAction = 'ALLOW_TRANSACTION' | 'DECLINE_TRANSACTION' | 'MONITOR_CARD' | 'MONITOR_CONNECTED_CARDS' | 'WARN_CUSTOMER' | 'VERIFY_WITH_CUSTOMER' | 'STEP_UP_AUTH' | 'BLOCK_CARD' | 'BLOCK_ALL_CARDS' | 'GENERATE_REPORT' | 'CREATE_CASE' | 'FILE_REPORT' | 'ESCALATE_TO_ANALYST' | 'CLOSE_NO_FRAUD';
export type ApprovalRoute = 'auto' | 'L1' | 'L2';
