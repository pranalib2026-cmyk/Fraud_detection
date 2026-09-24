/** @module core — Deterministic pattern inference from gathered graph evidence.
 *
 * Every rule below restates a definition from `data/raw/HHGOA_IEEE/README.md`
 * § Known Fraud Patterns, or reads the output of the graph backend's card-testing
 * detector (policy R5). No threshold is invented here:
 *
 *   card_testing               — `card_testing_scan` returned one or more sequences
 *                                (README: "Confirmed by the sequence itself").
 *   card_not_present_new_device — flagged txn online and the identity record marks the
 *                                device `New` for this account (README pattern 3).
 *   out_of_region_use          — flagged txn card-present in a region the card has no
 *                                prior history in while prior activity exists in other
 *                                regions (README pattern 4: "normal activity continues
 *                                at home").
 *   card_not_present_fraud     — flagged txn online (not new-device) inside a burst of
 *                                two or more online txns on the same card within 48h
 *                                (README pattern 2: "a burst of two to four within 48
 *                                hours"; a single unusual online purchase alone is
 *                                ambiguous → stays null, never labelled).
 *   undocumented (R9)          — a shared device/region/email links this case to
 *                                confirmed-fraud closed cases (R6 "several cards show
 *                                fraud" → at least two) while no documented pattern
 *                                above matched.
 *   none                       — every detector actually ran (scan clean, at least one
 *                                prior txn of history to compare against) and nothing
 *                                matched.
 *
 * `account_takeover` is deliberately never asserted: the README describes it with
 * match-flag anomalies this projection does not carry, and guessing would fabricate
 * evidence. When the detectors have not run yet the function returns null — the
 * evaluator counts null as "not assessed", never as a mismatch.
 */
import type { InvestigationState, PatternId } from './types.js';
import { findFlaggedTxn, findSeenTxns, parseTimestamp } from './evidence-helpers.js';

const DAY_MS = 24 * 3600_000;
/** R6 wording: "several cards show fraud from the same …" — several read as at least two. */
const SEVERAL_CONFIRMED = 2;

/** Infer the documented pattern the gathered evidence supports, or null when not assessable. */
export function inferPattern(state: InvestigationState): PatternId | null {
  const scan = state.evidence.find((e) => e.ref?.includes('card_testing_scan'));
  const sequences: any[] = Array.isArray((scan as any)?.data?.sequences) ? (scan as any).data.sequences : [];
  if (sequences.length > 0) return 'card_testing';

  const txn = findFlaggedTxn(state);
  if (!txn) return null;
  const ownTxns = findSeenTxns(state).filter((t) => String(t.card_id) === String(txn.card_id));

  if (txn.channel === 'online') {
    if (txn.device_new_or_found === 'New') return 'card_not_present_new_device';
    const at = parseTimestamp(txn.ts);
    if (at !== null) {
      const burst = ownTxns.filter((t) => {
        if (t.channel !== 'online') return false;
        const ts = parseTimestamp(t.ts);
        return ts !== null && Math.abs(ts - at) <= 2 * DAY_MS;
      });
      if (burst.length >= 2) return 'card_not_present_fraud';
    }
    // A single unusual online purchase is ambiguous by the README's own words.
    return null;
  }

  if (txn.channel === 'in_person') {
    const others = ownTxns.filter((t) => String(t.txn_id) !== String(txn.txn_id));
    const priorInRegion = others.filter((t) => t.region === txn.region).length;
    const priorElsewhere = others.filter((t) => t.region !== txn.region).length;
    if (priorInRegion === 0 && priorElsewhere >= 1) return 'out_of_region_use';
    // Otherwise: a known region, or no history to compare against — fall through.
  }

  if (coordinatedConfirmedFraud(state)) return 'undocumented';

  // `none` only when the detectors had the data to actually run: a clean scan and at
  // least one prior transaction of history to compare the flagged txn against.
  const scanRan = Boolean(scan) && sequences.length === 0;
  const history = state.evidence.find((e) => e.ref?.includes('card_history'));
  const historyTxns = ((history as any)?.data?.txns ?? []) as any[];
  const historyRan = historyTxns.length >= 1;
  if (scanRan && historyRan) return 'none';

  return null;
}

/**
 * R9: no documented pattern matched, but a shared element links this case to at least
 * two confirmed-fraud closed cases — coordinated abuse across cards/customers.
 */
function coordinatedConfirmedFraud(state: InvestigationState): boolean {
  const shared = state.evidence.some((e) => {
    const d = e.data as any;
    return d && (d.kind === 'device' || d.kind === 'region' || d.kind === 'email')
      && Array.isArray(d.cards) && d.cards.length > 0;
  });
  if (!shared) return false;

  let confirmed = 0;
  for (const e of state.evidence) {
    const d = e.data as any;
    if (!d) continue;
    if (Array.isArray(d.closed_cases_on_these_cards)) {
      confirmed += d.closed_cases_on_these_cards.filter((c: unknown) => String(c).includes(':confirmed_fraud/')).length;
    }
    if (Array.isArray(d.closed_case_context)) {
      confirmed += d.closed_case_context.filter((c: any) => c?.outcome === 'confirmed_fraud').length;
    }
  }
  return confirmed >= SEVERAL_CONFIRMED;
}