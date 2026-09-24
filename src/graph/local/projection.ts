/**
 * Compact columnar projection of the dataset, used by the local graph backend.
 *
 * The raw `transactions.csv` is 708 MB; TigerGraph is the intended home for the full
 * graph. The projection stores only what investigations need (identity, time, amount,
 * channel, product, risk score and entity references) in typed arrays so queries can
 * run in-process when a TigerGraph deployment is not reachable.
 *
 * It is derived data: rebuilt from the raw CSVs by `npm run build-graph`.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { firstFields, readCsvFile, readHeader, streamCsv, num } from '../../dataset/csv.js';
import { TXN_TAIL, cardKey, derivedKIndex, deviceProfileId } from '../../dataset/schema-map.js';

export const PROJECTION_MAGIC = 'HHGOA-PROJ-1';

const PRODUCT_CODES = ['W', 'C', 'H', 'R', 'S'];

export const CHANNEL = { IN_PERSON: 0, ONLINE: 1 };
export const PRODUCT = Object.fromEntries(PRODUCT_CODES.map((p, i) => [p, i]));
export const PRODUCT_BY_INDEX = PRODUCT_CODES;

export const projectionPath = (dataRoot) => path.join(dataRoot, 'derived', 'projection.bin');

async function countRows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const _line of rl) n++;
  return n - 1;
}

/**
 * Build the projection from the raw dataset.
 * @param {{ rawDir: string, outFile: string, onProgress?: (msg: string) => void }} opts
 */
