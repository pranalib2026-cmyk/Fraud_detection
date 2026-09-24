/** @module cli/io — Shared CLI input/output helpers.

 * Argument parsing, trigger building, trigger-file reading and result rendering live here
 * so `investigate`, `benchmark` and `demo` behave identically for the same flags.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { buildTrigger } from '../agent/trigger.js';
import type { Trigger } from '../core/types.js';

/** Parse `--flag value` / `--flag` / `--no-flag` pairs into a plain object. */
export function parseArgs(argv: string[], from = 2): Record<string, any> {
  const args: Record<string, any> = {};
  for (let i = from; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

export function triggerFromArgs(args: Record<string, any>): Trigger {
  return buildTrigger({
    transaction_id: args.txn ?? args.txn_id ?? args.transaction_id,
    card_id: args.card ?? args.card_id,
    customer_id: args.customer ?? args.customer_id ?? args.cust,
    amount_usd: args.amount ?? args.amount_usd,
    risk_score: args.risk ?? args.risk_score ?? args.score,
    ts: args.ts ?? args.timestamp,
    trigger_type: args.trigger_type ?? args.type,
    description: args.desc ?? args.description,
  });
}

export function intentOf(args: Record<string, any>): { maxSteps?: number; maxEvidence?: number } {
  return {
    maxSteps: args.max_steps !== undefined ? Number(args.max_steps) : undefined,
    maxEvidence: args.max_evidence !== undefined ? Number(args.max_evidence) : undefined,
  };
}

/** Minimal RFC-4180 CSV reader (handles quoted fields and embedded commas). */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines: string[] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); lines.push(row.join('\u0000')); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); lines.push(row.join('\u0000')); }
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (!nonEmpty.length) return { header: [], rows: [] };
  const header = nonEmpty[0].split('\u0000').map((h) => h.trim().toLowerCase());
  return { header, rows: nonEmpty.slice(1).map((l) => l.split('\u0000')) };
}

/** Read a CSV of triggers and coerce each row into a trigger (or null when unusable). */
export function triggersFromCsv(file: string): Trigger[] {
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  const at = (row: string[], ...names: string[]): string | undefined => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0 && row[i] !== undefined && row[i] !== '') return row[i]; }
    return undefined;
  };
  const out: Trigger[] = [];
  for (const row of rows) {
    try {
      // The official case pack uses flagged_txn_id / opened_at / trigger_text — never
      // assume transaction_id/ts. Amount may only appear in the trigger text ("$77.07").
      const triggerTypeRaw = at(row, 'trigger_type', 'type');
      const triggerType = triggerTypeRaw === 'analyst_request' ? 'analyst' : triggerTypeRaw;
      const triggerText = at(row, 'trigger_text', 'description', 'desc');
      const amountRaw = at(row, 'amount_usd', 'amount', 'amt');
      const amountMatch = triggerText ? triggerText.replace(/,/g, '').match(/\$\s*([0-9]+(?:\.[0-9]+)?)/) : null;
      out.push(buildTrigger({
        transaction_id: at(row, 'transaction_id', 'txn_id', 'txn', 'transaction', 'flagged_txn_id'),
        card_id: at(row, 'card_id', 'card', 'cardid'),
        customer_id: at(row, 'customer_id', 'customer', 'cust_id', 'cust'),
        amount_usd: amountRaw ?? (amountMatch ? amountMatch[1] : undefined),
        risk_score: at(row, 'risk_score', 'score'),
        ts: at(row, 'ts', 'timestamp', 'datetime', 'date', 'opened_at', 'alert_ts'),
        trigger_type: triggerType,
        description: triggerText ?? at(row, 'description', 'desc'),
      }));
    } catch { /* skip rows that cannot form a trigger */ }
  }
  return out;
}

/** Read a JSONL file of trigger objects; one per line, blank lines skipped. */
export async function triggersFromJsonl(file: string): Promise<Trigger[]> {
  const out: Trigger[] = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    try { out.push(buildTrigger(JSON.parse(text))); } catch { /* skip malformed lines */ }
  }
  return out;
}

/** Append one JSON object per line, creating parent directories as needed. */
export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Emit progress / diagnostics on stderr so stdout stays machine-readable. */
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}
