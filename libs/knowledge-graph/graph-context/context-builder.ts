import type { Claim } from "../claim.js";
import type { GraphReadResult } from "../service.js";
import type { Component, Flow, Source } from "../schema.js";
import type { SqliteRepository } from "../../storage/sqlite/repository.js";
import { graphContextConfig, type GraphContextConfig } from "./config.js";
import {
  buildClaimDocuments,
  buildComponentDocuments,
  buildFlowDocuments,
  contextDocumentKey,
  type ContextDocument,
} from "./documents.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { float32ArrayToBuffer, bufferToFloat32Array, cosineSimilarity } from "./vector.js";
import { scoreBm25 } from "./bm25.js";
import { applyGraphRanking } from "./graph-rank.js";
import { rankContextDocuments, roundScore, selectRankedDocuments, type RankedContextDocument, type SemanticScoreEntry } from "./rank.js";
import type { ClaimContextResult, ClaimEvidenceResult, ComponentContextResult, EmbeddingStatus, FlowContextResult, GraphContextResult, RankedContextDebugResult } from "./types.js";
import { rankPacketResults, roundRankedSignals, selectGraphObjects } from "./packet-rank.js";
import { CodeAnchorResolver } from "../code-anchors/resolver.js";
import type { ResolvedCodeAnchor } from "../code-anchors/types.js";

export interface BuildGraphContextOptions {
  warnOnCreatedEmbeddings?: boolean;
  config?: GraphContextConfig;
  repoRoot?: string;
  resolveCodeAnchors?: boolean;
}

interface ExistingEmbedding {
  key: string;
  vector: Float32Array;
}

export class GraphContextBuilder {
  private readonly codeAnchorResolver = new CodeAnchorResolver();

  constructor(private readonly repository?: SqliteRepository) {}

  async build(repoId: string, graph: GraphReadResult, query: string, options: BuildGraphContextOptions = {}): Promise<GraphContextResult> {
    const config = options.config ?? graphContextConfig;
    const claimDocuments = buildClaimDocuments(graph);
    const componentDocuments = buildComponentDocuments(graph);
    const flowDocuments = buildFlowDocuments(graph);
    const evidenceByClaim = buildEvidenceByClaim(graph);
    const documents = [...claimDocuments, ...componentDocuments, ...flowDocuments];
    const embedder = createEmbedder(config.embedding);
    const embeddingStatus = await this.ensureEmbeddings(repoId, documents, embedder, config);
    if (options.warnOnCreatedEmbeddings && embeddingStatus.created > 0) {
      console.warn(`graph context created ${embeddingStatus.created} missing embedding(s); proposal apply should normally pre-create them.`);
    }

    const queryEmbedding = await embedder.embed(query);
    const embeddings = this.loadEmbeddings(repoId, config);
    return this.buildFromVectors(graph, query, queryEmbedding, embeddings, {
      ...options,
      config,
      embeddingStatus,
    });
  }

