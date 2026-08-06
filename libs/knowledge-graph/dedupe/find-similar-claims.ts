import { cosineSimilarity } from "../graph-context/vector.js";

export interface ClaimEmbeddingCandidate {
  claim_id: string;
  vector: Float32Array;
}

export interface SimilarClaimMatch {
  claim_id: string;
  similarity: number;
}

export function findSimilarClaims(
  candidateVector: Float32Array,
  existing: ClaimEmbeddingCandidate[],
  threshold: number,
): SimilarClaimMatch[] {
  const matches: SimilarClaimMatch[] = [];
  for (const item of existing) {
    const similarity = cosineSimilarity(candidateVector, item.vector);
    if (similarity >= threshold) {
      matches.push({ claim_id: item.claim_id, similarity });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity);
}
