/** @module rag/index — Document-side GraphRAG retrieval (local BM25; no external service).
 *
 * Loads the challenge README (fraud policy, patterns, SAR guidance), optional extra
 * documents from DOCUMENT_RAG_PATH and corpus/*.md, chunks them with section provenance
 * and serves top-k retrieval. Each result carries document/section/chunk_id/relevance so
 * the reasoning context can label it DOCUMENT evidence distinctly from GRAPH evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ragConfig } from '../config.js';
import { chunkDocument, type DocChunk } from './chunk.js';
import { Bm25Index } from './bm25.js';

export type { DocChunk } from './chunk.js';
export { splitSections, chunkDocument } from './chunk.js';

export interface RetrievedChunk extends DocChunk {
  relevance: number;
}

interface SourceDoc { id: string; title: string; file: string; }

function sourceDocs(): SourceDoc[] {
  const docs: SourceDoc[] = [];
  const readme = path.join(paths.raw, 'README.md');
  if (fs.existsSync(readme)) docs.push({ id: 'hhgoa_readme', title: 'HHGOA dataset & fraud policy README', file: readme });
  const extra = ragConfig().extraPath;
  if (extra && fs.existsSync(extra)) docs.push({ id: path.basename(extra), title: path.basename(extra), file: extra });
  if (fs.existsSync(paths.corpus)) {
    for (const f of fs.readdirSync(paths.corpus)) {
      if (f.endsWith('.md')) docs.push({ id: f.replace(/\.md$/, ''), title: f, file: path.join(paths.corpus, f) });
    }
  }
  return docs;
}

export class RagIndex {
  chunks: DocChunk[] = [];
  private bm25: Bm25Index | null = null;
  sources: string[] = [];

  constructor() {
    this.rebuild();
  }

  rebuild(): void {
    this.chunks = [];
    this.sources = [];
    for (const src of sourceDocs()) {
      try {
        const text = fs.readFileSync(src.file, 'utf8');
        this.chunks.push(...chunkDocument(text, src.id, src.title));
        this.sources.push(src.file);
      } catch { /* unreadable source: skip, never fabricate content */ }
    }
    this.bm25 = new Bm25Index(this.chunks.map((c) => `${c.section} ${c.text}`));
  }

  get ready(): boolean { return this.chunks.length > 0; }
  get documentCount(): number { return this.sources.length; }
  get chunkCount(): number { return this.chunks.length; }

  retrieve(query: string, k = 3): RetrievedChunk[] {
    if (!this.bm25 || !this.chunks.length) return [];
    const maxScore = Math.max(...this.bm25.search(query, k).map((h) => h.score), 1e-9);
    return this.bm25.search(query, k)
      .filter((h) => h.score > 0)
      .map((h) => ({ ...this.chunks[h.index], relevance: Number((h.score / maxScore).toFixed(3)) }));
  }
}

let singleton: RagIndex | null = null;

export function getRag(): RagIndex {
  if (!singleton) singleton = new RagIndex();
  return singleton;
}