  async buildFromVectors(
    graph: GraphReadResult,
    query: string,
    queryEmbedding: number[],
    embeddings: Map<string, Float32Array>,
    options: BuildGraphContextOptions & { embeddingStatus: EmbeddingStatus },
  ): Promise<GraphContextResult> {
    const config = options.config ?? graphContextConfig;
    const claimDocuments = buildClaimDocuments(graph);
    const componentDocuments = buildComponentDocuments(graph);
    const flowDocuments = buildFlowDocuments(graph);
    const evidenceByClaim = buildEvidenceByClaim(graph);
    const baseRanked = {
      claims: this.rankDocuments(query, queryEmbedding, claimDocuments, embeddings, config),
      components: this.rankDocuments(query, queryEmbedding, componentDocuments, embeddings, config),
      flows: this.rankDocuments(query, queryEmbedding, flowDocuments, embeddings, config),
    };
    const ranked = applyGraphRanking(baseRanked, graph, config);
    const selectedClaims = await selectClaims(
      ranked.claims,
      evidenceByClaim,
      config,
      this.codeAnchorResolver,
      options.repoRoot,
      options.resolveCodeAnchors ?? true,
    );
    const selectedComponents = selectGraphObjects(
      ranked.components,
      selectedClaims,
      "component",
      config,
    ) as ComponentContextResult[];
    const selectedFlows = selectGraphObjects(
      ranked.flows,
      selectedClaims,
      "flow",
      config,
    ) as FlowContextResult[];
    const rankedResults = rankPacketResults(selectedClaims, selectedComponents, selectedFlows, graph, config);

    return {
      query,
      search_config_version: config.version,
      embedding_status: options.embeddingStatus,
      claims: selectedClaims,
      components: selectedComponents,
      flows: selectedFlows,
      ranked_results: rankedResults,
      sources: selectedEvidenceSources(selectedClaims),
      debug: {
        ranked_results: rankedResults,
        base_ranked_claims: baseRanked.claims.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Claim>),
        base_ranked_components: baseRanked.components.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Component>),
        base_ranked_flows: baseRanked.flows.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Flow>),
        ranked_claims: ranked.claims.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Claim>),
        ranked_components: ranked.components.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Component>),
        ranked_flows: ranked.flows.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Flow>),
      },
    };
  }

  async ensureForGraph(repoId: string, graph: GraphReadResult, config: GraphContextConfig = graphContextConfig): Promise<EmbeddingStatus> {
    const documents = [
      ...buildClaimDocuments(graph),
      ...buildComponentDocuments(graph),
      ...buildFlowDocuments(graph),
    ];
    const embedder = createEmbedder(config.embedding);
    return this.ensureEmbeddings(repoId, documents, embedder, config);
  }

  private async ensureEmbeddings(
    repoId: string,
    documents: ContextDocument[],
    embedder: Embedder,
    config: GraphContextConfig,
  ): Promise<EmbeddingStatus> {
    const repository = this.requireRepository();
    const existing = new Set(
      repository
        .listGraphObjectEmbeddings({
          repo_id: repoId,
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
        })
        .map((record) => contextDocumentKey(record.object_type, record.object_id)),
    );
    const missing = documents.filter((document) => !existing.has(document.key));
    const vectors = await embedder.embedBatch(missing.map((document) => document.text));

    repository.insertGraphObjectEmbeddings(
      missing.map((document, index) => ({
        repo_id: repoId,
        object_type: document.type,
        object_id: document.id,
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        embedding: float32ArrayToBuffer(vectors[index] ?? []),
      })),
    );

    return {
      checked_objects: documents.length,
      created: missing.length,
      reused: documents.length - missing.length,
    };
  }

  private rankDocuments(
    query: string,
    queryEmbedding: number[],
    documents: ContextDocument[],
    embeddings: Map<string, Float32Array>,
    config: GraphContextConfig,
  ): RankedContextDocument[] {
    const semantic = this.scoreSemantic(documents, queryEmbedding, embeddings);
    const bm25 = scoreBm25(query, documents, config);
    return rankContextDocuments(documents, semantic, bm25, config);
  }

  private scoreSemantic(
    documents: ContextDocument[],
    queryEmbedding: number[],
    embeddings: Map<string, Float32Array>,
  ): SemanticScoreEntry[] {
    const documentKeys = new Set(documents.map((document) => document.key));
    const scored = [...embeddings.entries()]
      .filter(([key]) => documentKeys.has(key))
      .map(([key, vector]) => ({
        id: key,
        score: cosineSimilarity(queryEmbedding, vector),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const maxScore = scored[0]?.score ?? 1;

    return scored.map((entry, index) => ({
      id: entry.id,
      score: maxScore === 0 ? 0 : entry.score / maxScore,
      raw_score: entry.score,
      rank: index + 1,
    }));
  }

  private loadEmbeddings(repoId: string, config: GraphContextConfig): Map<string, Float32Array> {
    return new Map(this.requireRepository()
      .listGraphObjectEmbeddings({
        repo_id: repoId,
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
      })
      .map((record) => [
        contextDocumentKey(record.object_type, record.object_id),
        bufferToFloat32Array(record.embedding),
      ] as const));
  }

  private requireRepository(): SqliteRepository {
    if (this.repository === undefined) throw new Error("This graph context operation requires a storage repository.");
    return this.repository;
  }
}

function buildEvidenceByClaim(graph: GraphReadResult): Map<string, ClaimEvidenceResult[]> {
  const sources = new Map(graph.sources.map((source) => [source.id, source]));
  const evidenceByClaim = new Map<string, ClaimEvidenceResult[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== "evidenced_by" || edge.from_type !== "claim" || edge.to_type !== "source") continue;
    const source = sources.get(edge.to_id);
    if (!source) continue;

    const existing = evidenceByClaim.get(edge.from_id) ?? [];
    existing.push({
      source,
      reason: evidenceReason(edge.metadata),
    });
    evidenceByClaim.set(edge.from_id, existing);
  }

  return evidenceByClaim;
}

function evidenceReason(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.reason === "string" ? metadata.reason : "";
}

function selectClaims(
  ranked: RankedContextDocument[],
  evidenceByClaim: Map<string, ClaimEvidenceResult[]>,
  config: GraphContextConfig,
  resolver: CodeAnchorResolver,
  repoRoot: string | undefined,
  resolveAnchors: boolean,
): Promise<ClaimContextResult[]> {
  return Promise.all(selectRankedDocuments(ranked, config, { minimumSelected: config.ranking.minimumSelectedClaims })
    .sort((left, right) => right.score - left.score || left.document.key.localeCompare(right.document.key))
    .map((document, index) => toClaimResult(document, index, evidenceByClaim, resolver, repoRoot, resolveAnchors)));
}

async function toClaimResult(
  document: RankedContextDocument,
  index: number,
  evidenceByClaim: Map<string, ClaimEvidenceResult[]>,
  resolver: CodeAnchorResolver,
  repoRoot: string | undefined,
  resolveAnchors: boolean,
): Promise<ClaimContextResult> {
  const claim = document.document.object as Claim;
  return {
    rank: index + 1,
    score: roundScore(document.score),
    signals: roundRankedSignals(document),
    object: claim,
    about: document.document.about,
    evidence: evidenceByClaim.get(document.document.id) ?? [],
    code_anchors: resolveAnchors ? await resolveCodeAnchors(resolver, repoRoot, claim) : [],
  };
}

async function resolveCodeAnchors(
  resolver: CodeAnchorResolver,
  repoRoot: string | undefined,
  claim: Claim,
): Promise<ResolvedCodeAnchor[]> {
  return resolver.resolveMany(repoRoot, claim.code_anchors);
}

function toRankedDebugResult(
  document: RankedContextDocument,
  index: number,
): RankedContextDebugResult<Claim | Component | Flow> {
  return {
    rank: index + 1,
    score: roundScore(document.score),
    signals: roundRankedSignals(document),
    object: document.document.object,
    about: document.document.about,
  };
}

function selectedEvidenceSources(claims: ClaimContextResult[]): Source[] {
  const sourcesById = new Map<string, Source>();
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      sourcesById.set(evidence.source.id, evidence.source);
    }
  }
  return [...sourcesById.values()].sort((a, b) => a.id.localeCompare(b.id));
}
