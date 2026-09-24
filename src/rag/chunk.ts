/** @module rag/chunk — Section-aware markdown chunking with provenance. */

export interface DocSection { heading: string; path: string; body: string; ordinal: number; }
export interface DocChunk {
  document: string;
  document_title: string;
  section: string;
  chunk_id: string;
  ordinal: number;
  text: string;
}

/** Split markdown on heading boundaries, tracking the heading path for provenance. */
export function splitSections(markdown: string, docId: string): DocSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: DocSection[] = [];
  let path: string[] = [docId];
  let current: DocSection = { heading: docId, path: docId, body: '', ordinal: 0 };
  const push = () => { sections.push(current); };
  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      push();
      const level = m[1].length;
      const heading = m[2].trim();
      path = path.slice(0, Math.max(0, level - 1));
      path.push(heading);
      current = { heading, path: path.join(' > '), body: '', ordinal: sections.length };
      continue;
    }
    current.body += `${line}\n`;
  }
  push();
  return sections.filter((s) => s.body.trim().length > 0);
}

/** Chunk one section into paragraph groups no larger than `maxChars`. */
export function chunkSection(section: DocSection, docId: string, docTitle: string, maxChars = 1200): DocChunk[] {
  const paras = section.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: DocChunk[] = [];
  let buf = '';
  let idx = 0;
  const flush = () => {
    if (!buf.trim()) { buf = ''; return; }
    chunks.push({
      document: docId,
      document_title: docTitle,
      section: section.path,
      chunk_id: `${docId}#${section.ordinal}.${idx}`,
      ordinal: chunks.length,
      text: buf.trim(),
    });
    idx++;
    buf = '';
  };
  for (const p of paras) {
    if ((buf + p).length > maxChars && buf) flush();
    buf += `${p}\n\n`;
  }
  flush();
  return chunks;
}

export function chunkDocument(markdown: string, docId: string, docTitle: string): DocChunk[] {
  return splitSections(markdown, docId).flatMap((s) => chunkSection(s, docId, docTitle));
}
