import type { RepoInstallation } from "../install/repo-installation-store.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import type { GraphContextResult } from "./graph-context/types.js";
import type { GraphViewData } from "./graph-view/build-graph-view.js";
import type {
  ApplyProposalResult,
  GraphReadResult,
  ProposalReviewResult,
} from "./service.js";

export type GraphMemoryProviderMode = "local" | "managed";

export interface ManagedProposalReviewResult extends ProposalReviewResult {
  working_head?: string;
}

export interface GraphMemoryProvider {
  readonly mode: GraphMemoryProviderMode;
  readonly installation: RepoInstallation;

  readGraph(): Promise<GraphReadResult>;
  contextGraph(query: string): Promise<GraphContextResult>;
  viewData(): Promise<GraphViewData>;
  buildGraphView(): Promise<string>;
  auditCodeAnchors(): Promise<ClaimAnchorAuditResult>;
  reviewProposal(proposal: unknown): Promise<ManagedProposalReviewResult>;
  applyProposal(proposal: unknown): Promise<ApplyProposalResult>;
  close(): void;
}

export type KnowledgeGraphProvider = GraphMemoryProvider;
