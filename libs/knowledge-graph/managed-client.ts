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
import type {
  ManagedGraphView,
  ManagedMemoryPr,
  ManagedMemoryStatus,
  ManagedProposal,
} from "../managed/protocol.js";
import {
  managedCapabilitiesHeader,
  managedClientCapabilities,
  managedClientVersion,
  managedClientVersionHeader,
  type ManagedClientCapability,
} from "../managed/protocol.js";

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
  working_revision?: number;
  main_head?: string;
  anchor_audit: ProposalAnchorAudit;
  commit?: ProposalCommitContext;
  context?: ProposalCommitContext;
}

interface ProposalAnchorAudit {
  result: ClaimAnchorAuditResult;
  fingerprints: Record<string, Record<string, string>>;
}

interface ProposalCommitContext {
  git_head?: string;
  head_repository?: string;
  head_ref?: string;
  branch?: string;
  dirty?: boolean;
  session_refs?: Array<{ id: string; agent_platform?: string }>;
  agent_platform?: string;
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

  readGraph(view?: ManagedGraphView): Promise<GraphReadResult> {
    return this.request(
      `/graph${viewQuery(this.requestView(view))}`,
      { method: "GET" },
      view === undefined ? undefined : "graph-selectors-v1",
    );
  }

  async contextGraph(query: string, view?: ManagedGraphView): Promise<GraphContextResult> {
    const requestView = this.requestView(view);
    const result = await this.request<GraphContextResult>(
      "/graph/context",
      {
        method: "POST",
        body: { query, ...(requestView === undefined ? {} : { view: requestView }) },
      },
      view === undefined ? undefined : "graph-selectors-v1",
    );
    const resolver = new CodeAnchorResolver();
    const resolved = new Map<string, Awaited<ReturnType<CodeAnchorResolver["resolveMany"]>>>();
    for (const claim of result.claims) {
      const anchors = await resolver.resolveMany(this.repo.repo_root, claim.object.code_anchors);
      claim.code_anchors = anchors;
      resolved.set(managedObjectKey(claim.object), anchors);
    }
    for (const item of result.ranked_results) {
      if (item.type === "claim") item.code_anchors = resolved.get(managedObjectKey(item.object)) ?? [];
    }
    return result;
  }

  viewData(view?: ManagedGraphView): Promise<GraphViewData> {
    return this.request(
      `/graph/view-data${viewQuery(this.requestView(view))}`,
      { method: "GET" },
      view === undefined ? undefined : "graph-selectors-v1",
    );
  }

  async buildGraphView(view?: ManagedGraphView): Promise<string> {
    return buildGraphViewHtmlFromData(await this.viewData(view), { repoName: this.repo.repo_name });
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
    const context = localProposalContext(this.repo, proposal);
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
    return this.request("/proposals/review", {
      method: "POST",
      body: { proposal, anchor_audit: anchorAudit, ...(context === undefined ? {} : { context }) },
    });
  }

  async applyProposal(proposal: unknown): Promise<ApplyProposalResult> {
    const anchorAudit = await this.proposalAnchorAudit(proposal);
    const context = localProposalContext(this.repo, proposal);
    const review = await this.request<ManagedProposalReviewResult>("/proposals/review", {
      method: "POST",
      body: { proposal, anchor_audit: anchorAudit, ...(context === undefined ? {} : { context }) },
    });
    if (!review.valid) {
      throw new Error(`Proposal is invalid:\n${review.errors.map((error) => `- ${error}`).join("\n")}`);
    }
    if (review.working_head === undefined) throw new Error("Managed proposal review did not return a working head.");
    const body: ApplyRequest = {
      proposal,
      working_head: review.working_head,
      working_revision: review.working_revision,
      main_head: review.main_head,
      anchor_audit: anchorAudit,
      commit: legacyCommitContext(context),
      context,
    };
    return this.request("/proposals/apply", { method: "POST", body });
  }

  listProposals(): Promise<ManagedProposal[]> {
    return this.request("/proposals", { method: "GET" });
  }

  showProposal(proposalId: string): Promise<ManagedProposal> {
    return this.request(`/proposals/${encodeURIComponent(proposalId)}`, { method: "GET" });
  }

  listMemoryPrs(): Promise<ManagedMemoryPr[]> {
    return this.request("/memory-prs", { method: "GET" });
  }

  showMemoryPr(memoryPrId: string): Promise<ManagedMemoryPr> {
    return this.request(`/memory-prs/${encodeURIComponent(memoryPrId)}`, { method: "GET" });
  }

  retryMemoryPr(memoryPrId: string): Promise<ManagedMemoryPr> {
    return this.request(`/memory-prs/${encodeURIComponent(memoryPrId)}/retry`, { method: "POST" });
  }

  memoryStatus(): Promise<ManagedMemoryStatus> {
    return this.request("/memory/status", { method: "GET" });
  }

  close(): void {}

