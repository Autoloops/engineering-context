import type { GraphContextConfig } from "./config.js";
import type { ScoreEntry } from "./bm25.js";
import type { ContextDocument } from "./documents.js";
import type { ContextSignals } from "./types.js";

export interface SemanticScoreEntry extends ScoreEntry {}

export interface RankedContextDocument {
  document: ContextDocument;
  score: number;
  signals: ContextSignals;
}

export function rankContextDocuments(
  documents: ContextDocument[],
  semantic: SemanticScoreEntry[],
  bm25: ScoreEntry[],
  config: GraphContextConfig,
): RankedContextDocument[] {
  const semanticById = indexScores(semantic);
  const bm25ById = indexScores(bm25);

  const ranked = documents
    .map((document) => {
      const semanticScore = semanticById.get(document.key);
      const bm25Score = bm25ById.get(document.key);
      const semanticValue = semanticScore?.score ?? 0;
      const semanticRawValue = semanticScore?.raw_score ?? 0;
      const bm25Value = bm25Score?.score ?? 0;
      const bm25RawValue = bm25Score?.raw_score ?? 0;

      const weighted =
        semanticValue * config.ranking.weights.semantic +
        bm25Value * config.ranking.weights.bm25;
      const weightedRaw =
        semanticRawValue * config.ranking.weights.semantic +
        bm25RawValue * config.ranking.weights.bm25;
      const divisor =
        config.ranking.weights.semantic +
        config.ranking.weights.bm25;

      return {
        document,
        score: weighted / divisor,
        signals: {
          semantic_score: semanticValue,
          semantic_raw_score: semanticRawValue,
          semantic_rank: semanticScore?.rank ?? null,
          bm25_score: bm25Value,
          bm25_raw_score: bm25RawValue,
          bm25_rank: bm25Score?.rank ?? null,
          weighted_score: weighted / divisor,
          weighted_raw_score: weightedRaw / divisor,
          pre_coherence_score: 0,
          graph_score: 0,
          graph_raw_score: 0,
          graph_sources: [] as ContextSignals["graph_sources"],
          coherence_score: 0,
          coherence_raw_score: 0,
          coherence_sources: [] as ContextSignals["coherence_sources"],
        },
      };
    })
    .filter((candidate): candidate is RankedContextDocument => candidate !== undefined)
    .sort((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key));

  const maxScore = ranked[0]?.score ?? 1;
  return ranked.map((candidate) => ({
    ...candidate,
    score: maxScore === 0 ? 0 : candidate.score / maxScore,
  }));
}

export function selectRankedDocuments(
  ranked: RankedContextDocument[],
  config: GraphContextConfig,
  options: { minimumSelected?: number } = {},
): RankedContextDocument[] {
  return ranked.filter(
    (document, index) =>
      index < (options.minimumSelected ?? 0) ||
      document.score >= config.ranking.selectionThreshold,
  );
}

export function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function indexScores(scores: ScoreEntry[]): Map<string, ScoreEntry> {
  return new Map(scores.map((score) => [score.id, score]));
}
