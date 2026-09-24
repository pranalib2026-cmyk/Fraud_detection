/**
 * Prepare slim CSVs for the TigerGraph loading jobs in `gsql/2-loading.gsql`.
 *
 * Reads the built projection (output of `npm run build-graph`) plus the shipped
 * closed-case history, and writes `data/derived/tg_load/*.csv` with named columns
 * matching the loading job's `$"column"` references.
 *
 * Usage:
 *   npm run build-graph     # once, produces projection.bin
 *   npm run prepare-tg-load
 *
 * Column names here are the contract with gsql/2-loading.gsql — change both
 * together (docs/gsql.md documents the pairing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProjection } from '../src/graph/local/load.js';
import { readCsvFile } from '../src/dataset/csv.js';
import { paths, requireRawDataset } from '../src/config.js';

const PROJ = paths.projection;
const RAW = requireRawDataset();
const OUT = path.join(paths.derived, 'tg_load');

if (!fs.existsSync(PROJ)) {
  console.error('projection.bin not found — run `npm run build-graph` first.');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const p = loadProjection(PROJ);
const PRODUCT = ['W', 'C', 'H', 'R', 'S'];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** RFC4180 field escape for named-column loading (header="true"). */
const esc = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (...vals: unknown[]) => vals.map(esc).join(',');

function writeLines(file: string, headerLine: string, rows: Iterable<string>): number {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `${headerLine}\n`);
  let n = 0;
  const chunk: string[] = [];
  for (const line of rows) {
    chunk.push(line);
    n++;
    if (chunk.length >= 50_000) {
      fs.writeSync(fd, `${chunk.join('\n')}\n`);
      chunk.length = 0;
    }
  }
  if (chunk.length) fs.writeSync(fd, `${chunk.join('\n')}\n`);
  fs.closeSync(fd);
  return n;
}

function* customers() {
  const seen = new Set<string>();
  for (const c of p.meta.cards) {
    if (!c.customer_id || seen.has(c.customer_id)) continue;
    seen.add(c.customer_id);
    yield row(c.customer_id);
  }
}

function* cards() {
  for (const c of p.meta.cards) {
    if (!c.card_id) continue;
    yield row(c.card_id, c.key, c.customer_id, (c as any).k_index ?? '', (c as any).label_source ?? '');
  }
}

function* transactions() {
  for (let i = 0; i < p.n; i++) {
    const epoch = p.ts(i);
    const card = p.card(p.cardIdx(i));
    yield row(
      String(p.txnId(i)), iso(epoch), Math.round(epoch), p.amount(i).toFixed(2),
      p.productIdx(i) === 255 ? '' : PRODUCT[p.productIdx(i)],
      p.channelIdx(i) === 1 ? 'online' : 'in_person',
      p.riskIdx(i) === 255 ? '' : (p.riskIdx(i) / 100).toFixed(2),
      card.customer_id, card.card_id,
      p.region(p.regionIdx(i)), p.country(p.countryIdx(i)),
      p.email(p.emailIdx(i)), p.email(p.recipientEmailIdx(i)),
    );
  }
}

function* devices() {
  for (const d of p.meta.devices) {
    yield row(d.device_id, d.device_type, d.os, d.browser, d.screen, d.device_new_or_found, d.proxy);
  }
}

function* txDevice() {
  for (let i = 0; i < p.n; i++) {
    const di = p.deviceIdx(i);
    if (di < 0) continue;
    yield row(String(p.txnId(i)), p.device(di).device_id);
  }
}

function* regions() {
  const seen = new Set<string>();
  for (const [idx, region] of p.meta.regions.entries()) {
    if (!region || seen.has(region)) continue;
    seen.add(region);
    // country: first non-empty addr2 observed via region index lookup is not
    // stored in the projection, so leave it to be enriched on demand. Loading
    // accepts an empty country (attribute is optional).
    void idx;
    yield row(region, '');
  }
}

function* txRegion() {
  for (let i = 0; i < p.n; i++) {
    const r = p.region(p.regionIdx(i));
    if (!r) continue;
    yield row(String(p.txnId(i)), r);
  }
}

