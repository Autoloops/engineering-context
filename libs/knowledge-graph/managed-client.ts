import type { Claim } from "./claim.js";
import { execFileSync } from "node:child_process";
import { auditClaimCodeAnchors } from "./code-anchors/audit.js";
import { fingerprintClaimAnchors } from "./code-anchors/fingerprint.js";
import { CodeAnchorResolver } from "./code-anchors/resolver.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import {
  readManagedCredentials,
  writeManagedCredentials,
  type ManagedCredentials,
} from "../config/managed-credentials.js";
import type { RepoInstallation } from "../install/repo-installation-store.js";
import { RepoInstallationStore } from "../install/repo-installation-store.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { buildGraphViewHtmlFromData, type GraphViewData } from "./graph-view/build-graph-view.js";
import { normalizeProposal } from "./proposal.js";
import type { GraphMemoryProvider, ManagedProposalReviewResult } from "./provider.js";
import type { ApplyProposalResult, GraphReadResult, RepoRef } from "./service.js";
import type { GraphContextResult } from "./graph-context/types.js";

export interface ManagedGraphClientOptions {
  apiUrl: string;
  token: string;
  credentials?: ManagedCredentials;
  fetchImpl?: typeof fetch;
}

interface AnchorDataResponse {
  claims: Claim[];
  fingerprints: Record<string, Record<string, string>>;
}

interface ApplyRequest {
  proposal: unknown;
  working_head: string;
  anchor_audit: ProposalAnchorAudit;
  commit?: { git_head?: string; branch?: string; dirty?: boolean };
}

interface ProposalAnchorAudit {
  result: ClaimAnchorAuditResult;
  fingerprints: Record<string, Record<string, string>>;
}

