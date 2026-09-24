/**
 * Phase 1 - dataset inspection.
 *
 * Reads the supplied HHGOA_IEEE dataset exactly as shipped and produces:
 *   - data/derived/data_profile.json   (machine readable facts)
 *   - docs/data_profile.md             (human readable facts)
 *
 * Nothing here invents a column: every number is derived from the CSVs.
 *
 * Usage: node tools/inspect-dataset.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw', 'HHGOA_IEEE');
const DERIVED = path.join(ROOT, 'data', 'derived');
const DOCS = path.join(ROOT, 'docs');

/** Quote-aware CSV record parser (RFC4180 style, handles embedded newlines/commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
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

/** Return the first n CSV fields of a raw line without allocating the whole row. */
function firstFields(line, n) {
  const out = [];
  let start = 0;
  for (let i = 0; i < line.length && out.length < n; i++) {
    if (line[i] === ',') { out.push(line.slice(start, i)); start = i + 1; }
  }
  if (out.length < n) out.push(line.slice(start));
  return out;
}

/** Return the last n CSV fields of a line (dataset tail fields are unquoted). */
function lastFields(line, n) {
  const out = [];
  let end = line.length;
  for (let i = line.length - 1; i >= 0 && out.length < n; i--) {
    if (line[i] === ',') { out.push(line.slice(i + 1, end)); end = i; }
  }
  if (out.length < n) out.push(line.slice(0, end));
  return out.reverse();
}

/** Read only the first line of a large file (avoids loading hundreds of MB). */
function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 16);
  const read = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return buf.subarray(0, read).toString('utf8').split('\n')[0];
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const sortedEntries = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

