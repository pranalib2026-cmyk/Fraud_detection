/**
 * Canonical schema mapping: source dataset -> internal model.
 *
 * Every rule here is either stated in the supplied README or derived from the data
 * and validated against labelled evidence. See docs/dataset-schema.md and
 * docs/assumptions.md for the evidence behind each rule.
 */

/** Fixed column positions used for the hot path over transactions.csv (0-based). */
export const TXN_COL = {
  TransactionID: 0,
  TransactionDT: 1,
  TransactionAmt: 2,
  ProductCD: 3,
  card1: 4,
  card2: 5,
  card3: 6,
  card4: 7,
  card5: 8,
  card6: 9,
  addr1: 10,
  addr2: 11,
};

export const TXN_TAIL = ['customer_id', 'ts', 'channel', 'risk_score'];

/**
 * Card key derived from the data: (card1, card6). Validated with 0 collisions over
 * all 14,975 labelled (card_id, transaction) pairs covering 1,917 cards.
 */
export function cardKey(card1, card6) {
  return `${card1 ?? ''}|${card6 ?? ''}`;
}

export function parseCardKey(key) {
  const [card1, card6] = key.split('|');
  return { card1, card6 };
}

/**
 * K-index rank for a card, given the customer's observed card6 values.
 * Evidence: ordering by card6 ascending reproduces 21/21 labelled multi-card customers.
 */
export function derivedKIndex(card6, siblingCard6Values) {
  const distinct = [...new Set(siblingCard6Values.map((v) => v ?? ''))].sort();
  return distinct.indexOf(card6 ?? '') + 1;
}

/** Device profile identity per the README: DeviceInfo + OS + browser + screen. */
export function deviceProfileId({ deviceInfo, os, browser, screen }) {
  const parts = [deviceInfo ?? '', os ?? '', browser ?? '', screen ?? ''];
  return parts.map((p) => p.trim()).join(' | ');
}

/** Billing region vertex id (addr1). */
export const regionId = (addr1) => `R${String(addr1 ?? '').trim()}`;

/** Email domain vertex id. */
export const emailDomainId = (domain) => `E${String(domain ?? '').trim().toLowerCase()}`;

/** Case vertex id written by the agent for its own investigations. */
export const graphCaseId = (caseId) => `CASE-${caseId}`;

/** Timestamp parsing for the dataset's `ts` column (UTC-naive, treated as UTC). */
export function parseTs(ts) {
  return Date.parse(`${ts.replace(' ', 'T')}Z`);
}

export function toDateString(ts) {
  return ts.slice(0, 10);
}

export function addHours(ts, hours) {
  return new Date(parseTs(ts) + hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Canonical internal representation of one transaction. */
export function toCanonicalTxn(row) {
  return {
    txn_id: String(row.TransactionID),
    ts: row.ts,
    amount_usd: Number(row.TransactionAmt) || 0,
    product_cd: row.ProductCD,
    channel: row.channel,
    risk_score: row.risk_score === '' || row.risk_score === undefined ? null : Number(row.risk_score),
    customer_id: row.customer_id,
    card_key: cardKey(row.card1, row.card6),
    card1: row.card1,
    card4: row.card4,
    card6: row.card6,
    region: row.addr1,
    country: row.addr2,
    email_domain: row.P_emaildomain,
    recipient_email_domain: row.R_emaildomain,
    transaction_dt: row.TransactionDT,
  };
}