function* emailDomains() {
  const seen = new Set<string>();
  for (const email of p.meta.emails) {
    if (!email || seen.has(email)) continue;
    seen.add(email);
    yield row(email);
  }
}

function* txEmail() {
  for (let i = 0; i < p.n; i++) {
    const e = p.email(p.emailIdx(i));
    if (!e) continue;
    yield row(String(p.txnId(i)), e);
  }
}

/** NEXT edges: consecutive transactions by ts within a card (README schema). */
function* txNext() {
  for (let ci = 0; ci < p.meta.cards.length; ci++) {
    const rows = Array.from(p.rowsOfCardIdx(ci)).sort((a, b) => p.ts(a) - p.ts(b));
    for (let k = 1; k < rows.length; k++) {
      yield row(String(p.txnId(rows[k - 1])), String(p.txnId(rows[k])));
    }
  }
}

function* closedCases(closed: any[]) {
  for (const r of closed) {
    yield row(
      r.case_id, r.customer_id, r.card_id, r.opened_at, r.closed_at,
      r.outcome, r.pattern, r.first_fraud_txn_id ?? '', r.txn_ids ?? '',
      r.n_txns, r.exposure_usd, r.connected_card_ids ?? '', r.actions_taken ?? '',
      r.report_filed ?? '', r.analyst_notes ?? '',
    );
  }
}

function* ccInvolves(closed: any[]) {
  for (const r of closed) {
    for (const t of String(r.txn_ids || '').split('|')) {
      if (t.trim()) yield row(r.case_id, t.trim());
    }
  }
}

function* ccConnected(closed: any[]) {
  for (const r of closed) {
    for (const c of String(r.connected_card_ids || '').split('|')) {
      if (c.trim()) yield row(r.case_id, c.trim());
    }
  }
}

function* ccCard(closed: any[]) {
  for (const r of closed) {
    if (r.card_id) yield row(r.case_id, r.card_id);
  }
}

const closed = readCsvFile(path.join(RAW, 'closed_cases_history.csv'));

const counts = {
  customers: writeLines(path.join(OUT, 'customers.csv'), 'customer_id', customers()),
  cards: writeLines(path.join(OUT, 'cards.csv'), 'card_id,card_key,customer_id,k_index,label_source', cards()),
  transactions: writeLines(path.join(OUT, 'transactions.csv'),
    'txn_id,ts,ts_epoch,amount_usd,product_cd,channel,risk_score,customer_id,card_id,addr1,addr2,p_emaildomain,r_emaildomain',
    transactions()),
  devices: writeLines(path.join(OUT, 'devices.csv'),
    'device_id,device_type,os,browser,screen,device_new_or_found,proxy', devices()),
  tx_device: writeLines(path.join(OUT, 'tx_device.csv'), 'txn_id,device_id', txDevice()),
  regions: writeLines(path.join(OUT, 'regions.csv'), 'region,country', regions()),
  tx_region: writeLines(path.join(OUT, 'tx_region.csv'), 'txn_id,region', txRegion()),
  email_domains: writeLines(path.join(OUT, 'email_domains.csv'), 'domain', emailDomains()),
  tx_email: writeLines(path.join(OUT, 'tx_email.csv'), 'txn_id,domain', txEmail()),
  tx_next: writeLines(path.join(OUT, 'tx_next.csv'), 'from_txn_id,to_txn_id', txNext()),
  closed_cases: writeLines(path.join(OUT, 'closed_cases.csv'),
    'case_id,customer_id,card_id,opened_at,closed_at,outcome,pattern,first_fraud_txn_id,txn_ids,n_txns,exposure_usd,connected_card_ids,actions_taken,report_filed,analyst_notes',
    closedCases(closed)),
  closed_case_involves: writeLines(path.join(OUT, 'closed_case_involves.csv'), 'case_id,txn_id', ccInvolves(closed)),
  closed_case_connected: writeLines(path.join(OUT, 'closed_case_connected.csv'), 'case_id,card_id', ccConnected(closed)),
  closed_case_card: writeLines(path.join(OUT, 'closed_case_card.csv'), 'case_id,card_id', ccCard(closed)),
};

console.log(JSON.stringify({ out: OUT, rows: counts }, null, 2));

