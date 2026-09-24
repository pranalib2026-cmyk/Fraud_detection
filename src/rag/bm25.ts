/** @module rag/bm25 — Tiny dependency-free BM25 index over document chunks. */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'is', 'are', 'be', 'this', 'that', 'with', 'as', 'at', 'by', 'it', 'from']);

export function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_$|.]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface Bm25Hit { index: number; score: number; }

export class Bm25Index {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private avgLen = 1;
  private n = 0;
  private k1 = 1.2;
  private b = 0.75;

  constructor(documents: string[]) {
    this.n = documents.length;
    documents.forEach((text, i) => {
      const tokens = tokenize(text);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.len.push(tokens.length || 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    });
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / (this.n || 1);
  }

  search(query: string, k = 3): Bm25Hit[] {
    const tokens = tokenize(query);
    const hits: Bm25Hit[] = [];
    for (let i = 0; i < this.n; i++) {
      let score = 0;
      for (const t of tokens) {
        const tf = this.tf[i].get(t);
        if (!tf) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgLen));
        score += idf * norm;
      }
      if (score > 0) hits.push({ index: i, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
