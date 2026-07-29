import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditClaimCodeAnchors } from "../../libs/knowledge-graph/code-anchors/audit.js";
import { fingerprintClaimAnchors } from "../../libs/knowledge-graph/code-anchors/fingerprint.js";
import { ensureGreplicaConfig, managedApiUrl } from "../../libs/config/greplica-config.js";
import type {
  ManagedReconciliationAttestation,
  ManagedReconciliationAttestationResult,
  ManagedReconciliationCandidate,
} from "../../libs/managed/protocol.js";

const defaultOidcAudience = "greplica-managed";

export async function runMemoryReconcile(args: string[]): Promise<void> {
  const managedRepoId = requiredOption(args, "--managed-repo");
  const mergeSha = requiredOption(args, "--merge-sha");
  const apiUrl = (optionalOption(args, "--api-url") ?? managedApiUrl(ensureGreplicaConfig())).replace(/\/+$/, "");
  const audience = optionalOption(args, "--oidc-audience") ?? defaultOidcAudience;
  const repository = optionalOption(args, "--repository") ?? process.env.GITHUB_REPOSITORY;
  if (repository === undefined || !repository.includes("/")) {
    throw new Error("--repository or GITHUB_REPOSITORY must identify the GitHub owner/repository.");
  }
  const repoRoot = resolve(optionalOption(args, "--repo-root") ?? process.cwd());
  assertExactCheckout(repoRoot, mergeSha);

  const oidcToken = await githubOidcToken(audience);
  const headers = {
    authorization: `Bearer ${oidcToken}`,
    accept: "application/json",
  };
  const repairProposalPath = optionalOption(args, "--repair-proposal");
  const repairProposalValue = repairProposalPath === undefined
    ? undefined
    : JSON.parse(readFileSync(resolve(repairProposalPath), "utf8")) as unknown;
  if (repairProposalValue !== undefined && !isRecord(repairProposalValue)) {
    throw new Error("--repair-proposal must contain a JSON object.");
  }
  const repairProposal = repairProposalValue;

  const reconciliations: Array<{
    response: ManagedReconciliationAttestationResult;
    memory_pr_id: string;
    audited_claim_versions: number;
    memory_commit_ids: string[];
  }> = [];
  const excludedMemoryPrIds: string[] = [];
  while (true) {
    const candidate = await reconciliationCandidate(
      apiUrl,
      managedRepoId,
      mergeSha,
      excludedMemoryPrIds,
      headers,
    );
    if (candidate === undefined) break;
    if (excludedMemoryPrIds.includes(candidate.memory_pr_id)) {
      throw new Error(`Managed reconciliation returned duplicate Memory PR ${candidate.memory_pr_id}.`);
    }
    verifyCandidate(candidate, mergeSha);
    const ancestry = candidate.commits.map((commit) => ({
      memory_commit_id: commit.memory_commit_id,
      git_head: commit.git_head,
      is_ancestor: isAncestor(repoRoot, commit.git_head, mergeSha),
    }));
    const auditClaims = candidate.claim_versions.map(({ version_id, claim }) => ({ ...claim, id: version_id }));
    const result = await auditClaimCodeAnchors(repoRoot, auditClaims);
    const fingerprints: Record<string, Record<string, string>> = {};
    for (const claim of auditClaims) {
      if (claim.code_anchors === undefined || claim.code_anchors.length === 0) continue;
      const values = await fingerprintClaimAnchors(repoRoot, claim.code_anchors);
      if (Object.keys(values).length > 0) fingerprints[claim.id] = values;
    }
    const attestation: ManagedReconciliationAttestation = {
      managed_repo_id: managedRepoId,
      repository,
      merge_sha: mergeSha,
      memory_pr_id: candidate.memory_pr_id,
      memory_commit_ids: candidate.memory_commit_ids,
      ancestry,
      audit_key: "version_id",
      anchor_audit: { result, fingerprints },
      ...(repairProposal === undefined ? {} : { repair_proposal: repairProposal }),
      ref: process.env.GITHUB_REF,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    };
    const response = await jsonRequest<ManagedReconciliationAttestationResult>(
      `${apiUrl}/v1/repos/${encodeURIComponent(managedRepoId)}/memory/reconcile/attest`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(attestation),
      },
    );
    reconciliations.push({
      response,
      memory_pr_id: response.memory_pr_id ?? candidate.memory_pr_id,
      audited_claim_versions: candidate.claim_versions.length,
      memory_commit_ids: candidate.memory_commit_ids,
    });
    excludedMemoryPrIds.push(candidate.memory_pr_id);
  }
  console.log(JSON.stringify({
    accepted: reconciliations.every(({ response }) => response.accepted),
    merge_sha: mergeSha,
    reconciliation_count: reconciliations.length,
    reconciliations,
  }, null, 2));
}

