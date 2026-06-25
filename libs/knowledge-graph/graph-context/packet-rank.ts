import type { GraphReadResult } from "../service.js";
import type { Component, Flow } from "../schema.js";
import type { GraphContextConfig } from "./config.js";
import { contextDocumentKey } from "./documents.js";
import type { RankedContextDocument } from "./rank.js";
import { roundScore } from "./rank.js";
import type {
  ClaimContextResult,
  ComponentContextResult,
  FlowContextResult,
  RankedGraphContextResult,
} from "./types.js";

export type ContextRelation = "primary" | "additional";

export interface ClaimSupportResult {
  score: number;
  rawScore: number;
  claimIds: string[];
}

export interface GraphObjectPacketScores {
  passesSelection: boolean;
  contextRelation: ContextRelation;
  score: number;
  directScore: number;
  directRawScore: number;
  claimSupportScore: number;
  claimSupportRawScore: number;
}

export function selectGraphObjects(
  ranked: RankedContextDocument[],
  claims: ClaimContextResult[],
  type: "component" | "flow",
  config: GraphContextConfig,
): Array<ComponentContextResult | FlowContextResult> {
  const results: Array<ComponentContextResult | FlowContextResult> = [];
  for (const document of ranked) {
    const support = claimSupport(claims, type, document.document.id, config);
    const scores = scoreGraphObjectPacketCandidate(document, support, config);
    if (!scores.passesSelection) continue;

    if (type === "component") {
      results.push({
        rank: 0,
        score: roundScore(scores.score),
        context_relation: scores.contextRelation,
        direct_score: roundScore(scores.directScore),
        direct_raw_score: roundScore(scores.directRawScore),
        claim_support_score: roundScore(scores.claimSupportScore),
        claim_support_raw_score: roundScore(scores.claimSupportRawScore),
        signals: roundRankedSignals(document),
        object: document.document.object as Component,
        matched_claim_ids: support.claimIds,
      });
    } else {
      results.push({
        rank: 0,
        score: roundScore(scores.score),
        context_relation: scores.contextRelation,
        direct_score: roundScore(scores.directScore),
        direct_raw_score: roundScore(scores.directRawScore),
        claim_support_score: roundScore(scores.claimSupportScore),
        claim_support_raw_score: roundScore(scores.claimSupportRawScore),
        signals: roundRankedSignals(document),
        object: document.document.object as Flow,
        matched_claim_ids: support.claimIds,
      });
    }
  }

  return results
    .sort((a, b) =>
      relationSortValue(a.context_relation) - relationSortValue(b.context_relation) ||
      b.score - a.score ||
      b.matched_claim_ids.length - a.matched_claim_ids.length ||
      a.object.id.localeCompare(b.object.id),
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

export function scoreGraphObjectPacketCandidate(
  document: RankedContextDocument,
  support: ClaimSupportResult,
  config: GraphContextConfig,
): GraphObjectPacketScores {
  const directScore = document.score * config.ranking.directObject.weight;
  const directRawScore = document.signals.weighted_raw_score * config.ranking.directObject.weight;
  const score = Math.max(directScore, support.score);
  const passesSelection =
    support.score >= config.ranking.selectionThreshold ||
    document.score >= config.ranking.selectionThreshold;
  const contextRelation: ContextRelation =
    document.score >= config.ranking.selectionThreshold ? "primary" : "additional";

  return {
    passesSelection,
    contextRelation,
    score,
    directScore,
    directRawScore,
    claimSupportScore: support.score,
    claimSupportRawScore: support.rawScore,
  };
}

export function rankPacketResults(
  claims: ClaimContextResult[],
  components: ComponentContextResult[],
  flows: FlowContextResult[],
  graph: GraphReadResult,
  config: GraphContextConfig,
): RankedGraphContextResult[] {
  const results: RankedGraphContextResult[] = [
    ...components.map((component) => ({ ...component, type: "component" as const })),
    ...flows.map((flow) => ({ ...flow, type: "flow" as const })),
    ...claims.map((claim) => ({ ...claim, type: "claim" as const })),
  ];

  return rankPacketCandidates(results, buildPacketDegreeIndex(graph), config);
}

export function rankPacketCandidates(
  results: RankedGraphContextResult[],
  degreeIndex: PacketDegreeIndex,
  config: GraphContextConfig,
): RankedGraphContextResult[] {
  return results
    .filter((result) => shouldIncludePacketResult(result, config))
    .sort((a, b) =>
      b.score - a.score ||
      packetTypeSortValue(a.type) - packetTypeSortValue(b.type) ||
      a.object.id.localeCompare(b.object.id),
    )
    .filter((result) => shouldIncludeAfterPacketHubPenalty(result, degreeIndex, config))
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

export function claimSupport(
  claims: ClaimContextResult[],
  type: "component" | "flow",
  id: string,
  config: GraphContextConfig,
): ClaimSupportResult {
  const matched = claims.filter((claim) => claim.about.some((target) => target.type === type && target.id === id));
  const sorted = [...matched].sort((a, b) => b.score - a.score || a.object.id.localeCompare(b.object.id));
  const maxScore = Math.max(0, ...sorted.map((claim) => claim.score));
  const maxRawScore = Math.max(0, ...sorted.map((claim) => claim.signals.weighted_raw_score));
  return {
    score: Math.min(1, maxScore * config.ranking.claimSupport.weight + sorted.length * config.ranking.claimSupport.countBoost),
    rawScore: maxRawScore,
    claimIds: sorted.map((claim) => claim.object.id),
  };
}

export function roundRankedSignals(document: RankedContextDocument) {
  return {
    semantic_score: roundScore(document.signals.semantic_score),
    semantic_raw_score: roundScore(document.signals.semantic_raw_score),
    semantic_rank: document.signals.semantic_rank,
    bm25_score: roundScore(document.signals.bm25_score),
    bm25_raw_score: roundScore(document.signals.bm25_raw_score),
    bm25_rank: document.signals.bm25_rank,
    weighted_score: roundScore(document.signals.weighted_score),
    weighted_raw_score: roundScore(document.signals.weighted_raw_score),
    pre_coherence_score: roundScore(document.signals.pre_coherence_score),
    graph_score: roundScore(document.signals.graph_score),
    graph_raw_score: roundScore(document.signals.graph_raw_score),
    graph_sources: document.signals.graph_sources.map((source) => ({
      ...source,
      score: roundScore(source.score),
      raw_score: roundScore(source.raw_score),
    })),
    coherence_score: roundScore(document.signals.coherence_score),
    coherence_raw_score: roundScore(document.signals.coherence_raw_score),
    coherence_sources: document.signals.coherence_sources.map((source) => ({
      ...source,
      score: roundScore(source.score),
      raw_score: roundScore(source.raw_score),
    })),
  };
}

export interface PacketDegreeIndex {
  degreeByKey: Map<string, number>;
  maxDegreeByType: Map<"claim" | "component" | "flow", number>;
}

export function buildPacketDegreeIndex(graph: GraphReadResult): PacketDegreeIndex {
  const degreeByKey = new Map<string, number>();
  const maxDegreeByType = new Map<"claim" | "component" | "flow", number>([
    ["claim", 0],
    ["component", 0],
    ["flow", 0],
  ]);

  for (const edge of graph.edges) {
    incrementPacketDegree(edge.from_type, edge.from_id, degreeByKey, maxDegreeByType);
    incrementPacketDegree(edge.to_type, edge.to_id, degreeByKey, maxDegreeByType);
  }

  return { degreeByKey, maxDegreeByType };
}

function shouldIncludePacketResult(result: RankedGraphContextResult, config: GraphContextConfig): boolean {
  if (result.score < config.ranking.packetMinimumScore) return false;
  if (result.type === "claim") return true;
  if (result.context_relation !== "additional") return true;
  return result.direct_score >= config.ranking.packetAdditionalDirectScoreFloor;
}

function shouldIncludeAfterPacketHubPenalty(
  result: RankedGraphContextResult,
  degreeIndex: PacketDegreeIndex,
  config: GraphContextConfig,
): boolean {
  if (result.type === "claim") return true;

  const penalty = config.ranking.packetHubPenalty;
  if (result.signals.graph_score < penalty.graphScoreThreshold) return true;
  if (result.claim_support_score >= penalty.claimSupportThreshold) return true;

  const weakDirectSignal =
    result.signals.bm25_score < penalty.bm25Threshold ||
    result.signals.semantic_score < penalty.semanticThreshold ||
    result.signals.coherence_score < penalty.coherenceThreshold;
  if (!weakDirectSignal) return true;

  const maxDegree = degreeIndex.maxDegreeByType.get(result.type) ?? 0;
  if (maxDegree <= 0) return true;

  const degree = degreeIndex.degreeByKey.get(contextDocumentKey(result.type, result.object.id)) ?? 0;
  const adjustedScore = result.score - penalty.weight * (degree / maxDegree);
  return adjustedScore >= config.ranking.packetMinimumScore;
}

function incrementPacketDegree(
  type: string,
  id: string,
  degreeByKey: Map<string, number>,
  maxDegreeByType: Map<"claim" | "component" | "flow", number>,
): void {
  if (type !== "claim" && type !== "component" && type !== "flow") return;
  const key = contextDocumentKey(type, id);
  const degree = (degreeByKey.get(key) ?? 0) + 1;
  degreeByKey.set(key, degree);
  maxDegreeByType.set(type, Math.max(maxDegreeByType.get(type) ?? 0, degree));
}

function relationSortValue(relation: ContextRelation): number {
  return relation === "primary" ? 0 : 1;
}

function packetTypeSortValue(type: RankedGraphContextResult["type"]): number {
  switch (type) {
    case "component":
      return 0;
    case "flow":
      return 1;
    case "claim":
      return 2;
  }
}