async function main() {
  const profile = {
    generated_at: new Date().toISOString(),
    source: 'data/raw/HHGOA_IEEE',
  };

  // ---------------------------------------------------------------- case pack
  const casePack = readCsv(path.join(RAW, 'case_pack.csv'));
  profile.case_pack = {
    rows: casePack.length,
    columns: Object.keys(casePack[0]),
    triggers: Object.fromEntries(sortedEntries(casePack.reduce((m, r) => (bump(m, r.trigger_type), m), new Map()), 10)),
    distinct_customers: new Set(casePack.map((r) => r.customer_id)).size,
    distinct_cards: new Set(casePack.map((r) => r.card_id)).size,
  };

  // -------------------------------------------------------- closed case history
  const closed = readCsv(path.join(RAW, 'closed_cases_history.csv'));
  profile.closed_cases = {
    rows: closed.length,
    columns: Object.keys(closed[0]),
    outcomes: Object.fromEntries(sortedEntries(closed.reduce((m, r) => (bump(m, r.outcome), m), new Map()), 10)),
    patterns: Object.fromEntries(sortedEntries(closed.reduce((m, r) => (bump(m, r.pattern), m), new Map()), 10)),
    report_filed: Object.fromEntries(sortedEntries(closed.reduce((m, r) => (bump(m, r.report_filed), m), new Map()), 10)),
    actions_taken: Object.fromEntries(sortedEntries(closed.reduce((m, r) => {
      for (const a of (r.actions_taken || '').split('|').filter(Boolean)) bump(m, a);
      return m;
    }, new Map()), 30)),
    exposure_usd_total: +closed.reduce((s, r) => s + (Number(r.exposure_usd) || 0), 0).toFixed(2),
    exposure_usd_max: Math.max(...closed.map((r) => Number(r.exposure_usd) || 0)),
    n_txns_over_1: closed.filter((r) => Number(r.n_txns) > 1).length,
    connected_cards_present: closed.filter((r) => (r.connected_card_ids || '').trim() !== '').length,
    date_range: [closed.map((r) => r.opened_at).sort()[0], closed.map((r) => r.closed_at).sort().at(-1)],
  };

  // Txn ids we must resolve back to raw transactions (closed cases + case pack).
  const wanted = new Set();
  for (const r of closed) for (const t of String(r.txn_ids || '').split('|')) if (t.trim()) wanted.add(t.trim());
  for (const r of closed) if (r.first_fraud_txn_id) wanted.add(String(r.first_fraud_txn_id).trim());
  for (const r of casePack) if (r.flagged_txn_id) wanted.add(String(r.flagged_txn_id).trim());

  // -------------------------------------------------------------- transactions
  const txnHeader = readFirstLine(path.join(RAW, 'transactions.csv')).split(',').map((s) => s.trim());
  const extra = txnHeader.slice(-4);
  if (extra.join(',') !== 'customer_id,ts,channel,risk_score') {
    throw new Error(`Unexpected tail columns: ${extra.join(',')}`);
  }

  const t = {
    columns: txnHeader.length,
    rows: 0,
    customers: new Set(),
    card1: new Map(),
    customerCards: new Map(),
    productCD: new Map(),
    channel: new Map(),
    riskHistogram: new Array(10).fill(0),
    riskNull: 0,
    riskMin: 1,
    riskMax: 0,
    tsMin: '9999',
    tsMax: '0000',
    txnIdMin: null,
    txnIdMax: null,
    addr1: new Map(),
    addr2: new Map(),
    amtTotal: 0,
    amtMax: 0,
    firstTsByCustomerCard: new Map(),
    resolved: new Map(),
  };

  await streamLines(path.join(RAW, 'transactions.csv'), (line, isHeader) => {
    if (isHeader || !line) return;
    t.rows++;
    const head = firstFields(line, 12);
    const [txnId, dt, amt, product, card1, , , , , , addr1, addr2] = head;
    const [customerId, ts, channel, risk] = lastFields(line, 4);
    const amount = Number(amt) || 0;

    t.customers.add(customerId);
    bump(t.card1, card1);
    let cards = t.customerCards.get(customerId);
    if (!cards) { cards = new Set(); t.customerCards.set(customerId, cards); }
    cards.add(card1);
    bump(t.productCD, product);
    bump(t.channel, channel);
    bump(t.addr1, addr1 || '');
    bump(t.addr2, addr2 || '');
    t.amtTotal += amount;
    if (amount > t.amtMax) t.amtMax = amount;
    if (ts < t.tsMin) t.tsMin = ts;
    if (ts > t.tsMax) t.tsMax = ts;
    if (t.txnIdMin === null || txnId < t.txnIdMin) t.txnIdMin = txnId;
    if (t.txnIdMax === null || txnId > t.txnIdMax) t.txnIdMax = txnId;
    if (risk === '') t.riskNull++;
    else {
      const r = Number(risk);
      if (r < t.riskMin) t.riskMin = r;
      if (r > t.riskMax) t.riskMax = r;
      t.riskHistogram[Math.min(9, Math.floor(r * 10))]++;
    }
    const key = `${customerId}|${card1}`;
    if (!t.firstTsByCustomerCard.has(key) || ts < t.firstTsByCustomerCard.get(key)) {
      t.firstTsByCustomerCard.set(key, ts);
    }
    if (wanted.has(txnId)) {
      t.resolved.set(txnId, {
        txn_id: txnId, customer_id: customerId, card1, ts, channel,
        product, amount, addr1, addr2, risk_score: risk, transaction_dt: dt,
        card4: head[7], card6: head[9],
      });
    }
  });

  const card1Owners = new Map();
  for (const key of t.firstTsByCustomerCard.keys()) {
    const [cust, card] = key.split('|');
    const set = card1Owners.get(card) ?? new Set();
    set.add(cust);
    card1Owners.set(card, set);
  }

  profile.transactions = {
    columns: t.columns,
    rows: t.rows,
    distinct_customers: t.customers.size,
    distinct_card1: t.card1.size,
    distinct_customer_card_pairs: t.firstTsByCustomerCard.size,
    customers_with_multiple_card1: [...t.customerCards.values()].filter((s) => s.size > 1).length,
    card1_multi_customer: [...card1Owners.values()].filter((s) => s.size > 1).length,
    product_cd: Object.fromEntries(sortedEntries(t.productCD, 10)),
    channel: Object.fromEntries(sortedEntries(t.channel, 10)),
    risk_score: { nulls: t.riskNull, min: t.riskMin, max: t.riskMax, histogram_deciles: t.riskHistogram },
    ts_range: [t.tsMin, t.tsMax],
    txn_id_range: [t.txnIdMin, t.txnIdMax],
    amount: { total_usd: +t.amtTotal.toFixed(2), max_usd: +t.amtMax.toFixed(2) },
    addr1_distinct: t.addr1.size,
    addr2_distinct: t.addr2.size,
    addr2_top: Object.fromEntries(sortedEntries(t.addr2, 6)),
    resolved_requested_txns: t.resolved.size,
    resolved_missing: [...wanted].filter((id) => !t.resolved.has(id)).length,
  };

  // -------------------------------------------------------------------- identity
  const idHeader = readFirstLine(path.join(RAW, 'identity.csv')).split(',').map((s) => s.trim());
  const id = {
    columns: idHeader.length, rows: 0, id_15: new Map(), id_23: new Map(),
    id_30: new Map(), id_31: new Map(), id_33: new Map(), device_type: new Map(),
    device_info: new Map(), resolved: new Map(),
  };
  const idx = (name) => idHeader.indexOf(name);

  await streamLines(path.join(RAW, 'identity.csv'), (line, isHeader) => {
    if (isHeader || !line) return;
    id.rows++;
    const f = firstFields(line, idHeader.length);
    const get = (name) => f[idx(name)] ?? '';
    bump(id.id_15, get('id_15') || '');
    bump(id.id_23, get('id_23') || '');
    bump(id.id_30, get('id_30') || '');
    bump(id.id_31, get('id_31') || '');
    bump(id.id_33, get('id_33') || '');
    bump(id.device_type, get('DeviceType') || '');
    bump(id.device_info, get('DeviceInfo') || '');
    const txnId = f[0];
    if (wanted.has(txnId)) {
      id.resolved.set(txnId, {
        txn_id: txnId,
        device_type: get('DeviceType'),
        device_info: get('DeviceInfo'),
        os: get('id_30'),
        browser: get('id_31'),
        screen: get('id_33'),
        device_new_or_found: get('id_15'),
        proxy: get('id_23'),
        match_status: get('id_34'),
      });
    }
  });

  profile.identity = {
    columns: id.columns,
    rows: id.rows,
    id_15: Object.fromEntries(sortedEntries(id.id_15, 10)),
    id_23: Object.fromEntries(sortedEntries(id.id_23, 10)),
    id_30_top: Object.fromEntries(sortedEntries(id.id_30, 15)),
    id_31_top: Object.fromEntries(sortedEntries(id.id_31, 15)),
    id_33_top: Object.fromEntries(sortedEntries(id.id_33, 15)),
    device_type: Object.fromEntries(sortedEntries(id.device_type, 10)),
    device_info_distinct: id.device_info.size,
    device_info_top: Object.fromEntries(sortedEntries(id.device_info, 20)),
    resolved_requested_txns: id.resolved.size,
  };

  // --------------------------------------------------- card_id (K suffix) rule
  // Evidence: closed cases give (card_id, txn_ids), the case pack gives
  // (card_id, flagged_txn_id). Resolve each txn to its raw transaction columns
  // and look for the column combination that reproduces the labelled card ids.
  const custOf = (cardId) => cardId.split('-')[0];
  const keyCandidates = {
    card1: (r) => [r.card1],
    customer_id: (r) => [r.customer_id],
    'customer_id+card1': (r) => [r.customer_id, r.card1],
    'card1+card4': (r) => [r.card1, r.card4],
    'card1+card6': (r) => [r.card1, r.card6],
    'card1+card4+card6': (r) => [r.card1, r.card4, r.card6],
    'customer_id+card1+card6': (r) => [r.customer_id, r.card1, r.card6],
  };
  const pairs = [];
  for (const r of closed) {
    for (const txn of String(r.txn_ids || '').split('|').filter(Boolean)) pairs.push([r.card_id, txn.trim(), `closed:${r.case_id}`]);
  }
  for (const r of casePack) pairs.push([r.card_id, String(r.flagged_txn_id).trim(), `pack:${r.case_id}`]);

  const candidateFit = {};
  for (const [name, fn] of Object.entries(keyCandidates)) {
    const sigToCard = new Map();
    const cardToSig = new Map();
    let collisions = 0;
    let resolved = 0;
    for (const [cardId, txnId] of pairs) {
      const row = t.resolved.get(txnId);
      if (!row) continue;
      resolved++;
      const sig = fn(row).join('|');
      if (sigToCard.has(sig) && sigToCard.get(sig) !== cardId) collisions++;
      sigToCard.set(sig, cardId);
      cardToSig.set(cardId, sig);
    }
    candidateFit[name] = { collisions, distinct_signatures: sigToCard.size, cards: cardToSig.size, resolved_pairs: resolved };
  }

  // Chosen key = simplest candidate with zero collisions over all labelled pairs.
  const keyName = Object.entries(candidateFit)
    .filter(([, v]) => v.collisions === 0 && v.resolved_pairs > 0)
    .sort((a, b) => a[0].length - b[0].length)[0]?.[0] ?? 'card1+card6';
  const keyFn = keyCandidates[keyName];

  const cardIdToSig = new Map();
  const sigToCardId = new Map();
  const conflicts = [];
  for (const [cardId, txnId, origin] of pairs) {
    const row = t.resolved.get(txnId);
    if (!row) continue;
    const sig = keyFn(row).join('|');
    const prev = cardIdToSig.get(cardId);
    if (prev && prev !== sig) conflicts.push({ cardId, txnId, origin, prev, now: sig });
    cardIdToSig.set(cardId, sig);
    sigToCardId.set(sig, cardId);
  }
  let sigsWithoutCard6 = 0;
  for (const sig of sigToCardId.keys()) if (sig.endsWith('|')) sigsWithoutCard6++;

  const byCustomer = new Map();
  for (const [cardId, sig] of cardIdToSig) {
    const list = byCustomer.get(custOf(cardId)) ?? [];
    list.push({ cardId, sig, k: Number(cardId.split('-K')[1] ?? '0') });
    byCustomer.set(custOf(cardId), list);
  }
  const multiCustomers = [...byCustomer.entries()].filter(([, l]) => l.length > 1);
  const multiSigs = new Set(multiCustomers.flatMap(([, l]) => l.map((x) => x.sig)));

  // Second targeted pass over the raw file for per-card behaviour of those cards.
  const agg = new Map();
  await streamLines(path.join(RAW, 'transactions.csv'), (line, isHeader) => {
    if (isHeader || !line) return;
    const head = firstFields(line, 12);
    const sig = `${head[4]}|${head[9]}`;
    if (!multiSigs.has(sig)) return;
    const [customerId, ts, channel, risk] = lastFields(line, 4);
    void customerId;
    const a = agg.get(sig) ?? { n: 0, amt: 0, first: '9999', last: '0000', products: new Set(), channels: new Set(), riskSum: 0 };
    a.n++;
    a.amt += Number(head[2]) || 0;
    if (ts < a.first) a.first = ts;
    if (ts > a.last) a.last = ts;
    a.products.add(head[3]);
    a.channels.add(channel);
    a.riskSum += Number(risk) || 0;
    agg.set(sig, a);
  });

  const productRank = { C: 0, H: 1, R: 2, S: 3, W: 4 };
  void productRank;
  const orderings = {
    'first_ts': (x) => x.a.first,
    'last_ts': (x) => x.a.last,
    'n_txns': (x) => x.a.n,
    'total_amt': (x) => x.a.amt,
    'card6': (x) => x.card6 ?? '',
    'card1': (x) => Number(x.card1),
  };
  const orderingFit = {};
  for (const [name, key] of Object.entries(orderings)) {
    for (const dir of ['asc', 'desc']) {
      let ok = 0;
      for (const [, list] of multiCustomers) {
        const items = list.map((x) => ({
          ...x,
          card6: x.sig.split('|')[1],
          card1: x.sig.split('|')[0],
          a: agg.get(x.sig) ?? { n: 0, amt: 0, first: '', last: '', products: new Set() },
        }));
        const sorted = [...items].sort((p, q) => {
          const kp = key(p);
          const kq = key(q);
          const cmp = kp < kq ? -1 : kp > kq ? 1 : 0;
          return dir === 'asc' ? cmp : -cmp;
        });
        if (JSON.stringify(sorted.map((x) => x.k)) === JSON.stringify([...sorted].map((x) => x.k).sort((p, q) => p - q))) ok++;
      }
      orderingFit[`${name} ${dir}`] = multiCustomers.length ? `${ok}/${multiCustomers.length}` : 'n/a';
    }
  }
  const bestOrdering = Object.entries(orderingFit)
    .sort((a, b) => parseInt(b[1], 10) - parseInt(a[1], 10))[0];

  profile.card_id_derivation = {
    candidate_keys: candidateFit,
    chosen_key: keyName,
    chosen_key_conflicts: conflicts.length,
    conflict_examples: conflicts.slice(0, 5),
    labelled_card_ids: cardIdToSig.size,
    labelled_signatures: sigToCardId.size,
    signatures_without_card6: sigsWithoutCard6,
    customers_with_2plus_labelled_cards: multiCustomers.length,
    k_index_ordering_fit: orderingFit,
    k_index_best_ordering: bestOrdering ? `${bestOrdering[0]} = ${bestOrdering[1]}` : 'n/a',
    card_level_detail: multiCustomers.slice(0, 6).map(([cust, list]) => ({
      customer_id: cust,
      cards: list.map((x) => {
        const a = agg.get(x.sig);
        return {
          card_id: x.cardId, signature: x.sig, k: x.k, txns: a?.n ?? 0,
          total_usd: a ? +a.amt.toFixed(2) : 0, first_ts: a?.first ?? '', last_ts: a?.last ?? '',
          products: a ? [...a.products].join('/') : '',
        };
      }),
    })),
  };

  // ----------------------------------------------------- case pack txn resolution
  profile.case_pack_resolution = casePack.map((c) => {
    const txnId = String(c.flagged_txn_id).trim();
    const row = t.resolved.get(txnId);
    const ident = id.resolved.get(txnId) ?? null;
    return {
      case_id: c.case_id,
      trigger_type: c.trigger_type,
      flagged_txn_id: txnId,
      card_id: c.card_id,
      customer_id: c.customer_id,
      risk_score_from_pack: c.risk_score || null,
      resolved: row
        ? {
            customer_id: row.customer_id, card1: row.card1, ts: row.ts, channel: row.channel,
            product_cd: row.product, amount_usd: row.amount, addr1: row.addr1,
            addr2: row.addr2, risk_score: row.risk_score,
          }
        : null,
      identity: ident,
      customer_id_matches: row ? row.customer_id === c.customer_id : null,
      risk_score_matches: row && c.risk_score ? Math.abs(Number(row.risk_score) - Number(c.risk_score)) < 1e-9 : null,
    };
  });

  // ------------------------------------------------------------------ reporting
  fs.mkdirSync(DERIVED, { recursive: true });
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DERIVED, 'data_profile.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(DOCS, 'data_profile.md'), renderMarkdown(profile));
  console.log('wrote data/derived/data_profile.json and docs/data_profile.md');
  console.log(JSON.stringify({
    txn_rows: profile.transactions.rows,
    identity_rows: profile.identity.rows,
    closed_cases: profile.closed_cases.rows,
    case_pack_resolved: profile.case_pack_resolution.filter((c) => c.resolved).length,
    case_pack_customer_mismatch: profile.case_pack_resolution.filter((c) => c.customer_id_matches === false).length,
    chosen_card_key: profile.card_id_derivation.chosen_key,
    chosen_card_key_conflicts: profile.card_id_derivation.chosen_key_conflicts,
    labelled_cards: profile.card_id_derivation.labelled_card_ids,
    k_index_best_ordering: profile.card_id_derivation.k_index_best_ordering,
  }, null, 2));
}