async function reconciliationCandidate(
  apiUrl: string,
  managedRepoId: string,
  mergeSha: string,
  excludedMemoryPrIds: string[],
  headers: Record<string, string>,
): Promise<ManagedReconciliationCandidate | undefined> {
  const query = new URLSearchParams({ merge_sha: mergeSha });
  for (const memoryPrId of excludedMemoryPrIds) query.append("exclude_memory_pr", memoryPrId);
  try {
    return await jsonRequest<ManagedReconciliationCandidate>(
      `${apiUrl}/v1/repos/${encodeURIComponent(managedRepoId)}/memory/reconcile/candidate?${query.toString()}`,
      { method: "GET", headers },
    );
  } catch (error) {
    if (error instanceof ManagedReconciliationHttpError && error.status === 404) return undefined;
    throw error;
  }
}

function verifyCandidate(candidate: ManagedReconciliationCandidate, mergeSha: string): void {
  if (candidate.merge_sha !== mergeSha) {
    throw new Error(`Managed reconciliation candidate is bound to ${candidate.merge_sha}, not ${mergeSha}.`);
  }
  if (candidate.memory_commit_ids.length === 0) throw new Error("Managed reconciliation candidate has no memory commits.");
  const candidateIds = [...candidate.memory_commit_ids].sort();
  const commitIds = candidate.commits.map((commit) => commit.memory_commit_id).sort();
  if (JSON.stringify(candidateIds) !== JSON.stringify(commitIds)) {
    throw new Error("Managed reconciliation candidate commit metadata does not match its selected commit IDs.");
  }
}

function isAncestor(repoRoot: string, gitHead: string, mergeSha: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", gitHead, mergeSha], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function assertExactCheckout(repoRoot: string, mergeSha: string): void {
  const git = (arguments_: string[]): string => execFileSync("git", ["-C", repoRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const head = git(["rev-parse", "HEAD"]);
  if (head !== mergeSha) throw new Error(`Checked-out HEAD ${head} does not equal requested merge SHA ${mergeSha}.`);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.length > 0) throw new Error("Reconciliation requires a clean exact-SHA checkout.");
}

async function githubOidcToken(audience: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (requestUrl === undefined || requestToken === undefined) {
    throw new Error("GitHub Actions OIDC is unavailable; grant the workflow `id-token: write`.");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
  });
  const payload = await response.json() as unknown;
  if (!response.ok || !isRecord(payload) || typeof payload.value !== "string") {
    throw new Error(`GitHub Actions OIDC request failed (${response.status}).`);
  }
  return payload.value;
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = {};
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Managed Greplica returned invalid JSON (${response.status}).`);
    }
  }
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string"
      ? payload.message
      : `Managed Greplica reconciliation failed (${response.status}).`;
    throw new ManagedReconciliationHttpError(response.status, message);
  }
  return payload as T;
}

class ManagedReconciliationHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ManagedReconciliationHttpError";
  }
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (value === undefined) throw new Error(`Missing ${name}.`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
      return value;
    }
    if (args[index]?.startsWith(`${name}=`)) return args[index]?.slice(name.length + 1);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
