import type { GraphReadResult } from "../service.js";
import { contextDocumentKey } from "./documents.js";
import type { GraphContextConfig } from "./config.js";
import type { RankedContextDocument } from "./rank.js";
import type { GraphContextSource } from "./types.js";

export interface RankedContextGroups {
  claims: RankedContextDocument[];
  components: RankedContextDocument[];
  flows: RankedContextDocument[];
}

interface GraphBoostEdge {
  id: string;
  edge_kind: string;
  weight: number;
}

export function applyGraphRanking(
  groups: RankedContextGroups,
  graph: GraphReadResult,
  config: GraphContextConfig,
): RankedContextGroups {
  const rankedByKey = new Map(
    [...groups.claims, ...groups.components, ...groups.flows].map((document) => [document.document.key, document]),
  );
  const adjacency = buildGraphBoostAdjacency(graph, config);

  const boosted = {
    claims: boostRankedDocuments(groups.claims, rankedByKey, adjacency, config),
    components: boostRankedDocuments(groups.components, rankedByKey, adjacency, config),
    flows: boostRankedDocuments(groups.flows, rankedByKey, adjacency, config),
  };
  const coherent = applyCandidateCoherence(boosted, graph, config);
  return {
    claims: applyPostGraphThreshold(coherent.claims, config),
    components: applyPostGraphThreshold(coherent.components, config),
    flows: applyPostGraphThreshold(coherent.flows, config),
  };
}

function applyPostGraphThreshold(
  ranked: RankedContextDocument[],
  config: GraphContextConfig,
): RankedContextDocument[] {
  return ranked.filter((document) =>
    document.signals.semantic_score >= config.ranking.semanticThreshold ||
    document.signals.graph_score >= config.ranking.semanticThreshold ||
    document.signals.coherence_score >= config.ranking.semanticThreshold,
  );
}

function applyCandidateCoherence(
  groups: RankedContextGroups,
  graph: GraphReadResult,
  config: GraphContextConfig,
): RankedContextGroups {
  if (config.ranking.coherence.weight <= 0) return groups;

  const rankedByKey = new Map(
    [...groups.claims, ...groups.components, ...groups.flows].map((document) => [document.document.key, document]),
  );
  const adjacency = buildCoherenceAdjacency(graph, config);
  const degreeByKey = buildDegreeIndex(adjacency);

  return {
    claims: applyCoherenceToGroup(groups.claims, rankedByKey, adjacency, degreeByKey, config),
    components: applyCoherenceToGroup(groups.components, rankedByKey, adjacency, degreeByKey, config),
    flows: applyCoherenceToGroup(groups.flows, rankedByKey, adjacency, degreeByKey, config),
  };
}

function applyCoherenceToGroup(
  ranked: RankedContextDocument[],
  rankedByKey: Map<string, RankedContextDocument>,
  adjacency: Map<string, GraphBoostEdge[]>,
  degreeByKey: Map<string, number>,
  config: GraphContextConfig,
): RankedContextDocument[] {
  return ranked
    .map((document) => {
      const sources = candidateCoherenceSources(document, rankedByKey, adjacency, degreeByKey, config);
      const coherenceScore = Math.min(1, sources.reduce((sum, source) => sum + source.score, 0));
      const coherenceRawScore = sources.reduce((sum, source) => sum + source.raw_score, 0);
      const preCoherenceScore = document.score;
      return {
        ...document,
        score: combineCoherenceScore(document.score, coherenceScore, config),
        signals: {
          ...document.signals,
          pre_coherence_score: preCoherenceScore,
          coherence_score: coherenceScore,
          coherence_raw_score: coherenceRawScore,
          coherence_sources: sources,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key));
}

function candidateCoherenceSources(
  document: RankedContextDocument,
  rankedByKey: Map<string, RankedContextDocument>,
  adjacency: Map<string, GraphBoostEdge[]>,
  degreeByKey: Map<string, number>,
  config: GraphContextConfig,
): GraphContextSource[] {
  const sourcesById = new Map<string, GraphContextSource>();

  for (const edge of adjacency.get(document.document.key) ?? []) {
    const neighbor = rankedByKey.get(edge.id);
    if (neighbor === undefined) continue;
    addCoherenceSource({
      sourcesById,
      id: neighbor.document.key,
      edgeKind: edge.edge_kind,
      edgeWeight: edge.weight,
      neighbor,
      threshold: config.ranking.coherence.neighborThreshold,
      degreeByKey,
      config,
    });
  }

  return [...sourcesById.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, config.ranking.coherence.maxSources);
}

function addCoherenceSource(input: {
  sourcesById: Map<string, GraphContextSource>;
  id: string;
  edgeKind: string;
  edgeWeight: number;
  neighbor: RankedContextDocument;
  threshold: number;
  degreeByKey: Map<string, number>;
  config: GraphContextConfig;
}): void {
  const directScore = input.neighbor.signals.weighted_score;
  if (directScore < input.threshold) return;

  const hubPenalty = coherenceHubPenalty(input.id, input.degreeByKey, input.config);
  const score = directScore * input.edgeWeight / hubPenalty;
  const rawScore = input.neighbor.signals.weighted_raw_score * input.edgeWeight / hubPenalty;
  if (score <= 0) return;
  const current = input.sourcesById.get(input.id);
  if (current !== undefined && current.score >= score) return;

  input.sourcesById.set(input.id, {
    id: input.id,
    edge_kind: input.edgeKind,
    weight: input.edgeWeight,
    score,
    raw_score: rawScore,
  });
}

function combineCoherenceScore(baseScore: number, coherenceScore: number, config: GraphContextConfig): number {
  const weight = Math.max(0, config.ranking.coherence.weight);
  return clamp01(baseScore * (1 - weight) + coherenceScore * weight);
}

function coherenceHubPenalty(key: string, degreeByKey: Map<string, number>, config: GraphContextConfig): number {
  const degree = degreeByKey.get(key) ?? 0;
  return Math.max(1, (degree + 1) ** config.ranking.coherence.degreePenalty);
}

function buildDegreeIndex(adjacency: Map<string, GraphBoostEdge[]>): Map<string, number> {
  const degreeByKey = new Map<string, number>();
  for (const [from, edges] of adjacency.entries()) {
    degreeByKey.set(from, (degreeByKey.get(from) ?? 0) + edges.length);
    for (const edge of edges) {
      degreeByKey.set(edge.id, (degreeByKey.get(edge.id) ?? 0) + 1);
    }
  }
  return degreeByKey;
}

function buildCoherenceAdjacency(graph: GraphReadResult, config: GraphContextConfig): Map<string, GraphBoostEdge[]> {
  const adjacency = new Map<string, GraphBoostEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "about" && edge.from_type === "claim" && (edge.to_type === "component" || edge.to_type === "flow")) {
      addBoostEdge(adjacency, contextDocumentKey("claim", edge.from_id), contextDocumentKey(edge.to_type, edge.to_id), "about", config.ranking.coherence.aboutWeight);
      addBoostEdge(adjacency, contextDocumentKey(edge.to_type, edge.to_id), contextDocumentKey("claim", edge.from_id), "about", config.ranking.coherence.aboutWeight);
    }

    if (edge.kind === "touches" && edge.from_type === "flow" && edge.to_type === "component") {
      addBoostEdge(adjacency, contextDocumentKey("flow", edge.from_id), contextDocumentKey("component", edge.to_id), "touches", config.ranking.coherence.touchesWeight);
      addBoostEdge(adjacency, contextDocumentKey("component", edge.to_id), contextDocumentKey("flow", edge.from_id), "touches", config.ranking.coherence.touchesWeight);
    }

    if (edge.kind === "contains" && edge.from_type === edge.to_type && (edge.from_type === "component" || edge.from_type === "flow")) {
      const type = edge.from_type;
      addBoostEdge(adjacency, contextDocumentKey(type, edge.from_id), contextDocumentKey(type, edge.to_id), "contains", config.ranking.coherence.containsWeight);
      addBoostEdge(adjacency, contextDocumentKey(type, edge.to_id), contextDocumentKey(type, edge.from_id), "contains", config.ranking.coherence.containsWeight);
    }
  }
  return adjacency;
}

