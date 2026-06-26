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
}

interface ExistingEmbedding {
  key: string;
  vector: Float32Array;
}

export class GraphContextBuilder {
  private readonly codeAnchorResolver = new CodeAnchorResolver();

  constructor(private readonly repository: SqliteRepository) {}

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
    const baseRanked = {
      claims: this.rankDocuments(repoId, query, queryEmbedding, claimDocuments, config),
      components: this.rankDocuments(repoId, query, queryEmbedding, componentDocuments, config),
      flows: this.rankDocuments(repoId, query, queryEmbedding, flowDocuments, config),
    };
    const ranked = applyGraphRanking(baseRanked, graph, config);
    const selectedClaims = await selectClaims(
      ranked.claims,
      evidenceByClaim,
      config,
      this.codeAnchorResolver,
      options.repoRoot,
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
      embedding_status: embeddingStatus,
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
    const existing = new Set(
      this.repository
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

    this.repository.insertGraphObjectEmbeddings(
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
    repoId: string,
    query: string,
    queryEmbedding: number[],
    documents: ContextDocument[],
    config: GraphContextConfig,
  ): RankedContextDocument[] {
    const semantic = this.scoreSemantic(repoId, documents, queryEmbedding, config);
    const bm25 = scoreBm25(query, documents, config);
    return rankContextDocuments(documents, semantic, bm25, config);
  }

  private scoreSemantic(
    repoId: string,
    documents: ContextDocument[],
    queryEmbedding: number[],
    config: GraphContextConfig,
  ): SemanticScoreEntry[] {
    const documentKeys = new Set(documents.map((document) => document.key));
    const embeddings = this.loadEmbeddings(repoId, config).filter((embedding) => documentKeys.has(embedding.key));
    const scored = embeddings
      .map((embedding) => ({
        id: embedding.key,
        score: cosineSimilarity(queryEmbedding, embedding.vector),
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

  private loadEmbeddings(repoId: string, config: GraphContextConfig): ExistingEmbedding[] {
    return this.repository
      .listGraphObjectEmbeddings({
        repo_id: repoId,
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
      })
      .map((record) => ({
        key: contextDocumentKey(record.object_type, record.object_id),
        vector: bufferToFloat32Array(record.embedding),
      }));
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
): Promise<ClaimContextResult[]> {
  return Promise.all(selectRankedDocuments(ranked, config, { minimumSelected: config.ranking.minimumSelectedClaims })
    .sort((left, right) => right.score - left.score || left.document.key.localeCompare(right.document.key))
    .map((document, index) => toClaimResult(document, index, evidenceByClaim, resolver, repoRoot)));
}

async function toClaimResult(
  document: RankedContextDocument,
  index: number,
  evidenceByClaim: Map<string, ClaimEvidenceResult[]>,
  resolver: CodeAnchorResolver,
  repoRoot: string | undefined,
): Promise<ClaimContextResult> {
  const claim = document.document.object as Claim;
  return {
    rank: index + 1,
    score: roundScore(document.score),
    signals: roundRankedSignals(document),
    object: claim,
    about: document.document.about,
    evidence: evidenceByClaim.get(document.document.id) ?? [],
    code_anchors: await resolveCodeAnchors(resolver, repoRoot, claim),
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
