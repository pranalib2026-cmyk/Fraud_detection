/**
 * Diagnostic: how is the C#####-K# card id derived from transactions.csv?
 *
 * Uses the (card_id, txn_id) pairs that the dataset itself gives us in
 * closed_cases_history.csv and case_pack.csv as ground truth, and looks for the
 * transaction column(s) that separate two cards of the same customer.
 *
 * Usage: node tools/diagnose-cardids.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw', 'HHGOA_IEEE');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c;
    } else if (c === '"') inQuotes = true;
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
  const out = [];
  let start = 0;
  for (let i = 0; i < line.length && out.length < n; i++) {
    if (line[i] === ',') { out.push(line.slice(start, i)); start = i + 1; }
  }
  if (out.length < n) out.push(line.slice(start));
  return out;
}
function lastFields(line, n) {
  const out = [];
  let end = line.length;
  for (let i = line.length - 1; i >= 0 && out.length < n; i--) {
    if (line[i] === ',') { out.push(line.slice(i + 1, end)); end = i; }
  }
  if (out.length < n) out.push(line.slice(0, end));
  return out.reverse();
}
const closed = readCsv(path.join(RAW, 'closed_cases_history.csv'));
const pack = readCsv(path.join(RAW, 'case_pack.csv'));

const pairs = [];
for (const r of closed) {
  for (const t of String(r.txn_ids || '').split('|').filter(Boolean)) pairs.push([r.card_id, t.trim()]);
}
for (const r of pack) pairs.push([r.card_id, String(r.flagged_txn_id).trim()]);
const wanted = new Map(pairs.map(([c, t]) => [t, c]));

// Which logical columns explain a card_id? Compare card1 + candidates.
const rows = new Map(); // txn -> full-ish record
await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW, 'transactions.csv')), crlfDelay: Infinity });
  let first = true;
  rl.on('line', (line) => {
    if (first) {
      first = false;
      return;
    }
    const id = line.slice(0, line.indexOf(','));
    if (!wanted.has(id)) return;
    const f = firstFields(line, 12);
    const tail = lastFields(line, 4);
    rows.set(id, {
      txn: id, card1: f[4], card2: f[5], card3: f[6], card4: f[7], card5: f[8], card6: f[9],
      addr1: f[10], product: f[3], amount: f[2],
      customer: tail[0], ts: tail[1], channel: tail[2], risk: tail[3],
    });
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

// card_id -> signature over candidate columns
const sigs = new Map(); // card_id -> Set(sig)
const combos = {
  card1: (r) => [r.card1],
  'card1+card6': (r) => [r.card1, r.card6],
  'card1+card4': (r) => [r.card1, r.card4],
  'card1+card4+card6': (r) => [r.card1, r.card4, r.card6],
  'card1+card2+card3+card5': (r) => [r.card1, r.card2, r.card3, r.card5],
  'card1..card6': (r) => [r.card1, r.card2, r.card3, r.card4, r.card5, r.card6],
  customer: (r) => [r.customer],
  'customer+card1': (r) => [r.customer, r.card1],
  'customer+card1+card6': (r) => [r.customer, r.card1, r.card6],
  'customer+card1+card4+card6': (r) => [r.customer, r.card1, r.card4, r.card6],
};
const results = {};
for (const [name, fn] of Object.entries(combos)) {
  const sigToCard = new Map();
  const cardToSig = new Map();
  let bad = 0;
  for (const [txn, cardId] of wanted) {
    const r = rows.get(txn);
    if (!r) continue;
    const sig = fn(r).join('|');
    if (sigToCard.has(sig) && sigToCard.get(sig) !== cardId) bad++;
    sigToCard.set(sig, cardId);
    cardToSig.set(cardId, sig);
  }
  results[name] = { collisions: bad, distinct_signatures: sigToCard.size, cards: cardToSig.size };
}
console.log('candidate key -> evidence fit (collisions = same signature, two card_ids):');
console.log(JSON.stringify(results, null, 1));

// Show the collisions under the best candidate
const shared = new Map();
for (const [txn, cardId] of wanted) {
  const r = rows.get(txn);
  if (!r) continue;
  const k = r.card1;
  const set = shared.get(k) ?? new Set();
  set.add(cardId);
  shared.set(k, set);
}
const multi = [...shared.entries()].filter(([, s]) => s.size > 1);
console.log(`\ncard1 values shared by multiple card_ids: ${multi.length}`);
for (const [card1, set] of multi.slice(0, 8)) {
  console.log(`\n--- card1=${card1} -> ${[...set].join(', ')}`);
  for (const cardId of set) {
    const txns = [...wanted.entries()].filter(([t, c]) => c === cardId).map(([t]) => t);
    const sample = txns.map((t) => rows.get(t)).filter(Boolean).slice(0, 2);
    for (const s of sample) {
      console.log(`   ${cardId} ${s.txn} card4=${s.card4} card6=${s.card6} card2=${s.card2} card3=${s.card3} card5=${s.card5} prod=${s.product} ch=${s.channel} ts=${s.ts} addr1=${s.addr1}`);
    }
    console.log(`   (${cardId} matched ${txns.length} txns in labelled evidence)`);
  }
}