export async function buildProjection({ rawDir, outFile, onProgress = (_msg: string) => {} }) {
  const txnFile = path.join(rawDir, 'transactions.csv');
  const identityFile = path.join(rawDir, 'identity.csv');

  const header = readHeader(txnFile);
  const tail = header.slice(-4);
  if (tail.join(',') !== TXN_TAIL.join(',')) {
    throw new Error(`transactions.csv tail columns changed: ${tail.join(',')}`);
  }
  const idx = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing expected column ${name}`);
    return i;
  };
  const pos = {
    id: idx('TransactionID'), amt: idx('TransactionAmt'), product: idx('ProductCD'),
    card1: idx('card1'), card4: idx('card4'), card6: idx('card6'),
    addr1: idx('addr1'), addr2: idx('addr2'), pemail: idx('P_emaildomain'),
    remail: idx('R_emaildomain'), cust: idx('customer_id'), ts: idx('ts'),
    channel: idx('channel'), risk: idx('risk_score'),
  };

  // ---------------------------------------------------------------- identity
  onProgress('reading identity.csv');
  const idHeader = readHeader(identityFile);
  const idPos = {
    txn: idHeader.indexOf('TransactionID'),
    deviceType: idHeader.indexOf('DeviceType'),
    deviceInfo: idHeader.indexOf('DeviceInfo'),
    os: idHeader.indexOf('id_30'),
    browser: idHeader.indexOf('id_31'),
    screen: idHeader.indexOf('id_33'),
    novelty: idHeader.indexOf('id_15'),
    proxy: idHeader.indexOf('id_23'),
    match: idHeader.indexOf('id_34'),
  };
  const identityByTxn = new Map();
  await streamCsv(identityFile, (line) => {
    const f = firstFields(line, idHeader.length);
    const deviceInfo = f[idPos.deviceInfo] ?? '';
    const os = f[idPos.os] ?? '';
    const browser = f[idPos.browser] ?? '';
    const screen = f[idPos.screen] ?? '';
    if (!deviceInfo && !os && !browser && !screen) return;
    identityByTxn.set(num(f[idPos.txn], -1), {
      device_id: deviceProfileId({ deviceInfo, os, browser, screen }),
      device_type: f[idPos.deviceType] ?? '',
      device_info: deviceInfo, os, browser, screen,
      device_new_or_found: f[idPos.novelty] ?? '',
      proxy: f[idPos.proxy] ?? '',
      match_status: f[idPos.match] ?? '',
    });
  });
  onProgress(`identity records with device details: ${identityByTxn.size}`);

  // ------------------------------------------- labelled evidence for card ids
  const closed = readCsvFile(path.join(rawDir, 'closed_cases_history.csv'));
  const pack = readCsvFile(path.join(rawDir, 'case_pack.csv'));
  const labelByTxn = new Map();
  for (const r of closed) {
    for (const t of String(r.txn_ids || '').split('|')) {
      if (t.trim()) labelByTxn.set(Number(t.trim()), r.card_id);
    }
  }
  for (const r of pack) labelByTxn.set(Number(r.flagged_txn_id), r.card_id);

  // -------------------------------------------------------------- transactions
  onProgress('scanning transactions.csv');
  const n = await countRows(txnFile);
  const txnIds = new Int32Array(n);
  const tsEpoch = new Float64Array(n);
  const amount = new Float64Array(n);
  const cardRef = new Int32Array(n);
  const regionRef = new Int32Array(n);
  const emailRef = new Int32Array(n);
  const recipientEmailRef = new Int32Array(n);
  const countryRef = new Int32Array(n);
  const identityIndex = new Int32Array(n);
  const product = new Uint8Array(n);
  const channel = new Uint8Array(n);
  const risk = new Uint8Array(n);

  const cardList = [];
  const cardIndexByKey = new Map();
  const regionList = [];
  const regionIndex = new Map();
  const emailList = [];
  const emailIndex = new Map();
  const countryList = [];
  const countryIndex = new Map();
  const identityList = [];
  const identityIndexByKey = new Map();
  const cardLabel = new Map();
  let rows = 0;

  await streamCsv(txnFile, (line) => {
    const f = firstFields(line, pos.channel + 1);
    const id = num(f[pos.id], -1);
    const ts = f[pos.ts];
    const c1 = f[pos.card1] ?? '';
    const c6 = f[pos.card6] ?? '';
    const key = cardKey(c1, c6);
    let ci = cardIndexByKey.get(key);
    if (ci === undefined) {
      ci = cardList.length;
      cardIndexByKey.set(key, ci);
      cardList.push({ key, card1: c1, card6: c6, card4: f[pos.card4] ?? '', customer_id: f[pos.cust] ?? '' });
    }
    const label = labelByTxn.get(id);
    if (label) cardLabel.set(key, label);

    const region = f[pos.addr1] ?? '';
    let ri = regionIndex.get(region);
    if (ri === undefined) { ri = regionList.length; regionIndex.set(region, ri); regionList.push(region); }

    const email = (f[pos.pemail] ?? '').toLowerCase();
    let ei = emailIndex.get(email);
    if (ei === undefined) { ei = emailList.length; emailIndex.set(email, ei); emailList.push(email); }

    const remail = (f[pos.remail] ?? '').toLowerCase();
    let rei = emailIndex.get(remail);
    if (rei === undefined) { rei = emailList.length; emailIndex.set(remail, rei); emailList.push(remail); }

    const country = f[pos.addr2] ?? '';
    let coi = countryIndex.get(country);
    if (coi === undefined) { coi = countryList.length; countryIndex.set(country, coi); countryList.push(country); }

    let ii = -1;
    const ident = identityByTxn.get(id);
    if (ident) {
      let ui = identityIndexByKey.get(ident.device_id);
      if (ui === undefined) {
        ui = identityList.length;
        identityIndexByKey.set(ident.device_id, ui);
        identityList.push(ident);
      }
      ii = ui;
    }

    txnIds[rows] = id;
    tsEpoch[rows] = Date.parse(`${ts.replace(' ', 'T')}Z`);
    amount[rows] = Number(f[pos.amt]) || 0;
    cardRef[rows] = ci;
    regionRef[rows] = ri;
    emailRef[rows] = ei;
    recipientEmailRef[rows] = rei;
    countryRef[rows] = coi;
    identityIndex[rows] = ii;
    product[rows] = PRODUCT[f[pos.product]] ?? 255;
    channel[rows] = f[pos.channel] === 'online' ? CHANNEL.ONLINE : CHANNEL.IN_PERSON;
    const r = f[pos.risk];
    risk[rows] = r === '' || r === undefined ? 255 : Math.round(Number(r) * 100);
    rows++;
  });
  if (rows !== n) throw new Error(`row count mismatch: counted ${n}, read ${rows}`);

  // ------------------------------------------------------- card labels + ranks
  onProgress('deriving card labels');
  const cardsByCustomer = new Map();
  for (let i = 0; i < cardList.length; i++) {
    const c = cardList[i];
    const list = cardsByCustomer.get(c.customer_id) ?? [];
    list.push(i);
    cardsByCustomer.set(c.customer_id, list);
  }
  let explicitLabels = 0;
  let derivedLabels = 0;
  let mismatch = 0;
  for (const [customerId, idxs] of cardsByCustomer) {
    const card6Values = idxs.map((i) => cardList[i].card6);
    for (const i of idxs) {
      const c = cardList[i];
      const explicit = cardLabel.get(c.key);
      const rank = derivedKIndex(c.card6, card6Values);
      const derived = `${customerId}-K${rank}`;
      if (explicit) {
        c.card_id = explicit;
        c.label_source = 'labelled_evidence';
        explicitLabels++;
        if (explicit !== derived) mismatch++;
      } else {
        c.card_id = derived;
        c.label_source = 'derived_card6_rank';
        derivedLabels++;
      }
      c.k_index = Number(String(c.card_id).split('-K')[1] ?? rank);
    }
  }

  // ------------------------------------------------------------------- write
  onProgress(`writing ${outFile}`);
  const meta = {
    magic: PROJECTION_MAGIC,
    built_at: new Date().toISOString(),
    source: { raw_dir: rawDir, txn_rows: rows },
    counts: {
      txns: rows, cards: cardList.length, regions: regionList.length,
      emails: emailList.length, countries: countryList.length, devices: identityList.length,
    },
    card_label_fit: {
      explicit_labels: explicitLabels, derived_labels: derivedLabels,
      explicit_vs_derived_mismatch: mismatch,
    },
    cards: cardList,
    regions: regionList,
    emails: emailList,
    countries: countryList,
    devices: identityList,
  };
  const arrays: Array<[string, any]> = [
    ['txnIds', txnIds], ['tsEpoch', tsEpoch], ['amount', amount], ['cardRef', cardRef],
    ['regionRef', regionRef], ['emailRef', emailRef], ['recipientEmailRef', recipientEmailRef],
    ['countryRef', countryRef], ['identityIndex', identityIndex],
    ['product', product], ['channel', channel], ['risk', risk],
  ];

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');
  const headerJson = Buffer.from(JSON.stringify(meta), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerJson.length, 0);
  fs.writeSync(fd, lenBuf);
  fs.writeSync(fd, headerJson);
  for (const [, arr] of arrays) {
    fs.writeSync(fd, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  fs.closeSync(fd);

  return {
    file: outFile,
    txns: rows,
    cards: cardList.length,
    devices: identityList.length,
    identity_records: identityByTxn.size,
    card_label_fit: meta.card_label_fit,
  };
}
