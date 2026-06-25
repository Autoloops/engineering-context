import type { GreplicaConfig, EmbeddingConfig } from "../../config/greplica-config.js";

export interface RankingWeights {
  semantic: number;
  bm25: number;
}

export interface Bm25Config {
  k1: number;
  b: number;
}

export interface ClaimSupportConfig {
  weight: number;
  countBoost: number;
}

export interface DirectObjectConfig {
  weight: number;
}

export interface GraphBoostConfig {
  claimAboutTarget: number;
  containsParentToChild: number;
  containsChildToParent: number;
  touchesComponentToFlow: number;
  maxSources: number;
}

export interface PacketHubPenaltyConfig {
  weight: number;
  graphScoreThreshold: number;
  claimSupportThreshold: number;
  bm25Threshold: number;
  semanticThreshold: number;
  coherenceThreshold: number;
}

export interface CoherenceConfig {
  weight: number;
  neighborThreshold: number;
  degreePenalty: number;
  aboutWeight: number;
  touchesWeight: number;
  containsWeight: number;
  maxSources: number;
}

export interface RankingConfig {
  semanticThreshold: number;
  selectionThreshold: number;
  packetMinimumScore: number;
  packetAdditionalDirectScoreFloor: number;
  minimumSelectedClaims: number;
  weights: RankingWeights;
  bm25: Bm25Config;
  claimSupport: ClaimSupportConfig;
  directObject: DirectObjectConfig;
  graphBoost: GraphBoostConfig;
  packetHubPenalty: PacketHubPenaltyConfig;
  coherence: CoherenceConfig;
}

const rankingConfig: RankingConfig = {
  semanticThreshold: 0.1,
  selectionThreshold: 0.8,
  packetMinimumScore: 0.15,
  packetAdditionalDirectScoreFloor: 0.15,
  minimumSelectedClaims: 3,
  weights: {
    semantic: 0.73,
    bm25: 0.384,
  },
  bm25: {
    k1: 1.5,
    b: 0.75,
  },
  claimSupport: {
    weight: 0.907,
    countBoost: 0.08,
  },
  directObject: {
    weight: 0.82,
  },
  graphBoost: {
    claimAboutTarget: 0.798,
    containsParentToChild: 0.514,
    containsChildToParent: 0.585,
    touchesComponentToFlow: 0.947,
    maxSources: 3,
  },
  packetHubPenalty: {
    weight: 0,
    graphScoreThreshold: 0.66,
    claimSupportThreshold: 0.254,
    bm25Threshold: 0.244,
    semanticThreshold: 0.513,
    coherenceThreshold: 0.072,
  },
  coherence: {
    weight: 0.096,
    neighborThreshold: 0.765,
    degreePenalty: 1.114,
    aboutWeight: 1,
    touchesWeight: 0.2,
    containsWeight: 0.2,
    maxSources: 5,
  },
};

export interface GraphContextConfig {
  version: string;
  embedding: EmbeddingConfig;
  ranking: RankingConfig;
}

export const graphContextConfig: GraphContextConfig = {
  version: "graph-context-v33-precision-anchors",
  embedding: {
    provider: "local",
    model: "all-mpnet-base-v2",
    dimensions: 768,
    batchSize: 16,
  },
  ranking: rankingConfig,
};

export function graphContextConfigFromGreplicaConfig(config: GreplicaConfig): GraphContextConfig {
  return {
    ...graphContextConfig,
    version: `${graphContextConfig.version}:${config.embedding.provider}:${config.embedding.model}:${config.embedding.dimensions}`,
    embedding: { ...config.embedding },
  };
}
