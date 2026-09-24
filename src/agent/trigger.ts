/** @module agent/trigger — Trigger construction shared by CLI, API, MCP and agent.

 * A trigger is whatever starts an investigation: a risk-score alert, a customer report,
 * an analyst request, or a row from the supplied case pack. All four hosts (CLI, REST
 * API, MCP tool call, agent library) funnel through this module so the same input always
 * produces the same trigger.

 * Environment defaults live here too, so no host reads process.env for trigger fields.
 */

import type { Trigger } from '../core/types.js';

export const TRIGGER_TYPES: Trigger['type'][] = ['risk_score', 'customer_report', 'analyst', 'case_pack'];

export function normaliseTriggerType(value: unknown, fallback: Trigger['type'] = 'analyst'): Trigger['type'] {
  const v = String(value ?? '').toLowerCase();
  return (TRIGGER_TYPES as string[]).includes(v) ? (v as Trigger['type']) : fallback;
}

/** Build a trigger from a loosely-typed bag of fields (CLI args, JSON body, MCP args). */
export function buildTrigger(input: Record<string, unknown>): Trigger {
  const raw = input ?? {};
  const txn = raw.transaction_id ?? raw.txn_id ?? raw.txn ?? raw.transaction;
  const card = raw.card_id ?? raw.card;
  const customer = raw.customer_id ?? raw.customer ?? raw.cust_id ?? raw.cust;
  if (!txn) throw new Error('Missing transaction id (transaction_id / txn_id / txn)');
  if (!card) throw new Error('Missing card id (card_id / card)');
  if (!customer) throw new Error('Missing customer id (customer_id / customer)');

  const riskRaw = raw.risk_score ?? raw.risk ?? raw.score;
  const amountRaw = raw.amount_usd ?? raw.amount ?? raw.amt;

  return {
    type: normaliseTriggerType(raw.trigger_type ?? raw.type, riskRaw != null ? 'risk_score' : 'analyst'),
    transaction_id: String(txn),
    card_id: String(card),
    customer_id: String(customer),
    risk_score: riskRaw != null && riskRaw !== '' ? Number(riskRaw) : null,
    amount_usd: amountRaw != null && amountRaw !== '' ? Number(amountRaw) : 0,
    ts: String(raw.ts ?? raw.timestamp ?? new Date().toISOString()),
    description: String(raw.description ?? raw.desc ?? `Investigation for ${txn}`),
  };
}

/** Validate without throwing; returns the reason the input is unusable, or null. */
export function triggerProblem(input: Record<string, unknown>): string | null {
  try { buildTrigger(input); return null; } catch (e: any) { return e?.message ?? String(e); }
}

/** A stable, human-readable case id derived from the trigger. */
export function caseIdFor(trigger: Trigger, now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CASE-${stamp}-${trigger.card_id}-${rand}`;
}
