import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { auditClaimCodeAnchors } from "../../libs/knowledge-graph/code-anchors/audit.js";
import {
  buildReconciliationCodeEvidence,
  isReconciliationCodeEvidenceEntryActionable,
} from "../../libs/knowledge-graph/code-anchors/evidence.js";
import {
  anchorFingerprintKey,
  fingerprintClaimAnchors,
} from "../../libs/knowledge-graph/code-anchors/fingerprint.js";
import { ensureGreplicaConfig, managedApiUrl } from "../../libs/config/greplica-config.js";
import type {
  ManagedReconciliationAttestation,
  ManagedReconciliationAttestationResult,
  ManagedReconciliationCandidate,
  ManagedReconciliationCodeEvidence,
  ManagedReconciliationRejection,
  ManagedReconciliationRejectionResult,
} from "../../libs/managed/protocol.js";
import {
  managedCapabilitiesHeader,
  managedClientCapabilities,
  managedClientVersion,
  managedClientVersionHeader,
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
    [managedClientVersionHeader]: managedClientVersion,
    [managedCapabilitiesHeader]: managedClientCapabilities.join(","),
  };
  const reconciliations: Array<{
    response: ManagedReconciliationAttestationResult;
    memory_pr_id: string;
    audited_claim_versions: number;
    audited_component_versions: number;
    code_evidence_entries?: number;
    memory_commit_ids: string[];
  }> = [];
  const skipped: Array<{
    memory_pr_id: string;
    reason: "code_merge_not_ancestor" | "git_head_not_ancestor" | "git_head_not_in_pr_delta";
    memory_commit_ids: string[];
    code_merge_sha?: string;
    code_merge_is_ancestor?: boolean;
    response: ManagedReconciliationRejectionResult;
  }> = [];
  const excludedMemoryPrIds: string[] = [];
  const rejectedGenerations = new Set<string>();
  let candidateIterations = 0;
  while (true) {
    candidateIterations += 1;
    if (candidateIterations > 1_000) {
      throw new Error("Managed reconciliation exceeded its bounded candidate iteration limit.");
    }
    assertCurrentRemoteDefaultHead(repoRoot, mergeSha, process.env.GITHUB_REF);
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
    const codeMergeSha = candidate.code_merge_sha?.toLowerCase();
    const codeMergeIsAncestor = codeMergeSha === undefined
      ? undefined
      : hasGitCommit(repoRoot, codeMergeSha) && isAncestor(repoRoot, codeMergeSha, mergeSha);
    const verifiedRanges = new Map<string, VerifiedPrRange>();
    const proofs = candidate.commits.map((commit) => {
      const proofMode = commit.proof_mode ?? "default_ancestry";
      let targetSha = mergeSha;
      let verifiedBaseSha: string | undefined;
      let mergeBaseSha: string | undefined;
      if (proofMode === "pr_head") {
        const key = [
          commit.code_pr_number,
          commit.verified_head_sha,
          commit.verified_base_sha ?? "",
        ].join(":");
        let range = verifiedRanges.get(key);
        if (range === undefined) {
          range = verifiedPrRange(
            repoRoot,
            commit.code_pr_number,
            commit.verified_head_sha,
            commit.verified_base_sha,
          );
          verifiedRanges.set(key, range);
        }
        targetSha = range.headSha;
        verifiedBaseSha = range.baseSha;
        mergeBaseSha = range.mergeBaseSha;
      }
      const isAncestorOfTarget = isAncestor(repoRoot, commit.git_head, targetSha);
      const isInPrDelta = proofMode !== "pr_head" ||
        mergeBaseSha === undefined ||
        (
          isAncestorOfTarget &&
          commit.git_head.toLowerCase() !== mergeBaseSha &&
          isAncestor(repoRoot, mergeBaseSha, commit.git_head)
        );
      return {
        ancestry: {
          memory_commit_id: commit.memory_commit_id,
          git_head: commit.git_head,
          proof_mode: proofMode,
          ...(proofMode === "pr_head" ? {
            verified_head_sha: targetSha,
            ...(verifiedBaseSha === undefined ? {} : { verified_base_sha: verifiedBaseSha }),
          } : {}),
          is_ancestor: isAncestorOfTarget,
        },
        isInPrDelta,
      };
    });
    const nonAncestors = proofs.filter((proof) => !proof.ancestry.is_ancestor);
    const outsidePrDelta = proofs.filter((proof) =>
      proof.ancestry.is_ancestor && !proof.isInPrDelta
    );
    const ancestry = proofs.map((proof) => proof.ancestry);
    if (codeMergeIsAncestor === false || nonAncestors.length > 0 || outsidePrDelta.length > 0) {
      const failures = nonAncestors.length > 0 ? nonAncestors : outsidePrDelta;
      const reason = codeMergeIsAncestor === false
        ? "code_merge_not_ancestor" as const
        : nonAncestors.length > 0
          ? "git_head_not_ancestor" as const
          : "git_head_not_in_pr_delta" as const;
      const rejectedMemoryCommitIds = reason === "code_merge_not_ancestor"
        ? []
        : failures.map((proof) => proof.ancestry.memory_commit_id);
      const generationKey = JSON.stringify({
        memory_pr_id: candidate.memory_pr_id,
        memory_commit_ids: [...candidate.memory_commit_ids].sort(),
        rejected_memory_commit_ids: [...rejectedMemoryCommitIds].sort(),
        code_merge_sha: codeMergeSha,
        code_merge_is_ancestor: codeMergeIsAncestor,
        reason,
        ancestry,
      });
      if (rejectedGenerations.has(generationKey)) {
        throw new Error(
          `Managed reconciliation returned rejected Memory PR generation ${candidate.memory_pr_id} again.`,
        );
      }
      rejectedGenerations.add(generationKey);
      const observedDefaultHeadSha = assertCurrentRemoteDefaultHead(
        repoRoot,
        mergeSha,
        process.env.GITHUB_REF,
      );
      const rejection: ManagedReconciliationRejection = {
        managed_repo_id: managedRepoId,
        repository,
        merge_sha: mergeSha,
        code_merge_sha: codeMergeSha,
        code_merge_is_ancestor: codeMergeIsAncestor,
        memory_pr_id: candidate.memory_pr_id,
        memory_commit_ids: candidate.memory_commit_ids,
        rejected_memory_commit_ids: rejectedMemoryCommitIds,
        ancestry,
        reason,
        observed_default_head_sha: observedDefaultHeadSha,
        ref: process.env.GITHUB_REF,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      };
      const response = await jsonRequest<ManagedReconciliationRejectionResult>(
        `${apiUrl}/v1/repos/${encodeURIComponent(managedRepoId)}/memory/reconcile/reject`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(rejection),
        },
      );
      if (!response.accepted || response.memory_pr_id !== candidate.memory_pr_id) {
        throw new Error(`Managed service did not persist rejected Memory PR ${candidate.memory_pr_id}.`);
      }
      skipped.push({
        memory_pr_id: candidate.memory_pr_id,
        reason,
        memory_commit_ids: rejectedMemoryCommitIds,
        code_merge_sha: codeMergeSha,
        code_merge_is_ancestor: codeMergeIsAncestor,
        response,
      });
      continue;
    }
    const auditClaims = candidate.claim_versions.map(({ version_id, claim }) => ({ ...claim, id: version_id }));
    const componentAuditClaims = (candidate.component_versions ?? []).flatMap(({ version_id, component }) => {
      const anchors = componentCodeAnchors(component.code_anchor);
      if (anchors.length === 0) return [];
      return [{
        id: version_id,
        kind: "fact" as const,
        text: `Component anchor for ${component.name}`,
        truth: "code_verified" as const,
        intent: "intended" as const,
        code_anchors: anchors,
      }];
    });
    const auditedObjects = [...auditClaims, ...componentAuditClaims];
    const baselineFingerprints = new Map(
      [...candidate.claim_versions, ...(candidate.component_versions ?? [])]
        .filter(({ baseline_fingerprints }) => baseline_fingerprints !== undefined)
        .map(({ version_id, baseline_fingerprints }) => [version_id, baseline_fingerprints!]),
    );
    const codeEvidence = candidate.code_evidence_required === true
      ? await buildReconciliationCodeEvidence(repoRoot, {
        managedRepoId,
        repository,
        attestedGitSha: mergeSha,
        anchors: [
          ...candidate.claim_versions.flatMap(({ version_id, claim }) =>
            (claim.code_anchors ?? []).map((anchor) => ({
              versionId: version_id,
              objectType: "claim" as const,
              anchor,
            }))
          ),
          ...(candidate.component_versions ?? []).flatMap(({ version_id, component }) =>
            componentCodeAnchors(component.code_anchor).map((anchor) => ({
              versionId: version_id,
              objectType: "component" as const,
              anchor,
            }))
          ),
        ],
      })
      : undefined;
    let anchorAudit: ManagedReconciliationAttestation["anchor_audit"];
    if (codeEvidence !== undefined) {
      anchorAudit = anchorAuditFromCodeEvidence(candidate, codeEvidence);
    } else {
      const result = await auditClaimCodeAnchors(
        repoRoot,
        auditedObjects,
        undefined,
        baselineFingerprints,
      );
      const fingerprints: Record<string, Record<string, string>> = {};
      for (const claim of auditClaims) {
        if (claim.code_anchors === undefined || claim.code_anchors.length === 0) continue;
        const values = await fingerprintClaimAnchors(repoRoot, claim.code_anchors);
        if (Object.keys(values).length > 0) fingerprints[claim.id] = values;
      }
      for (const component of componentAuditClaims) {
        fingerprints[component.id] = await fingerprintClaimAnchors(repoRoot, component.code_anchors);
      }
      anchorAudit = { result, fingerprints };
    }
    const observedDefaultHeadSha = assertCurrentRemoteDefaultHead(
      repoRoot,
      mergeSha,
      process.env.GITHUB_REF,
    );
    const attestation: ManagedReconciliationAttestation = {
      managed_repo_id: managedRepoId,
      repository,
      merge_sha: mergeSha,
      code_merge_sha: codeMergeSha,
      code_merge_is_ancestor: codeMergeIsAncestor,
      memory_pr_id: candidate.memory_pr_id,
      memory_commit_ids: candidate.memory_commit_ids,
      ancestry,
      audit_key: "version_id",
      anchor_audit: anchorAudit,
      code_evidence: codeEvidence,
      observed_default_head_sha: observedDefaultHeadSha,
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
      audited_component_versions: candidate.component_versions?.length ?? 0,
      ...(codeEvidence === undefined ? {} : { code_evidence_entries: codeEvidence.entries.length }),
      memory_commit_ids: candidate.memory_commit_ids,
    });
    excludedMemoryPrIds.push(candidate.memory_pr_id);
  }
  const accepted = reconciliations.every(({ response }) => response.accepted);
  console.log(JSON.stringify({
    accepted,
    merge_sha: mergeSha,
    reconciliation_count: reconciliations.length,
    skipped_count: skipped.length,
    reconciliations,
    skipped,
  }, null, 2));
  if (!accepted) process.exitCode = 1;
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
  if (candidate.code_merge_sha !== undefined && !/^[0-9a-f]{40}$/i.test(candidate.code_merge_sha)) {
    throw new Error("Managed reconciliation candidate has an invalid code merge SHA.");
  }
  if (candidate.code_evidence_required !== undefined && candidate.code_evidence_required !== true) {
    throw new Error("Managed reconciliation candidate has an invalid code evidence requirement.");
  }
  const candidateIds = [...candidate.memory_commit_ids].sort();
  const commitIds = candidate.commits.map((commit) => commit.memory_commit_id).sort();
  if (JSON.stringify(candidateIds) !== JSON.stringify(commitIds)) {
    throw new Error("Managed reconciliation candidate commit metadata does not match its selected commit IDs.");
  }
  const objectVersionIds = [
    ...candidate.claim_versions.map((version) => version.version_id),
    ...(candidate.component_versions ?? []).map((version) => version.version_id),
  ];
  if (new Set(objectVersionIds).size !== objectVersionIds.length) {
    throw new Error("Managed reconciliation candidate has duplicate graph object version IDs.");
  }
  for (const version of candidate.component_versions ?? []) {
    if (
      version.component.code_anchor !== undefined &&
      typeof version.component.code_anchor !== "string"
    ) {
      throw new Error(`Component version ${version.version_id} has an invalid code anchor.`);
    }
  }
  for (const commit of candidate.commits) {
    if (!/^[0-9a-f]{40}$/i.test(commit.git_head)) {
      throw new Error(`Memory commit ${commit.memory_commit_id} has an invalid Git head.`);
    }
    if (commit.proof_mode === "pr_head" &&
        (commit.code_pr_number === undefined || commit.verified_head_sha === undefined)) {
      throw new Error(`Memory commit ${commit.memory_commit_id} is missing its verified PR-head proof.`);
    }
    if (commit.verified_base_sha !== undefined && !/^[0-9a-f]{40}$/i.test(commit.verified_base_sha)) {
      throw new Error(`Memory commit ${commit.memory_commit_id} has an invalid verified PR base SHA.`);
    }
  }
}

