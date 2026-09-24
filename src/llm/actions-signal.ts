/** @module llm/actions-signal — Probability- and pattern-driven policy rules.

 * The rules in this module apply when no customer event (reply / no reply) and no
 * card-testing sequence has been observed, so the decision rests on the assessed
 * pattern and the fraud probability. Rule ids R1, R6, R7, R8, R9 come from
 * `src/policy/policy.ts`.
 */

import { sarFilingHolds, approvalRoute, shouldCreateCase } from '../policy/policy.js';
import type { ActionSuggestion, EventContext, ReasoningResult } from './types.js';
import { A } from './actions.js';

export function signalActions(reasoning: ReasoningResult, event: EventContext, prob: number): ActionSuggestion[] {
  const pattern = reasoning.assessed_pattern;
  const out: ActionSuggestion[] = [];

  // R6 — shared origin across several cards.
  if (event.shared_element_link && event.fraud_confirmed_or_strong) {
    out.push(A('CREATE_CASE', 'auto', 'Shared origin detected across cards — create a case (R6)', ['R6']));
    const s = sarFilingHolds({
      fraudConfirmedOrStrong: true,
      exposureUsd: event.exposure_usd,
      sharedElementLink: true,
      coordinatedOrUndocumented: event.coordinated_or_undocumented,
    });
    if (s.file) {
      out.push(A('FILE_REPORT', approvalRoute('FILE_REPORT', event.exposure_usd), 'File a SAR for the shared-origin fraud (R6)', ['R6']));
    }
    out.push(A('MONITOR_CONNECTED_CARDS', 'auto', 'Monitor every card sharing the identified element (R6)', ['R6']));
    return out;
  }

  // R7 — disputed charge that matches the customer's own recurring pattern.
  if (event.evidence_requested && pattern === 'none' && prob < 0.50) {
    out.push(A('CREATE_CASE', 'auto', 'Customer disputes a charge — create a case (R7)', ['R7']));
    out.push(A('VERIFY_WITH_CUSTOMER', 'auto', 'Verify the disputed charge with the customer (R7)', ['R7']));
    out.push(A('WARN_CUSTOMER', 'auto', 'Warn the customer about the disputed activity (R7)', ['R7']));
    return out;
  }

  // R9 — undocumented but coordinated abuse.
  if (pattern === 'undocumented') {
    out.push(A('CREATE_CASE', 'auto', 'Undocumented pattern showing coordinated abuse — create a case (R9)', ['R9']));
    const s = sarFilingHolds({
      fraudConfirmedOrStrong: event.fraud_confirmed_or_strong,
      exposureUsd: event.exposure_usd,
      sharedElementLink: event.shared_element_link,
      coordinatedOrUndocumented: true,
    });
    if (s.file) {
      out.push(A('FILE_REPORT', approvalRoute('FILE_REPORT', event.exposure_usd), 'File a SAR for the undocumented/coordinated pattern (R9)', ['R9']));
    }
    out.push(A('ESCALATE_TO_ANALYST', 'auto', 'Undocumented pattern — escalate for analyst review (R9)', ['R9']));
    return out;
  }

  // R1 — weak signal: verify before blocking; strong signal: monitor, case, escalate.
  if (prob < 0.70) {
    if (prob >= 0.30) {
      out.push(A('VERIFY_WITH_CUSTOMER', 'auto', `Probability ${prob.toFixed(2)} on limited evidence — verify before blocking (R1)`, ['R1']));
      if (prob >= 0.50) out.push(A('MONITOR_CARD', 'auto', 'Monitor the card pending verification (R1)', ['R1']));
    } else {
      out.push(A('ALLOW_TRANSACTION', 'auto', `Probability ${prob.toFixed(2)} is below the case threshold — allow and monitor (R1)`, ['R1']));
    }
    return out;
  }

  out.push(A('MONITOR_CARD', 'auto', `Probability ${prob.toFixed(2)} — raise monitoring sensitivity (R1)`, ['R1']));
  if (shouldCreateCase({ fraudProbability: prob, evidenceRequested: event.evidence_requested, disputed: event.disputed })) {
    out.push(A('CREATE_CASE', 'auto', 'Open a case at this probability level', ['R1']));
  }
  // R8 — escalate when uncertain and exposed.
  if (event.exposure_usd > 500) {
    out.push(A('ESCALATE_TO_ANALYST', 'auto', `Exposure $${event.exposure_usd.toFixed(2)} exceeds $500 at this probability — escalate (R8)`, ['R8']));
  }
  if (out.some((a) => a.action === 'CREATE_CASE') && !out.some((a) => a.action === 'GENERATE_REPORT')) {
    out.push(A('GENERATE_REPORT', 'auto', 'Write up the investigation for the internal record', []));
  }
  return out;
}
