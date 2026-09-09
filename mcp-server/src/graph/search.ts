/**
 * Hybrid screen search: BM25 over words, cosine over embeddings, fused.
 *
 * Neither half is sufficient alone. Lexical search cannot connect «оплата» to a
 * screen whose only English label is "Checkout", and vector search happily
 * returns something thematically adjacent when the user typed an exact component
 * name they already know. Fusing them covers both, and — importantly — the
 * lexical half still works when Ollama is not installed.
 *
 * Fusion is reciprocal rank, not score averaging: BM25 scores and cosine
 * similarities live on incomparable scales, and normalising them invents a
 * relationship that is not there. Ranks are the honest common currency.
 */

import { dot } from './ollama.js';
import { ScreenRecord } from './types.js';

/** Unicode-aware: this index has to work on Cyrillic screen text, not just ASCII. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/** What a screen is searchable by. Name first: it is short and often the answer. */
export function screenDocument(screen: ScreenRecord): string {
  return [screen.name, screen.path, screen.componentNames.join(' '), screen.text].filter(Boolean).join('\n');
}

interface LexicalIndex {
  postings: Map<string, Map<number, number>>;
  lengths: number[];
  averageLength: number;
  documentCount: number;
}

export function buildLexicalIndex(screens: ScreenRecord[]): LexicalIndex {
  const postings = new Map<string, Map<number, number>>();
  const lengths: number[] = [];
  let total = 0;

  screens.forEach((screen, index) => {
    const tokens = tokenize(screenDocument(screen));
    lengths[index] = tokens.length;
    total += tokens.length;
    for (const token of tokens) {
      let row = postings.get(token);
      if (!row) {
        row = new Map<number, number>();
        postings.set(token, row);
      }
      row.set(index, (row.get(index) ?? 0) + 1);
    }
  });

  return {
    postings,
    lengths,
    averageLength: screens.length ? total / screens.length : 0,
    documentCount: screens.length,
  };
}

const K1 = 1.2;
const B = 0.75;

export function lexicalSearch(index: LexicalIndex, query: string, limit: number): { index: number; score: number }[] {
  const tokens = tokenize(query);
  if (!tokens.length || !index.documentCount) return [];

  const scores = new Map<number, number>();
  for (const token of tokens) {
    const postings = index.postings.get(token);
    if (!postings) continue;
    const idf = Math.log(1 + (index.documentCount - postings.size + 0.5) / (postings.size + 0.5));

    for (const [document, frequency] of postings) {
      const length = index.lengths[document] || 1;
      const denominator = frequency + K1 * (1 - B + (B * length) / (index.averageLength || 1));
      scores.set(document, (scores.get(document) ?? 0) + (idf * (frequency * (K1 + 1))) / denominator);
    }
  }

  return [...scores]
    .map(([documentIndex, score]) => ({ index: documentIndex, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function vectorSearch(vectors: Float32Array[], query: Float32Array, limit: number): { index: number; score: number }[] {
  const scored: { index: number; score: number }[] = [];
  for (let i = 0; i < vectors.length; i++) scored.push({ index: i, score: dot(vectors[i], query) });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface FusedHit {
  index: number;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
}

/**
 * Reciprocal rank fusion. `k` damps the top of each list so one confident
 * ranker cannot completely dictate the result; 60 is the value the original
 * paper settled on and it holds up here.
 */
export function fuse(
  lexical: { index: number; score: number }[],
  vector: { index: number; score: number }[],
  limit: number,
  k = 60
): FusedHit[] {
  const rows = new Map<number, FusedHit>();

  const record = (
    list: { index: number; score: number }[],
    field: 'lexical' | 'vector'
  ) => {
    list.forEach((entry, rank) => {
      const row =
        rows.get(entry.index) ??
        { index: entry.index, score: 0, lexicalRank: null, vectorRank: null, lexicalScore: null, vectorScore: null };
      row.score += 1 / (k + rank + 1);
      if (field === 'lexical') {
        row.lexicalRank = rank + 1;
        row.lexicalScore = entry.score;
      } else {
        row.vectorRank = rank + 1;
        row.vectorScore = entry.score;
      }
      rows.set(entry.index, row);
    });
  };

  record(lexical, 'lexical');
  record(vector, 'vector');

  return [...rows.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
