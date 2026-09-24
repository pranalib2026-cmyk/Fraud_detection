/** @module evaluator/labels — Ground-truth extraction from the supplied case pack.

 * The evaluator only compares against labels the dataset actually contains. Where it does
 * not, the run is counted as unlabeled rather than silently scored as correct — that keeps
 * the reported metrics honest about how much of the benchmark they cover.
 *
 * The case pack supplies the trigger (transaction / card / customer) together with the
 * recorded outcome. The evaluator maps the outcome field onto a boolean.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { parseCsv } from '../cli/io.js';
import type { LabeledOutcome } from './metrics.js';

/** Outcomes the dataset uses that mean "this was fraud". */
const FRAUD_OUTCOMES = ['confirmed_fraud', 'fraud', 'confirmed', 'true_positive', 'fraud_confirmed', 'suspicious_confirmed'];
/** Outcomes that mean "this was not fraud". */
const LEGIT_OUTCOMES = ['no_fraud', 'legitimate', 'false_positive', 'not_fraud', 'closed_no_fraud', 'benign'];

export function outcomeToBoolean(raw: unknown): boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (FRAUD_OUTCOMES.includes(v)) return true;
  if (LEGIT_OUTCOMES.includes(v)) return false;
  // Free-text outcomes: fall back to keyword detection so novel labels are still usable.
  if (v.includes('confirm') && !v.includes('no_') && !v.includes('not_')) return true;
  if (v.startsWith('no_') || v.includes('legit') || v.includes('benign')) return false;
  return null;
}

export interface CasePackRow {
  transaction_id: string;
  card_id: string;
  customer_id: string;
  amount_usd: number;
  risk_score: number | null;
  outcome: string | null;
  pattern: string | null;
  expected_fraud: boolean | null;
  case_id: string | null;
  trigger_type: string | null;
  /** When the alert opened — the pack's own timestamp, used as the trigger ts. */
  opened_at: string | null;
}

/** Locate the case pack, preferring the configured raw directory. */
export function findCasePack(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.HHGOA_CASE_PACK,
    path.join(paths.raw, 'case_pack.csv'),
    path.join(paths.data, 'raw', 'case_pack.csv'),
    path.join(paths.raw, 'hhgoa_case_pack.csv'),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

export function loadCasePack(file: string): CasePackRow[] {
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  const at = (row: string[], ...names: string[]): string | null => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0 && row[i] !== undefined && row[i] !== '') return row[i];
    }
    return null;
  };

  const out: CasePackRow[] = [];
  for (const row of rows) {
    const txn = at(row, 'transaction_id', 'flagged_txn_id', 'txn_id', 'txn', 'transaction');
    const card = at(row, 'card_id', 'card', 'cardid');
    const customer = at(row, 'customer_id', 'customer', 'cust_id', 'cust');
    if (!txn || !card || !customer) continue;
    const amountRaw = at(row, 'amount_usd', 'amount', 'amt');
    const riskRaw = at(row, 'risk_score', 'score');
    const outcome = at(row, 'outcome', 'label', 'verdict', 'result', 'expected_outcome');
    // The supplied pack has no amount column — the amount appears in the trigger text ("$77.07").
    const triggerText = at(row, 'trigger_text', 'description', 'trigger');
    const amountMatch = triggerText ? triggerText.replace(/,/g, '').match(/\$\s*([0-9]+(?:\.[0-9]+)?)/) : null;
    out.push({
      transaction_id: txn,
      card_id: card,
      customer_id: customer,
      amount_usd: amountRaw !== null ? Number(amountRaw) : amountMatch ? Number(amountMatch[1]) : 0,
      risk_score: riskRaw !== null ? Number(riskRaw) : null,
      outcome,
      pattern: at(row, 'pattern', 'pattern_id', 'expected_pattern', 'typology'),
      expected_fraud: outcomeToBoolean(outcome),
      case_id: at(row, 'case_id'),
      trigger_type: at(row, 'trigger_type'),
      opened_at: at(row, 'opened_at', 'alert_ts', 'trigger_ts'),
    });
  }
  return out;
}

/**
 * Index the labels by card id, which is how the investigation results are keyed (a case id
 * is generated per run, so it cannot join back to the dataset).
 */
export function labelIndex(rows: CasePackRow[]): Map<string, LabeledOutcome> {
  const index = new Map<string, LabeledOutcome>();
  for (const row of rows) {
    index.set(row.card_id, { expected_fraud: row.expected_fraud, expected_pattern: row.pattern });
  }
  return index;
}

/** Closed-case history is the second label source; it uses the same shape. */
export function loadClosedCaseLabels(file: string): Map<string, LabeledOutcome> {
  const index = new Map<string, LabeledOutcome>();
  if (!fs.existsSync(file)) return index;
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  const at = (row: string[], ...names: string[]): string | null => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0 && row[i] !== undefined && row[i] !== '') return row[i];
    }
    return null;
  };
  for (const row of rows) {
    const card = at(row, 'card_id', 'card');
    if (!card) continue;
    const outcome = at(row, 'outcome', 'label', 'verdict', 'result');
    index.set(card, { expected_fraud: outcomeToBoolean(outcome), expected_pattern: at(row, 'pattern', 'pattern_id') });
  }
  return index;
}