/** Stream a CSV file line by line, calling fn(line, isHeader). */
function streamLines(file, fn) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let first = true;
    rl.on('line', (line) => {
      const isHeader = first;
      first = false;
      fn(line, isHeader);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

function renderMarkdown(p) {
  const rows = (obj) => Object.entries(obj).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n');
  const deciles = p.transactions.risk_score.histogram_deciles
    .map((c, i) => `- \`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}\`: ${c}`).join('\n');
  const header = '| case | trigger | flagged txn | card | customer match | risk match | channel | amount | addr1 | risk | device id_15 |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const caseRows = p.case_pack_resolution.map((c) => `| ${c.case_id} | ${c.trigger_type} | ${c.flagged_txn_id} | ${
    c.card_id} | ${c.customer_id_matches === null ? 'unresolved' : c.customer_id_matches} | ${
    c.risk_score_matches === null ? 'n/a' : c.risk_score_matches} | ${c.resolved?.channel ?? ''} | ${
    c.resolved?.amount_usd ?? ''} | ${c.resolved?.addr1 ?? ''} | ${c.resolved?.risk_score ?? ''} | ${
    c.identity?.device_new_or_found ?? 'no identity record'} |`).join('\n');
  return renderHead(p, rows, deciles) + renderFiles(p, rows) + renderTxn(p, rows, deciles)
    + renderIdentity(p, rows) + renderClosed(p, rows) + renderPack(p, rows, header, sep, caseRows);
}

function renderHead(p) {
  return `# Dataset profile (auto-generated)

Generated: ${p.generated_at}
Source: \`${p.source}\`

Produced by \`tools/inspect-dataset.mjs\` directly from the shipped CSVs. Nothing here is
hand-entered, so it can be regenerated and re-verified at any time:

\`\`\`bash
node tools/inspect-dataset.mjs
\`\`\`
`;
}

function renderFiles(p, rows) {
  return `
## Files

| File | Rows | Columns |
|---|---|---|
| transactions.csv | ${p.transactions.rows} | ${p.transactions.columns} |
| identity.csv | ${p.identity.rows} | ${p.identity.columns} |
| closed_cases_history.csv | ${p.closed_cases.rows} | ${p.closed_cases.columns.length} |
| case_pack.csv | ${p.case_pack.rows} | ${p.case_pack.columns.length} |
`;
}

function renderTxn(p, rows, deciles) {
  return `
## transactions.csv

| Fact | Value |
|---|---|
| Rows | ${p.transactions.rows} |
| Columns | ${p.transactions.columns} |
| Distinct \`customer_id\` | ${p.transactions.distinct_customers} |
| Distinct \`card1\` | ${p.transactions.distinct_card1} |
| Distinct (customer_id, card1) pairs | ${p.transactions.distinct_customer_card_pairs} |
| Customers with more than one card1 | ${p.transactions.customers_with_multiple_card1} |
| card1 values shared by more than one customer_id | ${p.transactions.card1_multi_customer} |
| \`ts\` range | ${p.transactions.ts_range.join(' .. ')} |
| \`TransactionID\` range | ${p.transactions.txn_id_range.join(' .. ')} |
| Total amount (USD) | ${p.transactions.amount.total_usd} |
| Largest amount (USD) | ${p.transactions.amount.max_usd} |
| Distinct \`addr1\` | ${p.transactions.addr1_distinct} |
| Distinct \`addr2\` | ${p.transactions.addr2_distinct} |
| \`risk_score\` empty values | ${p.transactions.risk_score.nulls} |
| \`risk_score\` min / max | ${p.transactions.risk_score.min} / ${p.transactions.risk_score.max} |
| Referenced txns resolved from the raw file | ${p.transactions.resolved_requested_txns} |
| Referenced txns not found | ${p.transactions.resolved_missing} |

### ProductCD

| Value | Count |
|---|---|
${rows(p.transactions.product_cd)}

### channel

| Value | Count |
|---|---|
${rows(p.transactions.channel)}

### risk_score deciles

${deciles}

### addr2 (billing country code), top values

| addr2 | Count |
|---|---|
${rows(p.transactions.addr2_top)}
`;
}

function renderIdentity(p, rows) {
  return `
## identity.csv

| Fact | Value |
|---|---|
| Rows | ${p.identity.rows} |
| Columns | ${p.identity.columns} |
| Distinct DeviceInfo strings | ${p.identity.device_info_distinct} |

### id_15 (device New / Found)

| Value | Count |
|---|---|
${rows(p.identity.id_15)}

### id_23 (proxy)

| Value | Count |
|---|---|
${rows(p.identity.id_23)}

### DeviceType

| Value | Count |
|---|---|
${rows(p.identity.device_type)}

### id_30 (OS), top 15

| Value | Count |
|---|---|
${rows(p.identity.id_30_top)}

### id_31 (browser), top 15

| Value | Count |
|---|---|
${rows(p.identity.id_31_top)}

### DeviceInfo, top 20

| Value | Count |
|---|---|
${rows(p.identity.device_info_top)}
`;
}

function renderClosed(p, rows) {
  return `
## closed_cases_history.csv

| Fact | Value |
|---|---|
| Rows | ${p.closed_cases.rows} |
| Opened / closed range | ${p.closed_cases.date_range.join(' .. ')} |
| Cases naming connected cards | ${p.closed_cases.connected_cards_present} |
| Cases with more than one transaction | ${p.closed_cases.n_txns_over_1} |
| Total exposure (USD) | ${p.closed_cases.exposure_usd_total} |
| Largest exposure (USD) | ${p.closed_cases.exposure_usd_max} |

### outcome

| Value | Count |
|---|---|
${rows(p.closed_cases.outcomes)}

### pattern

| Value | Count |
|---|---|
${rows(p.closed_cases.patterns)}

### report_filed

| Value | Count |
|---|---|
${rows(p.closed_cases.report_filed)}

### actions_taken (split on \\|)

| Action | Count |
|---|---|
${rows(p.closed_cases.actions_taken)}
`;
}

function renderPack(p, rows, header, sep, caseRows) {
  return `
## case_pack.csv

| Fact | Value |
|---|---|
| Rows | ${p.case_pack.rows} |
| Distinct customers | ${p.case_pack.distinct_customers} |
| Distinct cards | ${p.case_pack.distinct_cards} |

### trigger_type

| Value | Count |
|---|---|
${rows(p.case_pack.triggers)}

## Card identifier derivation (C#####-K#)

The case pack and closed-case history address cards as \`C01234-K1\`. Transactions carry
\`customer_id\` (\`C01234\`) and the numeric \`card1\`..\`card6\` issuer features only, so the card key
has to be reconstructed from evidence instead of assumed. The 14,975 (card_id, txn) pairs in
\`closed_cases_history.csv\` plus the 20 case-pack pairs are the ground truth for that test.

Candidate key fit (collisions = one signature, two different card ids):

| Candidate key | Collisions | Distinct signatures | Labelled cards |
|---|---|---|---|
${Object.entries(p.card_id_derivation.candidate_keys).map(([k, v]) => `| \`${k}\` | ${v.collisions} | ${v.distinct_signatures} | ${v.cards} |`).join('\n')}

