import type { Claim } from "./claim.js";
import type { MemoryCommitProposal } from "./proposal.js";
import type { GraphReadResult } from "./service.js";
import type { GraphObjectEmbeddingRecord, SqliteRepository } from "../storage/sqlite/repository.js";
import { buildClaimDocuments, contextDocumentKey, type ContextDocument } from "./graph-context/documents.js";
import { createEmbedder, type Embedder } from "./graph-context/embedder.js";
import type { GraphContextConfig } from "./graph-context/config.js";
import { bufferToFloat32Array, cosineSimilarity } from "./graph-context/vector.js";

export interface SimilarClaimMatch {
  claim_id: string;
  claim_text: string;
  matched_claim_id: string;
  matched_claim_text: string;
  score: number;
  threshold: number;
}

export interface FindSimilarClaimsInput {
  repo_id: string;
  graph: GraphReadResult;
  creates: MemoryCommitProposal["creates"];
  repository: Pick<SqliteRepository, "listGraphObjectEmbeddings">;
  config: GraphContextConfig;
  embedder?: Pick<Embedder, "embedBatch">;
}

export async function findSimilarClaims(input: FindSimilarClaimsInput): Promise<SimilarClaimMatch[]> {
  const incomingClaims = input.creates.claims ?? [];
  if (incomingClaims.length === 0 || input.graph.claims.length === 0) return [];

  const threshold = input.config.similarClaims.threshold;
  const maxMatchesPerClaim = Math.max(1, input.config.similarClaims.maxMatchesPerClaim);
  const existingDocuments = buildClaimDocuments(input.graph);
  const incomingDocuments = buildIncomingClaimDocuments(input.graph, input.creates, incomingClaims);
  const embedder = input.embedder ?? createEmbedder(input.config.embedding);

  // Embed candidate claims before any proposal records are written. Existing
  // persisted claim embeddings are reused when available; missing existing
  // vectors are embedded transiently so the check still works on older graphs.
  const incomingVectors = await embedDocuments(incomingDocuments, embedder);
  const existingVectors = await existingClaimVectors({
    repoId: input.repo_id,
    documents: existingDocuments,
    repository: input.repository,
    config: input.config,
    embedder,
  });

  const existingClaimById = new Map(input.graph.claims.map((claim) => [claim.id, claim]));
  const matches: SimilarClaimMatch[] = [];

  for (const incomingDocument of incomingDocuments) {
    const incomingVector = incomingVectors.get(incomingDocument.key);
    if (incomingVector === undefined) continue;

    const claimMatches = existingDocuments
      .flatMap((existingDocument): SimilarClaimMatch[] => {
        const existingVector = existingVectors.get(existingDocument.key);
        if (existingVector === undefined) return [];
        const score = cosineSimilarity(incomingVector, existingVector);
        if (score < threshold) return [];

        const matchedClaim = existingClaimById.get(existingDocument.id);
        return [{
          claim_id: incomingDocument.id,
          claim_text: (incomingDocument.object as Claim).text,
          matched_claim_id: existingDocument.id,
          matched_claim_text: matchedClaim?.text ?? (existingDocument.object as Claim).text,
          score,
          threshold,
        }];
      })
      .sort((left, right) => right.score - left.score || left.matched_claim_id.localeCompare(right.matched_claim_id))
      .slice(0, maxMatchesPerClaim);

    matches.push(...claimMatches);
  }

  return matches.sort((left, right) =>
    left.claim_id.localeCompare(right.claim_id) ||
    right.score - left.score ||
    left.matched_claim_id.localeCompare(right.matched_claim_id),
  );
}

export function similarClaimWarning(match: SimilarClaimMatch): string {
  return `${match.claim_id} is similar to existing ${match.matched_claim_id} ` +
    `(score ${formatScore(match.score)} >= ${formatScore(match.threshold)}). ` +
    `Consider adding supersedes: "${match.matched_claim_id}" instead of creating a fresh duplicate claim.`;
}

function buildIncomingClaimDocuments(
  graph: GraphReadResult,
  creates: MemoryCommitProposal["creates"],
  incomingClaims: Claim[],
): ContextDocument[] {
  return buildClaimDocuments({
    components: mergeById(graph.components, creates.components ?? []),
    flows: mergeById(graph.flows, creates.flows ?? []),
    claims: incomingClaims,
    sources: graph.sources,
    edges: [...graph.edges, ...(creates.edges ?? [])],
  });
}

async function existingClaimVectors(input: {
  repoId: string;
  documents: ContextDocument[];
  repository: Pick<SqliteRepository, "listGraphObjectEmbeddings">;
  config: GraphContextConfig;
  embedder: Pick<Embedder, "embedBatch">;
}): Promise<Map<string, ArrayLike<number>>> {
  const stored = new Map(
    input.repository
      .listGraphObjectEmbeddings({
        repo_id: input.repoId,
        provider: input.config.embedding.provider,
        model: input.config.embedding.model,
        dimensions: input.config.embedding.dimensions,
      })
      .filter((record) => record.object_type === "claim")
      .map((record) => [contextDocumentKey(record.object_type, record.object_id), record]),
  );

  const vectors = new Map<string, ArrayLike<number>>();
  const missing: ContextDocument[] = [];
  for (const document of input.documents) {
    const embedding = stored.get(document.key);
    if (embedding === undefined) {
      missing.push(document);
    } else {
      vectors.set(document.key, embeddingVector(embedding));
    }
  }

  for (const [key, vector] of await embedDocuments(missing, input.embedder)) {
    vectors.set(key, vector);
  }

  return vectors;
}

async function embedDocuments(
  documents: ContextDocument[],
  embedder: Pick<Embedder, "embedBatch">,
): Promise<Map<string, ArrayLike<number>>> {
  const vectors = await embedder.embedBatch(documents.map((document) => document.text));
  return new Map(documents.map((document, index) => [document.key, vectors[index] ?? []]));
}

function embeddingVector(record: GraphObjectEmbeddingRecord): Float32Array {
  return bufferToFloat32Array(record.embedding);
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  const merged = new Map(left.map((item) => [item.id, item]));
  for (const item of right) merged.set(item.id, item);
  return [...merged.values()];
}

function formatScore(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}