function boostRankedDocuments(
  ranked: RankedContextDocument[],
  rankedByKey: Map<string, RankedContextDocument>,
  adjacency: Map<string, GraphBoostEdge[]>,
  config: GraphContextConfig,
): RankedContextDocument[] {
  return ranked
    .map((document) => {
      const sources = (adjacency.get(document.document.key) ?? [])
        .flatMap((edge): GraphContextSource[] => {
          const neighbor = rankedByKey.get(edge.id);
          if (!neighbor) return [];
          return [{
            id: edge.id,
            edge_kind: edge.edge_kind,
            weight: edge.weight,
            score: neighbor.score * edge.weight,
            raw_score: neighbor.signals.weighted_raw_score * edge.weight,
          }];
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, config.ranking.graphBoost.maxSources);
      const graphScore = sources[0]?.score ?? 0;
      const graphRawScore = sources[0]?.raw_score ?? 0;

      return {
        ...document,
        score: Math.max(document.score, graphScore),
        signals: {
          ...document.signals,
          graph_score: graphScore,
          graph_raw_score: graphRawScore,
          graph_sources: sources,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key));
}

function buildGraphBoostAdjacency(graph: GraphReadResult, config: GraphContextConfig): Map<string, GraphBoostEdge[]> {
  const adjacency = new Map<string, GraphBoostEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "about" && edge.from_type === "claim" && (edge.to_type === "component" || edge.to_type === "flow")) {
      addBoostEdge(adjacency, contextDocumentKey("claim", edge.from_id), contextDocumentKey(edge.to_type, edge.to_id), "about", config.ranking.graphBoost.claimAboutTarget);
    }

    if (edge.kind === "touches" && edge.from_type === "flow" && edge.to_type === "component") {
      addBoostEdge(adjacency, contextDocumentKey("component", edge.to_id), contextDocumentKey("flow", edge.from_id), "touches", config.ranking.graphBoost.touchesComponentToFlow);
    }

    if (edge.kind === "contains" && edge.from_type === edge.to_type && (edge.from_type === "component" || edge.from_type === "flow")) {
      const type = edge.from_type;
      addBoostEdge(adjacency, contextDocumentKey(type, edge.from_id), contextDocumentKey(type, edge.to_id), "contains", config.ranking.graphBoost.containsParentToChild);
      addBoostEdge(adjacency, contextDocumentKey(type, edge.to_id), contextDocumentKey(type, edge.from_id), "contains", config.ranking.graphBoost.containsChildToParent);
    }
  }
  return adjacency;
}

function addBoostEdge(
  adjacency: Map<string, GraphBoostEdge[]>,
  from: string,
  to: string,
  edgeKind: string,
  weight: number,
): void {
  if (weight <= 0) return;
  const existing = adjacency.get(from) ?? [];
  existing.push({ id: to, edge_kind: edgeKind, weight });
  adjacency.set(from, existing);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
