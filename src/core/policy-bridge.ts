/** @module core — Policy bridge between investigation state and policy engine */

import { PolicyDecisionInput, PolicyDecision, PatternId, PolicyAction, ApprovalRoute } from './types.js';
import { approvalRoute, sarFilingHolds, shouldCreateCase } from '../policy/policy.js';

export function evaluatePolicy(input: PolicyDecisionInput): PolicyDecision {
  const {
    fraud_probability, fraud_confirmed_or_strong, exposure_usd,
    shared_element_link, coordinated_or_undocumented, evidence_requested,
    disputed, pattern_id, customer_confirms, customer_denies, no_reply,
    card_testing_pattern,
  } = input;

  const citing_rules: string[] = [];
  let action: 'ALLOW_TRANSACTION' | 'DECLINE_TRANSACTION' | 'MONITOR_CARD' | 'MONITOR_CONNECTED_CARDS' | 'WARN_CUSTOMER' | 'VERIFY_WITH_CUSTOMER' | 'STEP_UP_AUTH' | 'BLOCK_CARD' | 'BLOCK_ALL_CARDS' | 'GENERATE_REPORT' | 'CREATE_CASE' | 'FILE_REPORT' | 'ESCALATE_TO_ANALYST' | 'CLOSE_NO_FRAUD' = 'ALLOW_TRANSACTION';
  let reason = '';
  let route: 'auto' | 'L1' | 'L2' = 'auto';

  if (customer_confirms) {
    action = 'CLOSE_NO_FRAUD';
    citing_rules.push('R3');
    reason = 'Customer confirmed the transaction — close as no fraud (R3)';
    route = approvalRoute(action, exposure_usd);
    return { action, route, reason, citing_rules,
      create_case: shouldCreateCase({ fraudProbability: fraud_probability, evidenceRequested: evidence_requested, disputed }),
      file_report: false, report_filed: false, pattern: pattern_id };
  }

  if (customer_denies) {
    action = 'BLOCK_CARD';
    citing_rules.push('R2');
    reason = 'Customer denied the transaction — block card and create case (R2)';
    route = approvalRoute(action, exposure_usd);
    const sar = sarFilingHolds({ fraudConfirmedOrStrong: fraud_confirmed_or_strong, exposureUsd: exposure_usd, sharedElementLink: shared_element_link, coordinatedOrUndocumented: coordinated_or_undocumented });
    return { action, route, reason, citing_rules, create_case: true, file_report: sar.file, report_filed: sar.file, pattern: pattern_id };
  }

  if (no_reply) {
    action = exposure_usd > 500 ? 'ESCALATE_TO_ANALYST' : 'MONITOR_CARD';
    citing_rules.push('R4');
    reason = 'No customer reply within 24 hours — monitor and decline pending authorizations (R4)';
    if (exposure_usd > 500) citing_rules.push('R4 (escalation threshold)');
    route = approvalRoute(action, exposure_usd);
    return { action, route, reason, citing_rules,
      create_case: shouldCreateCase({ fraudProbability: fraud_probability, evidenceRequested: evidence_requested, disputed }),
      file_report: false, report_filed: false, pattern: pattern_id };
  }

  if (card_testing_pattern) {
    action = 'DECLINE_TRANSACTION';
    citing_rules.push('R5');
    reason = 'Card testing pattern detected — decline transaction and step-up auth (R5)';
    if (fraud_confirmed_or_strong) {
      action = 'BLOCK_CARD';
      citing_rules.push('R5 (purchase over $100 already cleared)');
      reason += '; blocked because a purchase over $100 cleared';
    }
    route = approvalRoute(action, exposure_usd);
    return { action, route, reason, citing_rules, create_case: true, file_report: false, report_filed: false, pattern: 'card_testing' as PatternId };
  }

  if (shared_element_link && fraud_confirmed_or_strong) {
    action = 'CREATE_CASE';
    citing_rules.push('R6');
    reason = 'Shared origin detected — create case, file report, monitor connected cards (R6)';
    route = approvalRoute(action, exposure_usd);
    const sar = sarFilingHolds({ fraudConfirmedOrStrong: fraud_confirmed_or_strong, exposureUsd: exposure_usd, sharedElementLink: shared_element_link, coordinatedOrUndocumented: coordinated_or_undocumented });
    return { action, route, reason, citing_rules, create_case: true, file_report: sar.file, report_filed: sar.file, pattern: pattern_id };
  }

  if (disputed && fraud_probability < 0.50) {
    action = 'CREATE_CASE';
    citing_rules.push('R7');
    reason = 'Customer disputes a charge matching their own pattern — create case, verify, warn (R7)';
    route = approvalRoute(action, exposure_usd);
    return { action, route, reason, citing_rules, create_case: true, file_report: false, report_filed: false, pattern: pattern_id };
  }

  if ((fraud_probability >= 0.30 && fraud_probability < 0.70) && exposure_usd > 500) {
    action = 'ESCALATE_TO_ANALYST';
    citing_rules.push('R8');
    reason = 'Uncertain verdict with exposure over $500 — escalate to analyst (R8)';
    route = approvalRoute(action, exposure_usd);
    return { action, route, reason, citing_rules,
      create_case: shouldCreateCase({ fraudProbability: fraud_probability, evidenceRequested: evidence_requested, disputed }),
      file_report: false, report_filed: false, pattern: pattern_id };
  }

  if (pattern_id === 'undocumented' || (pattern_id === 'none' && fraud_confirmed_or_strong)) {
    action = 'CREATE_CASE';
    citing_rules.push('R9');
    reason = 'Activity fits no documented pattern but shows coordinated/repeated abuse — create case, file report, escalate (R9)';
    route = approvalRoute(action, exposure_usd);
    const sar = sarFilingHolds({ fraudConfirmedOrStrong: fraud_confirmed_or_strong, exposureUsd: exposure_usd, sharedElementLink: shared_element_link, coordinatedOrUndocumented: coordinated_or_undocumented });
    return { action, route, reason, citing_rules, create_case: true, file_report: sar.file, report_filed: sar.file, pattern: 'undocumented' as PatternId };
  }

  if (fraud_probability >= 0.30) {
    action = 'MONITOR_CARD';
    citing_rules.push('R1');
    reason = `Fraud probability ${fraud_probability.toFixed(2)} — monitor card pending further evidence (R1)`;
    route = approvalRoute(action, exposure_usd);
  }

  return { action, route, reason, citing_rules,
    create_case: shouldCreateCase({ fraudProbability: fraud_probability, evidenceRequested: evidence_requested, disputed }),
    file_report: false, report_filed: false, pattern: pattern_id };
}
