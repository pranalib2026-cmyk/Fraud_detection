import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function extract(pdfPath, outPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    let out = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        out += line.trimEnd() + '\n';
        line = '';
      }
      line += item.str;
      if (item.hasEOL) {
        out += line.trimEnd() + '\n';
        line = '';
      }
      lastY = y;
    }
    out += line;
    pages.push(`===== PAGE ${p} =====\n${out}`);
  }
  fs.writeFileSync(outPath, pages.join('\n\n'), 'utf8');
  console.log(`Wrote ${outPath} (${pages.length} pages)`);
}

const jobs = [
  ['C:/Users/Asus/Downloads/TigerGraph Agentic Fraud Investigation HHGOA.pdf', 'docs/source/challenge_brief.txt'],
  ['C:/Users/Asus/Downloads/TigerGraph_Agentic_Fraud_Investigation_Master_Requirements.pdf', 'docs/source/master_requirements.txt'],
];

for (const [src, dest] of jobs) {
  if (!fs.existsSync(src)) {
    console.warn(`missing ${src}`);
    continue;
  }
  const abs = path.resolve(dest);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await extract(src, abs);
}
