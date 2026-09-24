/** @module llm/actions — Policy action mapping (event-driven rules).

 * Maps a reasoning result plus the facts known about a case onto the action set from
 * `src/policy/policy.ts`. Each suggestion cites the rule id(s) it derives from, so case
 * files can be audited against the policy README. Actions the policy routes to a human
 * are still returned — the approval route records who must sign off.
 *
 * This module covers the rules triggered by a known event (customer replied / did not
 * reply, card-testing sequence). The probability- and pattern-driven rules live in
 * `actions-signal.ts`; `deterministicActions` dispatches between them.
 */

import { sarFilingHolds, approvalRoute } from '../policy/policy.js';
import type { PolicyAction } from '../policy/policy.js';
import type { ActionSuggestion, EventContext, ReasoningResult } from './types.js';
import { signalActions } from './actions-signal.js';

export const A = (action: PolicyAction, route: string, reason: string, citing_rules: string[]): ActionSuggestion =>
  ({ action, route, reason, citing_rules });

/** Map a reasoning result plus case facts onto policy actions, citing rule ids. */
export function deterministicActions(reasoning: ReasoningResult, event: EventContext): ActionSuggestion[] {
  const prob = reasoning.fraud_probability;
  const out: ActionSuggestion[] = [];
  const sar = (co: boolean) => sarFilingHolds({
    fraudConfirmedOrStrong: event.fraud_confirmed_or_strong,
    exposureUsd: event.exposure_usd,
    sharedElementLink: event.shared_element_link,
    coordinatedOrUndocumented: co,
  });

  // R3 — customer confirmed the transaction.
  if (event.customer_confirms) {
    out.push(A('CLOSE_NO_FRAUD', 'auto', 'Customer confirmed the transaction — close as no fraud (R3)', ['R3']));
    return out;
  }

  // R2 — customer denies the transaction.
  if (event.customer_denies) {
    out.push(A('BLOCK_CARD', approvalRoute('BLOCK_CARD', event.exposure_usd), 'Customer denied the transaction — block the card (R2)', ['R2']));
    out.push(A('CREATE_CASE', 'auto', 'Open an internal case for the denied transaction (R2)', ['R2']));
    const s = sar(event.coordinated_or_undocumented);
    if (s.file) {
      out.push(A('FILE_REPORT', approvalRoute('FILE_REPORT', event.exposure_usd), `File a SAR — denied fraud with: ${s.holds.join('; ')} (R2)`, ['R2']));
    }
    if (event.shared_element_link) {
      out.push(A('MONITOR_CONNECTED_CARDS', 'auto', 'Monitor the other cards sharing the linked element (R6)', ['R6']));
    }
    return out;
  }

  // R4 — no reply within 24 hours.
  if (event.no_reply) {
    if (event.exposure_usd > 500) {
      out.push(A('ESCALATE_TO_ANALYST', 'auto', 'No reply within 24h and exposure exceeds $500 — escalate (R4)', ['R4']));
    } else {
      out.push(A('MONITOR_CARD', 'auto', 'No reply within 24h — monitor and decline pending authorizations (R4)', ['R4']));
      if (event.exposure_usd > 0) {
        out.push(A('DECLINE_TRANSACTION', approvalRoute('DECLINE_TRANSACTION'), 'Decline pending authorizations while awaiting a reply (R4)', ['R4']));
      }
    }
    return out;
  }

  // R5 — card-testing sequence (3+ small online authorizations, then a larger purchase).
  if (event.card_testing_pattern) {
    if (event.fraud_confirmed_or_strong) {
      out.push(A('BLOCK_CARD', approvalRoute('BLOCK_CARD', event.exposure_usd), 'Card-testing sequence with a purchase already cleared — block the card (R5)', ['R5']));
    } else {
      out.push(A('DECLINE_TRANSACTION', approvalRoute('DECLINE_TRANSACTION'), 'Card-testing pattern observed — decline and step up authentication (R5)', ['R5']));
      out.push(A('STEP_UP_AUTH', 'auto', 'Require step-up authentication before further activity (R5)', ['R5']));
    }
    out.push(A('CREATE_CASE', 'auto', 'Open a case for the card-testing pattern (R2/R5)', ['R2', 'R5']));
    return out;
  }

  return signalActions(reasoning, event, prob);
}
