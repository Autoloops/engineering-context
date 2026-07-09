import type { InstallPlatform } from "../install/paths.js";
import type { ClaimedMemoryUpdateAttempt, RecordHookResult } from "../hooks/session-state.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import type { GraphContextResult } from "./graph-context/types.js";
import type {
  ApplyProposalResult,
  GraphReadResult,
  InitRepoResult,
  RepoRef,
} from "./service.js";
import type { ProposalValidationResult } from "./validate-proposal.js";

export type KnowledgeGraphProviderMode = "local" | "managed";

export interface RecordHookEventInput {
  repo: RepoRef;
  platform: InstallPlatform;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  eventName?: string;
}

export interface MarkMemoryCurrentInput {
  repo: RepoRef;
  platform: InstallPlatform;
  sessionId?: string;
}

export interface KnowledgeGraphProvider {
  readonly mode: KnowledgeGraphProviderMode;

  initRepo(input: RepoRef): Promise<InitRepoResult> | InitRepoResult;
  requireRepo(input: RepoRef): Promise<InitRepoResult> | InitRepoResult;
  readGraph(input: RepoRef): Promise<GraphReadResult> | GraphReadResult;
  contextGraph(input: RepoRef, query: string): Promise<GraphContextResult>;
  buildGraphView(input: RepoRef): Promise<string> | string;
  auditCodeAnchors(input: RepoRef): Promise<ClaimAnchorAuditResult>;
  validateProposal(input: RepoRef, proposal: unknown): Promise<ProposalValidationResult>;
  applyProposal(input: RepoRef, proposal: unknown): Promise<ApplyProposalResult>;

  recordHook(input: RecordHookEventInput): Promise<RecordHookResult>;
  claimDueMemoryUpdateAttempts(): Promise<ClaimedMemoryUpdateAttempt[]>;
  markMemoryCurrent(input: MarkMemoryCurrentInput): Promise<boolean>;
}
