/**
 * Load a built projection and expose indexed access to it.
 *
 * All indexes are derived from the typed arrays at load time (counting sorts), so
 * queries stay O(window) instead of scanning 590k rows.
 */
import fs from 'node:fs';
import { PROJECTION_MAGIC } from './projection.js';

const ARRAY_LAYOUT: Array<[string, any]> = [
  ['txnIds', Int32Array],
  ['tsEpoch', Float64Array],
  ['amount', Float64Array],
  ['cardRef', Int32Array],
  ['regionRef', Int32Array],
  ['emailRef', Int32Array],
  ['recipientEmailRef', Int32Array],
  ['countryRef', Int32Array],
  ['identityIndex', Int32Array],
  ['product', Uint8Array],
  ['channel', Uint8Array],
  ['risk', Uint8Array],
];

function countingSortIndex(ref, counts) {
  const n = ref.length;
  const start = new Int32Array(counts + 1);
  for (let i = 0; i < n; i++) start[ref[i] + 1]++;
  for (let i = 0; i < counts; i++) start[i + 1] += start[i];
  const cursor = start.slice();
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[cursor[ref[i]]++] = i;
  return { order: out, start };
}

/** @param {string} file */
export function loadProjection(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(4);
    fs.readSync(fd, lenBuf, 0, 4, 0);
    const headerLen = lenBuf.readUInt32LE(0);
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 4);
    const meta = JSON.parse(headerBuf.toString('utf8'));
    if (meta.magic !== PROJECTION_MAGIC) throw new Error(`unexpected projection magic: ${meta.magic}`);

    let offset = 4 + headerLen;
    const arrays: any = {};
    for (const [name, Ctor] of ARRAY_LAYOUT) {
      const length = meta.counts.txns;
      const bytes = length * Ctor.BYTES_PER_ELEMENT;
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, offset);
      offset += bytes;
      arrays[name] = new Ctor(buf.buffer, buf.byteOffset, length);
    }

    const { txnIds, tsEpoch, amount, cardRef, regionRef, emailRef, recipientEmailRef, countryRef, identityIndex, product, channel, risk } = arrays;
    const n = meta.counts.txns;

    // transaction id -> row (dense when the ids form a contiguous range)
    const minId = meta.counts.txns ? txnIds[0] : 0;
    let denseFrom = null;
    {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        if (txnIds[i] < lo) lo = txnIds[i];
        if (txnIds[i] > hi) hi = txnIds[i];
      }
      if (hi - lo + 1 === n) denseFrom = lo;
    }
    const rowById = denseFrom === null ? new Map() : null;
    if (rowById) for (let i = 0; i < n; i++) rowById.set(txnIds[i], i);
    void minId;

    const byCard = countingSortIndex(cardRef, meta.counts.cards);
    const byRegion = countingSortIndex(regionRef, meta.counts.regions);
    const byEmail = countingSortIndex(emailRef, meta.counts.emails);
    const byRecipientEmail = countingSortIndex(recipientEmailRef, meta.counts.emails);
    // identityIndex is -1 for transactions with no identity record, so the sort
    // buckets are shifted by one: bucket 0 = no identity, bucket d+1 = device d.
    const byDevice = countingSortIndex(identityIndex, meta.counts.devices + 1);

    // time order (for windows, `NEXT` traversal and first/last per card)
    const byTime = new Int32Array(n);
    for (let i = 0; i < n; i++) byTime[i] = i;
    const timeOrder = Array.from(byTime).sort((a, b) => tsEpoch[a] - tsEpoch[b]);
    const byTimeSorted = Int32Array.from(timeOrder);

    const cardIndexByKey = new Map(meta.cards.map((c, i) => [c.key, i]));
    const cardIndexById = new Map();
    for (let i = 0; i < meta.cards.length; i++) {
      const c = meta.cards[i];
      if (c.card_id) {
        const list = cardIndexById.get(c.card_id) ?? [];
        list.push(i);
        cardIndexById.set(c.card_id, list);
      }
    }
    const regionIndexByValue = new Map(meta.regions.map((r, i) => [r, i]));
    const emailIndexByValue = new Map(meta.emails.map((e, i) => [e, i]));
    const deviceIndexById = new Map(meta.devices.map((d, i) => [d.device_id, i]));
    const countryIndexByValue = new Map(meta.countries.map((c, i) => [c, i]));

    const rowOf = (txnId) => {
      const id = typeof txnId === 'string' ? Number(txnId) : txnId;
      if (denseFrom !== null) {
        const row = id - denseFrom;
        return row >= 0 && row < n ? row : -1;
      }
      const row = rowById.get(id);
      return row === undefined ? -1 : row;
    };

    const cardRowsOf = (cardIdx) => byCard.order.subarray(byCard.start[cardIdx], byCard.start[cardIdx + 1]);

    return {
      meta,
      arrays,
      n,
      // row accessors
      txnId: (row) => txnIds[row],
      ts: (row) => tsEpoch[row],
      amount: (row) => amount[row],
      cardIdx: (row) => cardRef[row],
      regionIdx: (row) => regionRef[row],
      emailIdx: (row) => emailRef[row],
      recipientEmailIdx: (row) => recipientEmailRef[row],
      countryIdx: (row) => countryRef[row],
      deviceIdx: (row) => identityIndex[row],
      productIdx: (row) => product[row],
      channelIdx: (row) => channel[row],
      riskIdx: (row) => risk[row],
      rowOf,
      isDenseIdLookup: denseFrom !== null,
      card: (idx) => meta.cards[idx],
      region: (idx) => meta.regions[idx],
      email: (idx) => meta.emails[idx],
      country: (idx) => meta.countries[idx],
      device: (idx) => meta.devices[idx],
      indexes: {
        byCard, byRegion, byEmail, byRecipientEmail, byDevice, byTime: byTimeSorted,
        cardIndexByKey, cardIndexById, regionIndexByValue, emailIndexByValue,
        deviceIndexById, countryIndexByValue,
      },
      rowsOfCardIdx: cardRowsOf,
      rowsOfRegionIdx: (idx) => byRegion.order.subarray(byRegion.start[idx], byRegion.start[idx + 1]),
      rowsOfEmailIdx: (idx) => byEmail.order.subarray(byEmail.start[idx], byEmail.start[idx + 1]),
      rowsOfRecipientEmailIdx: (idx) => byRecipientEmail.order.subarray(byRecipientEmail.start[idx], byRecipientEmail.start[idx + 1]),
      rowsOfDeviceIdx: (idx) => byDevice.order.subarray(byDevice.start[idx + 1], byDevice.start[idx + 2]),
    };
  } finally {
    fs.closeSync(fd);
  }
}
