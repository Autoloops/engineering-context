import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ClaimCodeAnchor } from "../knowledge-graph/claim.js";
import type {
  ClaimAnchorAuditIssue,
  ClaimAnchorAuditResult,
} from "../knowledge-graph/code-anchors/types.js";
import type { CompactClaim, CompactEdge, CompactMemoryProposal } from "../knowledge-graph/proposal.js";
import type { GraphMemoryProvider } from "../knowledge-graph/provider.js";
import type { ClaimId } from "../knowledge-graph/schema.js";
import type { GraphReadResult } from "../knowledge-graph/service.js";

export type ActionableAnchorStatus = Extract<
  ClaimAnchorAuditIssue["status"],
  "drifted" | "missing_file" | "missing_symbol"
>;

export type ActionableAnchorIssue = Omit<ClaimAnchorAuditIssue, "status" | "anchor"> & {
  status: ActionableAnchorStatus;
  anchor: ClaimCodeAnchor;
};

export type CheckoutSkipReason =
  | "missing_cwd"
  | "git_unavailable"
  | "detached_head"
  | "not_default_branch"
  | "dirty_tracked_files";

export type CheckoutInspection =
  | { eligible: true; repoRoot: string; gitHead: string }
  | { eligible: false; reason: CheckoutSkipReason };

export type AnchorDriftPassResult =
  | { status: "clean" }
  | { status: "applied"; claimIds: ClaimId[]; memoryCommitId: string };

export function inspectAnchorDriftCheckout(cwd: string | null, defaultBranch: string): CheckoutInspection {
  if (cwd === null || cwd.trim().length === 0) return { eligible: false, reason: "missing_cwd" };

  const repoRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (repoRoot === undefined) return { eligible: false, reason: "git_unavailable" };

  const branch = gitText(repoRoot, ["branch", "--show-current"]);
  if (branch === undefined) return { eligible: false, reason: "git_unavailable" };
  if (branch.length === 0) return { eligible: false, reason: "detached_head" };
  if (branch !== defaultBranch) return { eligible: false, reason: "not_default_branch" };

  const unstaged = gitDiffStatus(repoRoot, ["diff", "--quiet", "--ignore-submodules=all", "--"]);
  const staged = gitDiffStatus(repoRoot, ["diff", "--cached", "--quiet", "--ignore-submodules=all", "--"]);
  if (unstaged === "error" || staged === "error") return { eligible: false, reason: "git_unavailable" };
  if (unstaged === "dirty" || staged === "dirty") return { eligible: false, reason: "dirty_tracked_files" };

  const gitHead = gitText(repoRoot, ["rev-parse", "HEAD"]);
  return gitHead === undefined || gitHead.length === 0
    ? { eligible: false, reason: "git_unavailable" }
    : { eligible: true, repoRoot, gitHead };
}

export function buildAnchorDriftProposal(
  graph: GraphReadResult,
  audit: ClaimAnchorAuditResult,
  gitHead: string,
): CompactMemoryProposal | undefined {
  const issuesByClaim = groupActionableIssues(audit);
  const claimsById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const claims: CompactClaim[] = [];
  const edges: CompactEdge[] = [];

  for (const claimId of [...issuesByClaim.keys()].sort()) {
    const claim = claimsById.get(claimId);
    if (claim === undefined || claim.truth !== "code_verified") continue;

    const replacementId = anchorDriftClaimId(claim.id);
    const about = graph.edges
      .filter((edge) => edge.kind === "about" && edge.from_type === "claim" && edge.from_id === claim.id)
      .map((edge) => edge.to_id)
      .sort();

    claims.push({
      id: replacementId,
      kind: claim.kind,
      text: claim.text,
      truth: "unknown",
      intent: claim.intent,
      ...(about.length === 0 ? {} : { about }),
    });
    edges.push({
      kind: "supersedes",
      from: replacementId,
      to: claim.id,
      metadata: {
        reason: "anchor_drift",
        git_commit_sha: gitHead,
        issues: issuesByClaim.get(claimId)?.map(({ status, anchor }) => ({ status, anchor })) ?? [],
      },
    });
  }

  if (claims.length === 0) return undefined;
  return {
    title: `Demote ${claims.length} drifted code claim${claims.length === 1 ? "" : "s"}`,
    summary: "Mark claims with changed or missing code anchors as unknown while preserving their history.",
    creates: { claims, edges },
  };
}

export async function runAnchorDriftPass(
  provider: GraphMemoryProvider,
  gitHead: string,
): Promise<AnchorDriftPassResult> {
  const audit = await provider.auditCodeAnchors();
  if (!hasActionableIssues(audit)) return { status: "clean" };

  const proposal = buildAnchorDriftProposal(await provider.readGraph(), audit, gitHead);
  if (proposal === undefined) return { status: "clean" };

  const result = await provider.applyProposal(proposal);
  return {
    status: "applied",
    claimIds: (proposal.creates.edges ?? []).map((edge) => edge.to).sort(),
    memoryCommitId: result.memory_commit_id,
  };
}

function groupActionableIssues(audit: ClaimAnchorAuditResult): Map<ClaimId, ActionableAnchorIssue[]> {
  const grouped = new Map<ClaimId, Map<string, ActionableAnchorIssue>>();
  for (const issue of [...audit.drifted, ...audit.missing_files, ...audit.missing_symbols]) {
    if (!isActionableAnchorIssue(issue)) continue;
    const issues = grouped.get(issue.claim_id) ?? new Map<string, ActionableAnchorIssue>();
    issues.set(issueKey(issue), issue);
    grouped.set(issue.claim_id, issues);
  }
  return new Map(
    [...grouped.entries()].map(([claimId, issues]) => [claimId, [...issues.values()].sort(compareIssues)]),
  );
}

function hasActionableIssues(audit: ClaimAnchorAuditResult): boolean {
  return [...audit.drifted, ...audit.missing_files, ...audit.missing_symbols].some(isActionableAnchorIssue);
}

function isActionableAnchorIssue(issue: ClaimAnchorAuditIssue): issue is ActionableAnchorIssue {
  return issue.anchor !== undefined &&
    (issue.status === "drifted" || issue.status === "missing_file" || issue.status === "missing_symbol");
}

function issueKey(issue: ActionableAnchorIssue): string {
  return `${issue.status}\0${issue.anchor.file}\0${issue.anchor.symbol ?? ""}`;
}

function compareIssues(left: ActionableAnchorIssue, right: ActionableAnchorIssue): number {
  return issueKey(left).localeCompare(issueKey(right));
}

function anchorDriftClaimId(claimId: ClaimId): ClaimId {
  const digest = createHash("sha256").update(`anchor-drift:${claimId}`).digest("hex").slice(0, 16);
  return `claim.anchor_drift.${digest}`;
}

function gitText(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitDiffStatus(cwd: string, args: string[]): "clean" | "dirty" | "error" {
  const result = spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  if (result.status === 0) return "clean";
  return result.status === 1 ? "dirty" : "error";
}
