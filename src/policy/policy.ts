/**
 * Fraud policy v1.0 — verbatim from data/raw/HHGOA_IEEE/README.md § Fraud Policy.
 *
 * This module encodes ONLY what the README states. No thresholds are invented:
 * action identifiers, approval routes and rules R1..R10 are carried verbatim so
 * case files can cite the rule number (README §7 Explaining).
 */

export const POLICY_VERSION = '1.0';

export const ACTIONS = [
  'ALLOW_TRANSACTION',
  'DECLINE_TRANSACTION',
  'MONITOR_CARD',
  'MONITOR_CONNECTED_CARDS',
  'WARN_CUSTOMER',
  'VERIFY_WITH_CUSTOMER',
  'STEP_UP_AUTH',
  'BLOCK_CARD',
  'BLOCK_ALL_CARDS',
  'GENERATE_REPORT',
  'CREATE_CASE',
  'FILE_REPORT',
  'ESCALATE_TO_ANALYST',
  'CLOSE_NO_FRAUD',
] as const;
export type PolicyAction = (typeof ACTIONS)[number];

export type ApprovalRoute = 'auto' | 'L1' | 'L2';

const AUTO_ACTIONS: PolicyAction[] = [
  'ALLOW_TRANSACTION', 'MONITOR_CARD', 'MONITOR_CONNECTED_CARDS', 'WARN_CUSTOMER',
  'VERIFY_WITH_CUSTOMER', 'STEP_UP_AUTH', 'GENERATE_REPORT', 'CREATE_CASE',
  'ESCALATE_TO_ANALYST', 'CLOSE_NO_FRAUD',
];

/**
 * Approval routing per README §2. BLOCK_CARD route depends on exposure.
 * Returns the route for an action given the case exposure.
 */
export function approvalRoute(action: PolicyAction, exposureUsd = 0): ApprovalRoute {
  if (AUTO_ACTIONS.includes(action)) return 'auto';
  if (action === 'DECLINE_TRANSACTION') return 'L1';
  if (action === 'BLOCK_CARD') return exposureUsd > 2500 ? 'L2' : 'L1';
  if (action === 'BLOCK_ALL_CARDS') return 'L2';
  if (action === 'FILE_REPORT') return 'L2';
  return 'L1';
}

export interface RuleRef { id: string; text: string; }

/** Rules R1..R10 paraphrased tightly from the README; full text lives in corpus/policy.md. */
export const RULES: RuleRef[] = [
  { id: 'R1', text: 'Verify before you block on a weak signal: single signal and fraud probability below 0.70 -> VERIFY_WITH_CUSTOMER or STEP_UP_AUTH before any block.' },
  { id: 'R2', text: 'Customer denies the transaction -> BLOCK_CARD and CREATE_CASE. Add FILE_REPORT if exposure exceeds $1,000 or the case connects to a shared device profile or another card fraud.' },
  { id: 'R3', text: 'Customer confirms the transaction -> CLOSE_NO_FRAUD, noting the confirmation.' },
  { id: 'R4', text: 'No reply within 24 hours -> MONITOR_CARD and DECLINE_TRANSACTION for pending authorizations. Escalate if exposure exceeds $500.' },
  { id: 'R5', text: 'Card testing: 3+ small online authorizations on one card within an hour followed by a larger purchase -> DECLINE_TRANSACTION and STEP_UP_AUTH. If a purchase over $100 already cleared -> BLOCK_CARD.' },
  { id: 'R6', text: 'Shared origin: several cards show fraud from the same device profile, billing region or recipient email in one window -> name the shared element, CREATE_CASE + FILE_REPORT, MONITOR_CONNECTED_CARDS for every card sharing it.' },
  { id: 'R7', text: 'Disputed but legitimate: customer disputes a charge matching their own recurring pattern -> CREATE_CASE, VERIFY_WITH_CUSTOMER, WARN_CUSTOMER. Do not block.' },
  { id: 'R8', text: 'Escalate when uncertain and exposed: verdict uncertain and exposure > $500, or evidence conflicts -> ESCALATE_TO_ANALYST.' },
  { id: 'R9', text: 'Undocumented patterns: activity fits none of the known patterns but shows coordinated/repeated abuse across customers -> CREATE_CASE, FILE_REPORT, ESCALATE_TO_ANALYST, describe the pattern in own words.' },
  { id: 'R10', text: 'Never BLOCK_ALL_CARDS unless at least two of the customer cards show confirmed fraud or credentials are confirmed compromised.' },
];

export const PATTERNS = [
  'card_testing',
  'card_not_present_fraud',
  'card_not_present_new_device',
  'out_of_region_use',
  'account_takeover',
  'undocumented',
  'none',
] as const;
export type PatternId = (typeof PATTERNS)[number];

/** SAR filing condition (README §3a): confirmed/strongly-suspected fraud AND one of the holds. */
export function sarFilingHolds(args: {
  fraudConfirmedOrStrong: boolean;
  exposureUsd: number;
  sharedElementLink: boolean;
  coordinatedOrUndocumented: boolean;
}): { file: boolean; holds: string[] } {
  const holds: string[] = [];
  if (args.exposureUsd > 1000) holds.push('exposure exceeds $1,000');
  if (args.sharedElementLink) holds.push('connects to a shared device profile, shared region cluster, or another customer fraud');
  if (args.coordinatedOrUndocumented) holds.push('pattern is coordinated or undocumented (R9)');
  return { file: args.fraudConfirmedOrStrong && holds.length > 0, holds };
}

/** A case is opened when probability >= 0.30, on any evidence request, or on a dispute. */
export function shouldCreateCase(args: { fraudProbability: number; evidenceRequested: boolean; disputed: boolean }): boolean {
  return args.fraudProbability >= 0.30 || args.evidenceRequested || args.disputed;
}