function anchorAuditFromCodeEvidence(
  candidate: ManagedReconciliationCandidate,
  evidence: ManagedReconciliationCodeEvidence,
): ManagedReconciliationAttestation["anchor_audit"] {
  type AuditResult = ManagedReconciliationAttestation["anchor_audit"]["result"];
  const unverifiable: NonNullable<AuditResult["unverifiable"]> = [];
  const result: AuditResult = {
    missing_anchors: candidate.claim_versions
      .filter(({ claim }) =>
        claim.truth === "code_verified" &&
        (claim.code_anchors === undefined || claim.code_anchors.length === 0)
      )
      .map(({ version_id }) => ({
        claim_id: version_id,
        status: "missing_anchors" as const,
      }))
      .sort((left, right) => compareText(left.claim_id, right.claim_id)),
    missing_files: [],
    missing_symbols: [],
    ambiguous_symbols: [],
    unsupported_languages: [],
    drifted: [],
    unverifiable,
  };
  const fingerprints: ManagedReconciliationAttestation["anchor_audit"]["fingerprints"] = {};
  const baselines = new Map(
    [...candidate.claim_versions, ...(candidate.component_versions ?? [])]
      .map(({ version_id, baseline_fingerprints }) => [version_id, baseline_fingerprints]),
  );

  for (const entry of evidence.entries) {
    fingerprints[entry.version_id] ??= {};
    if (entry.anchor_fingerprint !== undefined) {
      fingerprints[entry.version_id][anchorFingerprintKey(entry.anchor)] = entry.anchor_fingerprint;
    }
    const issue = {
      claim_id: entry.version_id,
      anchor: entry.anchor,
    };
    switch (entry.status) {
      case "missing_file":
        result.missing_files.push({ ...issue, status: "missing_file" });
        break;
      case "missing_symbol":
        result.missing_symbols.push({ ...issue, status: "missing_symbol" });
        break;
      case "ambiguous_symbol":
        result.ambiguous_symbols.push({ ...issue, status: "ambiguous_symbol" });
        break;
      case "unsupported_language":
        result.unsupported_languages.push({ ...issue, status: "unsupported_language" });
        break;
      case "omitted":
        unverifiable.push({
          ...issue,
          status: "unverifiable",
          omission_reason: entry.omission_reason ?? "no_resolved_span",
        });
        break;
      case "resolved":
      case "file_only": {
        if (!isReconciliationCodeEvidenceEntryActionable(entry)) {
          unverifiable.push({
            ...issue,
            status: "unverifiable",
            omission_reason: entry.omission_reason ?? "no_resolved_span",
          });
          break;
        }
        const stored = baselines.get(entry.version_id)?.[anchorFingerprintKey(entry.anchor)];
        if (stored !== undefined && stored !== entry.anchor_fingerprint) {
          result.drifted.push({ ...issue, status: "drifted" });
        }
        break;
      }
    }
  }

  return { result, fingerprints };
}