  private requestView(view: ManagedGraphView | undefined): ManagedGraphView | undefined {
    if (view?.working_users === undefined || view.working_users.length === 0) return view;
    return {
      ...view,
      // The managed server always composes the authenticated user's working
      // scope when one exists. Send only explicit additional contributors so
      // readers without a personal scope can still inspect someone else's.
      working_users: uniqueGithubLogins(view.working_users),
    };
  }

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
    requiredCapability?: ManagedClientCapability,
  ): Promise<T> {
    const managedRepoId = this.installation.managedRepoId as string;
    const response = await this.fetchImpl(`${this.apiUrl}/v1/repos/${encodeURIComponent(managedRepoId)}${path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        [managedClientVersionHeader]: managedClientVersion,
        [managedCapabilitiesHeader]: managedClientCapabilities.join(","),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    await this.captureResponseMetadata(response, managedRepoId);
    if (response.ok && requiredCapability !== undefined && !responseCapabilities(response).has(requiredCapability)) {
      throw new Error(
        `Managed Greplica server does not acknowledge ${requiredCapability}; ` +
        "upgrade the server before using personal graph selectors.",
      );
    }
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
    if ((role === "reader" || role === "contributor" || role === "memory_admin") &&
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

function localProposalContext(repo: RepoRef, proposal: unknown): ProposalCommitContext | undefined {
  const repoRoot = repo.repo_root;
  const sessionRefIds = proposalSessionRefs(proposal);
  const agentPlatform = proposalAgentPlatform(sessionRefIds);
  const sessionRefs = sessionRefIds.map((id) => ({ id, agent_platform: platformForSessionRef(id) }));
  const headRepository = githubRepository(repo.remote_url);
  if (repoRoot === undefined) {
    if (sessionRefs.length === 0 && agentPlatform === undefined && headRepository === undefined) return undefined;
    return {
      head_repository: headRepository,
      session_refs: sessionRefs.length === 0 ? undefined : sessionRefs,
      agent_platform: agentPlatform,
    };
  }
  const git = (args: string[], preserveEmpty = false): string | undefined => {
    try {
      const value = execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return value.length === 0 && !preserveEmpty ? undefined : value;
    } catch {
      return undefined;
    }
  };
  const gitHead = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const dirtyOutput = git(["status", "--porcelain"], true);
  if (gitHead === undefined && branch === undefined && dirtyOutput === undefined &&
      sessionRefs.length === 0 && agentPlatform === undefined && headRepository === undefined) return undefined;
  return {
    git_head: gitHead,
    head_repository: headRepository,
    head_ref: branch,
    branch,
    dirty: dirtyOutput === undefined ? undefined : dirtyOutput.length > 0,
    session_refs: sessionRefs.length === 0 ? undefined : sessionRefs,
    agent_platform: agentPlatform,
  };
}

function legacyCommitContext(context: ProposalCommitContext | undefined): ProposalCommitContext | undefined {
  if (context === undefined) return undefined;
  const { git_head, branch, dirty } = context;
  if (git_head === undefined && branch === undefined && dirty === undefined) return undefined;
  return { git_head, branch, dirty };
}

function proposalSessionRefs(proposal: unknown): string[] {
  if (!isRecord(proposal) || !isRecord(proposal.creates) || !Array.isArray(proposal.creates.sources)) return [];
  const refs = proposal.creates.sources.flatMap((source) =>
    isRecord(source) && source.kind === "session" && typeof source.ref === "string" ? [source.ref] : []);
  return [...new Set(refs)];
}

function proposalAgentPlatform(sessionRefs: string[]): string | undefined {
  const platforms = new Set(sessionRefs.map(platformForSessionRef).filter((value): value is string => value !== undefined));
  return platforms.size === 1 ? [...platforms][0] : undefined;
}

function platformForSessionRef(ref: string): string | undefined {
  const separator = ref.indexOf(":");
  if (separator <= 0) return undefined;
  const prefix = ref.slice(0, separator);
  if (prefix === "claude-code-session") return "claude";
  if (prefix === "factory-droid-session") return "factory-droid";
  return prefix.endsWith("-session") ? prefix.slice(0, -"-session".length) : prefix;
}

function githubRepository(remoteUrl: string | undefined): string | undefined {
  if (remoteUrl === undefined) return undefined;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(remoteUrl);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function viewQuery(view: ManagedGraphView | undefined): string {
  if (view === undefined) return "";
  const query = new URLSearchParams({ base: view.base });
  if (view.working_users?.length === 0) {
    query.set("main_only", "true");
  }
  for (const user of view.working_users ?? []) query.append("working_user", user);
  if (view.memory_pr_id !== undefined) query.set("memory_pr_id", view.memory_pr_id);
  if (view.include_quarantined === true) query.set("include_quarantined", "true");
  return `?${query.toString()}`;
}

function uniqueGithubLogins(logins: string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((login) => {
    const key = login.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function responseCapabilities(response: Response): Set<string> {
  return new Set(
    (response.headers.get(managedCapabilitiesHeader) ?? "")
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean),
  );
}

function managedObjectKey(object: { id: string }): string {
  const provenance = (object as { provenance?: { version_id?: unknown } }).provenance;
  return typeof provenance?.version_id === "string" ? provenance.version_id : object.id;
}
