import type { GraphContextConfig } from "./config.js";
import type { ContextDocument } from "./documents.js";

export interface ScoreEntry {
  id: string;
  score: number;
  raw_score: number;
  rank: number;
}

export function scoreBm25(query: string, documents: ContextDocument[], config: GraphContextConfig): ScoreEntry[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || documents.length === 0) return [];

  const tokenized = documents.map((document) => ({
    id: document.key,
    tokens: tokenize(document.text),
  }));
  const avgDocLength = tokenized.reduce((sum, document) => sum + document.tokens.length, 0) / tokenized.length || 1;
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const documentFrequency = new Map<string, number>();

  for (const token of uniqueQueryTokens) {
    documentFrequency.set(token, tokenized.filter((document) => document.tokens.includes(token)).length);
  }

  const scored = tokenized
    .map((document) => {
      let score = 0;
      for (const token of queryTokens) {
        const tf = document.tokens.filter((candidate) => candidate === token).length;
        if (tf === 0) continue;
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log((tokenized.length - df + 0.5) / (df + 0.5) + 1);
        const { k1, b } = config.ranking.bm25;
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * document.tokens.length) / avgDocLength));
      }
      return { id: document.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const maxScore = scored[0]?.score ?? 1;
  return scored.map((entry, index) => ({
    id: entry.id,
    score: entry.score / maxScore,
    raw_score: entry.score,
    rank: index + 1,
  }));
}

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return tokens.flatMap((token) => [token, ...tokenVariants(token)]);
}

function tokenVariants(token: string): string[] {
  if (!/^[a-z]+$/.test(token)) return [];
  const variants: string[] = [];
  if (token.endsWith("ing") && token.length > 5) variants.push(token.slice(0, -3));
  if (token.endsWith("ed") && token.length > 4) variants.push(token.slice(0, -2));
  if (token.endsWith("es") && token.length > 4) variants.push(token.slice(0, -2));
  if (token.endsWith("s") && token.length > 3) variants.push(token.slice(0, -1));
  if (token.endsWith("ation") && token.length > 7) variants.push(`${token.slice(0, -5)}e`);
  return variants.filter((variant) => variant.length > 1 && variant !== token);
}