function componentCodeAnchors(codeAnchor: string | undefined): Array<{ file: string }> {
  if (codeAnchor === undefined) return [];
  return codeAnchor
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .map((file) => ({ file }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

interface VerifiedPrRange {
  headSha: string;
  baseSha?: string;
  mergeBaseSha?: string;
}

function verifiedPrRange(
  repoRoot: string,
  pullRequestNumber: number | undefined,
  verifiedHeadSha: string | undefined,
  verifiedBaseSha: string | undefined,
): VerifiedPrRange {
  if (pullRequestNumber === undefined || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("PR-head proof is missing a valid code PR number.");
  }
  if (verifiedHeadSha === undefined || !/^[0-9a-f]{40}$/i.test(verifiedHeadSha)) {
    throw new Error(`PR #${pullRequestNumber} proof is missing a full verified head SHA.`);
  }
  try {
    execFileSync(
      "git",
      ["-C", repoRoot, "fetch", "--no-tags", "origin", `refs/pull/${pullRequestNumber}/head`],
      { stdio: "ignore" },
    );
  } catch {
    throw new Error(`Could not fetch the verified head for PR #${pullRequestNumber}.`);
  }
  const fetchedHead = execFileSync("git", ["-C", repoRoot, "rev-parse", "FETCH_HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().toLowerCase();
  if (fetchedHead !== verifiedHeadSha.toLowerCase()) {
    throw new Error(
      `PR #${pullRequestNumber} head ${fetchedHead} does not match verified head ${verifiedHeadSha}.`,
    );
  }
  if (!hasGitCommit(repoRoot, verifiedHeadSha)) {
    throw new Error(`Verified head ${verifiedHeadSha} for PR #${pullRequestNumber} is unavailable.`);
  }
  const headSha = verifiedHeadSha.toLowerCase();
  if (verifiedBaseSha === undefined) return { headSha };
  if (!/^[0-9a-f]{40}$/i.test(verifiedBaseSha)) {
    throw new Error(`PR #${pullRequestNumber} proof is missing a full verified base SHA.`);
  }
  const baseSha = verifiedBaseSha.toLowerCase();
  if (!hasGitCommit(repoRoot, baseSha)) {
    throw new Error(`Verified base ${verifiedBaseSha} for PR #${pullRequestNumber} is unavailable.`);
  }
  let mergeBaseSha: string;
  try {
    mergeBaseSha = execFileSync("git", ["-C", repoRoot, "merge-base", baseSha, headSha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
  } catch {
    throw new Error(`Could not establish the verified commit range for PR #${pullRequestNumber}.`);
  }
  if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) {
    throw new Error(`PR #${pullRequestNumber} has an invalid verified merge base.`);
  }
  return { headSha, baseSha, mergeBaseSha };
}

function hasGitCommit(repoRoot: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assertCurrentRemoteDefaultHead(
  repoRoot: string,
  mergeSha: string,
  githubRef: string | undefined,
): string {
  if (githubRef === undefined || !githubRef.startsWith("refs/heads/")) {
    throw new Error("Reconciliation requires GITHUB_REF to identify the default branch.");
  }
  try {
    execFileSync("git", ["-C", repoRoot, "check-ref-format", githubRef], { stdio: "ignore" });
  } catch {
    throw new Error(`Reconciliation default ref ${githubRef} is invalid.`);
  }
  const observedRef = "refs/greplica/reconciliation-default-head";
  try {
    execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "fetch",
        "--force",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        `+${githubRef}:${observedRef}`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    throw new Error(`Could not fetch current default ref ${githubRef} from the caller repository.`);
  }
  const observed = execFileSync("git", ["-C", repoRoot, "rev-parse", observedRef], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().toLowerCase();
  if (observed !== mergeSha.toLowerCase()) {
    throw new Error(
      `Current remote default head ${observed} does not equal requested merge SHA ${mergeSha}; ` +
      "historical workflow reruns cannot reconcile memory.",
    );
  }
  return observed;
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
    redirect: "error",
  });
  const payload = await response.json() as unknown;
  if (!response.ok || !isRecord(payload) || typeof payload.value !== "string") {
    throw new Error(`GitHub Actions OIDC request failed (${response.status}).`);
  }
  return payload.value;
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
  });
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