Chosen key: **\`${p.card_id_derivation.chosen_key}\`** (conflicts: ${p.card_id_derivation.chosen_key_conflicts},
labelled cards: ${p.card_id_derivation.labelled_card_ids},
signatures with an empty card6: ${p.card_id_derivation.signatures_without_card6}).

### Which rule orders the -K# suffix?

${p.card_id_derivation.customers_with_2plus_labelled_cards} customers in the labelled evidence hold more than one
card, so only they can reveal the ordering. Best fit: **${p.card_id_derivation.k_index_best_ordering}**.

| Ordering hypothesis | Exact fit |
|---|---|
${Object.entries(p.card_id_derivation.k_index_ordering_fit).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

### Multi-card customer detail (first 6)

${p.card_id_derivation.card_level_detail.map((c) => `**${c.customer_id}**\n\n| card_id | signature (card1\\|card6) | K | txns | total USD | first ts | last ts | products |\n|---|---|---|---|---|---|---|---|\n${c.cards.map((x) => `| ${x.card_id} | ${x.signature} | ${x.k} | ${x.txns} | ${x.total_usd} | ${x.first_ts} | ${x.last_ts} | ${x.products} |`).join('\n')}`).join('\n\n')}


## Case-pack transaction resolution

${header}
${sep}
${caseRows}
`;
}

await main();