export class ManagedGraphMemoryClient implements GraphMemoryProvider {
  readonly mode = "managed" as const;
  private readonly apiUrl: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly installation: RepoInstallation,
    private readonly repo: RepoRef,
    options: ManagedGraphClientOptions,
  ) {
    if (installation.activeMode !== "managed" || installation.managedRepoId === undefined) {
      throw new Error("Managed provider requires a managed repository binding.");
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly credentials?: ManagedCredentials;

  readGraph(): Promise<GraphReadResult> {
    return this.request("/graph", { method: "GET" });
  }

  async contextGraph(query: string): Promise<GraphContextResult> {
    const result = await this.request<GraphContextResult>("/graph/context", { method: "POST", body: { query } });
    const resolver = new CodeAnchorResolver();
    const resolved = new Map<string, Awaited<ReturnType<CodeAnchorResolver["resolveMany"]>>>();
    for (const claim of result.claims) {
      const anchors = await resolver.resolveMany(this.repo.repo_root, claim.object.code_anchors);
      claim.code_anchors = anchors;
      resolved.set(claim.object.id, anchors);
    }
    for (const item of result.ranked_results) {
      if (item.type === "claim") item.code_anchors = resolved.get(item.object.id) ?? [];
    }
    return result;
  }

  viewData(): Promise<GraphViewData> {
    return this.request("/graph/view-data", { method: "GET" });
  }

  async buildGraphView(): Promise<string> {
    return buildGraphViewHtmlFromData(await this.viewData(), { repoName: this.repo.repo_name });
  }

  async auditCodeAnchors(): Promise<ClaimAnchorAuditResult> {
    const data = await this.request<AnchorDataResponse>("/graph/anchor-data", { method: "GET" });
    return auditClaimCodeAnchors(
      this.repo.repo_root,
      data.claims,
      undefined,
      new Map(Object.entries(data.fingerprints)),
    );
  }

  async reviewProposal(proposal: unknown): Promise<ManagedProposalReviewResult> {
    const anchorAudit = await this.proposalAnchorAudit(proposal);
    if (anchorAudit.result.missing_anchors.length > 0 ||
        anchorAudit.result.missing_files.length > 0 ||
        anchorAudit.result.missing_symbols.length > 0 ||
        anchorAudit.result.ambiguous_symbols.length > 0 ||
        anchorAudit.result.unsupported_languages.length > 0) {
      return {
        valid: false,
        errors: anchorAuditErrors(anchorAudit.result),
        duplicate_warnings: {},
      };
    }
    return this.request("/proposals/review", { method: "POST", body: { proposal, anchor_audit: anchorAudit } });
  }

  async applyProposal(proposal: unknown): Promise<ApplyProposalResult> {
    const anchorAudit = await this.proposalAnchorAudit(proposal);
    const review = await this.request<ManagedProposalReviewResult>("/proposals/review", {
      method: "POST",
      body: { proposal, anchor_audit: anchorAudit },
    });
    if (!review.valid) {
      throw new Error(`Proposal is invalid:\n${review.errors.map((error) => `- ${error}`).join("\n")}`);
    }
    if (review.working_head === undefined) throw new Error("Managed proposal review did not return a working head.");
    const body: ApplyRequest = {
      proposal,
      working_head: review.working_head,
      anchor_audit: anchorAudit,
      commit: localGitState(this.repo.repo_root),
    };
    return this.request("/proposals/apply", { method: "POST", body });
  }

  close(): void {}

  private async proposalAnchorAudit(proposal: unknown): Promise<ProposalAnchorAudit> {
    const normalized = normalizeProposal(proposal);
    const claims = normalized.creates.claims ?? [];
    const result = await auditClaimCodeAnchors(this.repo.repo_root, claims);
    const fingerprints: Record<string, Record<string, string>> = {};
    for (const claim of claims) {
      if (claim.code_anchors === undefined || claim.code_anchors.length === 0) continue;
      const values = await fingerprintClaimAnchors(this.repo.repo_root, claim.code_anchors);
      if (Object.keys(values).length > 0) fingerprints[claim.id] = values;
    }
    return { result, fingerprints };
  }

  private async request<T>(
    path: string,
    input: { method: "GET" | "POST"; body?: unknown },
  ): Promise<T> {
    const managedRepoId = this.installation.managedRepoId as string;
    const response = await this.fetchImpl(`${this.apiUrl}/v1/repos/${encodeURIComponent(managedRepoId)}${path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    await this.captureResponseMetadata(response, managedRepoId);
    const payload = await readJson(response);
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : `Managed Greplica request failed (${response.status}).`;
      const error = new Error(message) as Error & { status?: number; code?: string };
      error.status = response.status;
      if (isRecord(payload) && typeof payload.code === "string") error.code = payload.code;
      throw error;
    }
    return payload as T;
  }

  private async captureResponseMetadata(response: Response, managedRepoId: string): Promise<void> {
    const renewedToken = response.headers.get("x-greplica-token");
    if (renewedToken !== null && renewedToken.length > 0) {
      this.token = renewedToken;
      if (this.credentials !== undefined) {
        this.credentials.token = renewedToken;
        writeManagedCredentials(this.credentials);
      }
    }
    const role = response.headers.get("x-greplica-repo-role");
    const access = response.headers.get("x-greplica-access-status");
    if ((role === "reader" || role === "memory_admin") &&
        (access === "active" || access === "pending" || access === "suspended" || access === "revoked")) {
      const db = openDatabase();
      try {
        new RepoInstallationStore(db).updateManagedAccess(managedRepoId, role, access);
      } finally {
        db.close();
      }
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Managed Greplica returned invalid JSON (${response.status}).`);
  }
}

function anchorAuditErrors(result: ClaimAnchorAuditResult): string[] {
  return [
    ...result.missing_anchors.map((issue) => `${issue.claim_id} is code_verified but has no code anchors`),
    ...result.missing_files.map((issue) => `${issue.claim_id} references a missing file`),
    ...result.missing_symbols.map((issue) => `${issue.claim_id} references a missing symbol`),
    ...result.ambiguous_symbols.map((issue) => `${issue.claim_id} references an ambiguous symbol`),
    ...result.unsupported_languages.map((issue) => `${issue.claim_id} uses an unsupported anchor language`),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localGitState(repoRoot: string | undefined): ApplyRequest["commit"] {
  if (repoRoot === undefined) return undefined;
  const git = (args: string[]): string | undefined => {
    try {
      const value = execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return value.length === 0 ? undefined : value;
    } catch {
      return undefined;
    }
  };
  const gitHead = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const dirtyOutput = git(["status", "--porcelain"]);
  if (gitHead === undefined && branch === undefined && dirtyOutput === undefined) return undefined;
  return { git_head: gitHead, branch, dirty: dirtyOutput !== undefined };
}
