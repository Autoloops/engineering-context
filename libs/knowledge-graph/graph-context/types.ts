import type { Claim } from "../claim.js";
import type { ResolvedCodeAnchor } from "../code-anchors/types.js";
import type { Component, Flow, Source } from "../schema.js";

export interface EmbeddingStatus {
  checked_objects: number;
  created: number;
  reused: number;
}

export interface GraphContextSource {
  id: string;
  edge_kind: string;
  weight: number;
  score: number;
  raw_score: number;
}

export interface ContextSignals {
  semantic_score: number;
  semantic_raw_score: number;
  semantic_rank: number | null;
  bm25_score: number;
  bm25_raw_score: number;
  bm25_rank: number | null;
  weighted_score: number;
  weighted_raw_score: number;
  pre_coherence_score: number;
  graph_score: number;
  graph_raw_score: number;
  graph_sources: GraphContextSource[];
  coherence_score: number;
  coherence_raw_score: number;
  coherence_sources: GraphContextSource[];
}

export interface ClaimEvidenceResult {
  source: Source;
  reason: string;
}

export interface ClaimContextResult {
  rank: number;
  score: number;
  signals: ContextSignals;
  object: Claim;
  about: Array<{ type: "component" | "flow"; id: string }>;
  evidence: ClaimEvidenceResult[];
  code_anchors: ResolvedCodeAnchor[];
}

export interface GraphObjectContextResult<TObject> {
  rank: number;
  score: number;
  context_relation: "primary" | "additional";
  direct_score: number;
  direct_raw_score: number;
  claim_support_score: number;
  claim_support_raw_score: number;
  signals: ContextSignals;
  object: TObject;
  matched_claim_ids: string[];
}

export type ComponentContextResult = GraphObjectContextResult<Component>;

export type FlowContextResult = GraphObjectContextResult<Flow>;

export type RankedGraphContextResult =
  | ({
      type: "component";
    } & ComponentContextResult)
  | ({
      type: "flow";
    } & FlowContextResult)
  | ({
      type: "claim";
    } & ClaimContextResult);

export interface RankedContextDebugResult<TObject> {
  rank: number;
  score: number;
  signals: ContextSignals;
  object: TObject;
  about: Array<{ type: "component" | "flow"; id: string }>;
}

export interface GraphContextResult {
  query: string;
  search_config_version: string;
  embedding_status: EmbeddingStatus;
  claims: ClaimContextResult[];
  components: ComponentContextResult[];
  flows: FlowContextResult[];
  ranked_results: RankedGraphContextResult[];
  sources: Source[];
  debug?: {
    ranked_results: RankedGraphContextResult[];
    base_ranked_claims?: Array<RankedContextDebugResult<Claim>>;
    base_ranked_components?: Array<RankedContextDebugResult<Component>>;
    base_ranked_flows?: Array<RankedContextDebugResult<Flow>>;
    ranked_claims: Array<RankedContextDebugResult<Claim>>;
    ranked_components: Array<RankedContextDebugResult<Component>>;
    ranked_flows: Array<RankedContextDebugResult<Flow>>;
  };
}
