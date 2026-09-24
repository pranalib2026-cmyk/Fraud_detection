/**
 * Diagnostic: what orders the -K# suffix on a card id?
 *
 * For every customer that the labelled evidence (closed cases + case pack) shows
 * holding more than one card, compute per-card aggregates from the full
 * transactions file and test candidate orderings against the observed K index.
 *
 * Usage: node tools/diagnose-kindex.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw', 'HHGOA_IEEE');

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c; }
    else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function readCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
function firstFields(line, n) {
  const out = []; let start = 0;
  for (let i = 0; i < line.length && out.length < n; i++) if (line[i] === ',') { out.push(line.slice(start, i)); start = i + 1; }
  if (out.length < n) out.push(line.slice(start));
  return out;
}
function lastFields(line, n) {
  const out = []; let end = line.length;
  for (let i = line.length - 1; i >= 0 && out.length < n; i--) if (line[i] === ',') { out.push(line.slice(i + 1, end)); end = i; }
  if (out.length < n) out.push(line.slice(0, end));
  return out.reverse();
}
function streamTxns(onRow) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW, 'transactions.csv')), crlfDelay: Infinity });
    let first = true;
    rl.on('line', (line) => { if (first) { first = false; return; } onRow(line); });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

const closed = readCsv(path.join(RAW, 'closed_cases_history.csv'));
const pack = readCsv(path.join(RAW, 'case_pack.csv'));

// labelled evidence: txn -> card_id
const txn2card = new Map();
for (const r of closed) for (const t of String(r.txn_ids || '').split('|').filter(Boolean)) txn2card.set(t.trim(), r.card_id);
for (const r of pack) txn2card.set(String(r.flagged_txn_id).trim(), r.card_id);

// pass 1: learn card_id -> (card1, card6) signature
const cardSig = new Map();
await streamTxns((line) => {
  const id = line.slice(0, line.indexOf(','));
  const cardId = txn2card.get(id);
  if (!cardId) return;
  const f = firstFields(line, 10);
  const sig = `${f[4]}|${f[9]}`; // card1 | card6
  const prev = cardSig.get(cardId);
  if (prev && prev !== sig) console.log(`CONFLICT ${cardId}: ${prev} vs ${sig}`);
  cardSig.set(cardId, sig);
});

// customers holding more than one labelled card
const byCustomer = new Map();
for (const [cardId, sig] of cardSig) {
  const cust = cardId.split('-')[0];
  const list = byCustomer.get(cust) ?? [];
  list.push({ cardId, sig, k: Number(cardId.split('-K')[1] ?? '0'), card6: sig.split('|')[1] });
  byCustomer.set(cust, list);
}
const multiCustomers = [...byCustomer.entries()].filter(([, l]) => l.length > 1);
const wantedSig = new Set(multiCustomers.flatMap(([, l]) => l.map((x) => x.sig)));

// pass 2: per-signature aggregates over the whole file
const agg = new Map();
await streamTxns((line) => {
  const f = firstFields(line, 11);
  const sig = `${f[4]}|${f[9]}`;
  if (!wantedSig.has(sig)) return;
  const tail = lastFields(line, 4);
  const a = agg.get(sig) ?? { n: 0, amt: 0, first: '9999', last: '0000', products: new Set(), channels: new Set(), riskSum: 0 };
  a.n++; a.amt += Number(f[2]) || 0;
  if (tail[1] < a.first) a.first = tail[1];
  if (tail[1] > a.last) a.last = tail[1];
  a.products.add(f[3]); a.channels.add(tail[2]); a.riskSum += Number(tail[3]) || 0;
  agg.set(sig, a);
});

const productRank = { C: 0, H: 1, R: 2, S: 3, W: 4 };
const hypotheses = {
  'first_ts asc': () => ['asc'],
  'first_ts desc': () => ['desc'],
};
void hypotheses;
const ranked = {
  first_ts: (x) => x.a.first,
  last_ts: (x) => x.a.last,
  n_txns: (x) => x.a.n,
  total_amt: (x) => x.a.amt,
  avg_risk: (x) => x.a.riskSum / Math.max(1, x.a.n),
  n_products: (x) => x.a.products.size,
  min_product_rank: (x) => [...x.a.products].map((p) => productRank[p] ?? 9).sort((p, q) => p - q)[0],
  card6: (x) => x.card6 ?? '',
};
const results = {};
for (const [name, keyFn] of Object.entries(ranked)) {
  for (const dir of ['asc', 'desc']) {
    let ok = 0;
    for (const [, list] of multiCustomers) {
      const items = list.map((x) => ({ ...x, a: agg.get(x.sig) ?? { n: 0, amt: 0, first: '', last: '', products: new Set(), riskSum: 0 } }));
      const sorted = [...items].sort((p, q) => {
        const kp = keyFn(p); const kq = keyFn(q);
        const cmp = kp < kq ? -1 : kp > kq ? 1 : 0;
        return dir === 'asc' ? cmp : -cmp;
      });
      if (JSON.stringify(sorted.map((x) => x.k)) === JSON.stringify([...sorted].map((x) => x.k).sort((p, q) => p - q))) ok++;
    }
    results[`${name} ${dir}`] = `${ok}/${multiCustomers.length}`;
  }
}
console.log('multi-card customers found:', multiCustomers.length);
console.log('K-index ordering hypotheses (exact fit):');
console.log(JSON.stringify(results, null, 1));

console.log('\nper-customer detail:');
for (const [cust, list] of multiCustomers) {
  console.log(`\n${cust}`);
  for (const x of list) {
    const a = agg.get(x.sig) ?? { n: 0, amt: 0, first: '', last: '', products: new Set(), channels: new Set(), riskSum: 0 };
    console.log(`  ${x.cardId} sig=${x.sig} n=${a.n} amt=${a.amt.toFixed(2)} first=${a.first} last=${a.last} products=${[...a.products].join('/')} channels=${[...a.channels].join('/')} avgRisk=${(a.riskSum / Math.max(1, a.n)).toFixed(3)}`);
  }
}


