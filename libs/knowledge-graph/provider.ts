import type { RepoInstallation } from "../install/repo-installation-store.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import type { GraphContextResult } from "./graph-context/types.js";
import type { GraphViewData } from "./graph-view/build-graph-view.js";
import type {
  ManagedGraphView,
  ManagedMemoryPr,
  ManagedMemoryStatus,
  ManagedProposal,
} from "../managed/protocol.js";
import type {
  ApplyProposalResult,
  GraphReadResult,
  ProposalReviewResult,
} from "./service.js";

export type GraphMemoryProviderMode = "local" | "managed";

export interface ManagedProposalReviewResult extends ProposalReviewResult {
  working_head?: string;
  working_revision?: number;
  main_head?: string;
}

export interface GraphMemoryProvider {
  readonly mode: GraphMemoryProviderMode;
  readonly installation: RepoInstallation;

  readGraph(view?: ManagedGraphView): Promise<GraphReadResult>;
  contextGraph(query: string, view?: ManagedGraphView): Promise<GraphContextResult>;
  viewData(view?: ManagedGraphView): Promise<GraphViewData>;
  buildGraphView(view?: ManagedGraphView): Promise<string>;
  auditCodeAnchors(): Promise<ClaimAnchorAuditResult>;
  reviewProposal(proposal: unknown): Promise<ManagedProposalReviewResult>;
  applyProposal(proposal: unknown): Promise<ApplyProposalResult>;
  listProposals(): Promise<ManagedProposal[]>;
  showProposal(proposalId: string): Promise<ManagedProposal>;
  listMemoryPrs(): Promise<ManagedMemoryPr[]>;
  showMemoryPr(memoryPrId: string): Promise<ManagedMemoryPr>;
  retryMemoryPr(memoryPrId: string): Promise<ManagedMemoryPr>;
  memoryStatus(): Promise<ManagedMemoryStatus>;
  close(): void;
}

export type KnowledgeGraphProvider = GraphMemoryProvider;
