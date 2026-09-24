/**
 * CSV utilities for the supplied dataset.
 *
 * `transactions.csv` is 708 MB and has no quoted fields, so hot paths use the
 * field-slicing helpers. `closed_cases_history.csv` does contain quoted fields
 * with embedded commas, so full parsing uses the record parser.
 */
import fs from 'node:fs';
import readline from 'node:readline';

/** Parse a complete CSV text into records (RFC4180 style, quoted fields supported). */
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Read a CSV file as objects keyed by its header row. */
export function readCsvFile(file) {
  const rows = parseCsvText(fs.readFileSync(file, 'utf8'));
  const header = rows[0] ?? [];
  return rows.slice(1).filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Read only the header row of a large file. */
export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 16);
  const read = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return buf.subarray(0, read).toString('utf8').split('\n')[0].split(',').map((s) => s.trim());
}

/** First n comma-separated fields of a raw line. */
export function firstFields(line, n) {
  const out = [];
  let start = 0;
  for (let i = 0; i < line.length && out.length < n; i++) {
    if (line[i] === ',') { out.push(line.slice(start, i)); start = i + 1; }
  }
  if (out.length < n) out.push(line.slice(start));
  return out;
}

/** Last n comma-separated fields of a raw line. */
export function lastFields(line, n) {
  const out = [];
  let end = line.length;
  for (let i = line.length - 1; i >= 0 && out.length < n; i--) {
    if (line[i] === ',') { out.push(line.slice(i + 1, end)); end = i; }
  }
  if (out.length < n) out.push(line.slice(0, end));
  return out.reverse();
}

/** Stream a file line by line, skipping the header. */
export async function streamCsv(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let first = true;
  await new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      if (first) { first = false; return; }
      if (line.length) onRow(line);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

export const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
