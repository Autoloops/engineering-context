import { normalizeProposal } from "./proposal.js";
import { validateProposal, type ProposalValidationResult } from "./validate-proposal.js";
import type { Claim } from "./claim.js";
import type { Edge } from "./edge.js";
import type { Component, Flow, Source } from "./schema.js";
import { GraphContextBuilder } from "./graph-context/context-builder.js";
import { graphContextConfig, type GraphContextConfig } from "./graph-context/config.js";
import type { EmbeddingStatus, GraphContextResult } from "./graph-context/types.js";
import { buildGraphViewHtml } from "./graph-view/build-graph-view.js";
import { auditClaimCodeAnchors } from "./code-anchors/audit.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import { scanDriftedClaims, type DriftScanError } from "./code-anchors/drift.js";
import { CodeAnchorResolver } from "./code-anchors/resolver.js";
import { hashAnchorSpan, statAnchorFile } from "./code-anchors/span-hash.js";
import { classifyFreshness, hasContentDrift, type AnchorCheck, type FreshnessVerdict } from "./code-anchors/freshness.js";
import { freshnessChecks, indexFingerprintsByClaim } from "./anchor-fingerprints.js";
import { changedFilesSince } from "./changed-files.js";
import { buildAnchorInvalidation, type ClaimDemotion } from "./anchor-invalidation.js";
import type { ResolvedCodeAnchorStatus } from "./code-anchors/types.js";
import { gitHeadSha } from "../utils/git.js";
import { defaultDatabasePath, openDatabase } from "../storage/sqlite/db.js";
import type { AnchorFingerprintInput, SqliteRepository } from "../storage/sqlite/repository.js";
import { SqliteRepository as SqliteKnowledgeGraphRepository } from "../storage/sqlite/repository.js";

export type { GraphContextResult } from "./graph-context/types.js";
export type { ClaimAnchorAuditResult } from "./code-anchors/types.js";

export interface RepoRef {
  repo_root?: string;
  remote_url?: string;
  repo_name: string;
  default_branch: string;
}

export interface InitRepoResult {
  repo_id: string;
  main_scope_id: string;
  working_scope_id: string;
  database_path: string;
  created: boolean;
}

export interface GraphReadResult {
  components: Component[];
  flows: Flow[];
  claims: Claim[];
  sources: Source[];
  edges: Edge[];
}

export interface ApplyProposalResult {
  memory_commit_id: string;
  scope_id: string;
  embedding_status: EmbeddingStatus;
  created: {
    components: number;
    flows: number;
    claims: number;
    sources: number;
    edges: number;
  };
}

export interface AnchorInvalidationRecord {
  claim_id: string;
  superseding_claim_id: string;
  broken_anchor: string;
  resolver_status: ResolvedCodeAnchorStatus;
}

export interface AnchorInvalidationResult {
  memory_commit_id?: string;
  invalidated: AnchorInvalidationRecord[];
  errors: DriftScanError[];
}

export interface HealResult {
  demoted: string[];
  rechecked: number;
  headSha?: string;
}

export class KnowledgeGraphService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly contextConfig: GraphContextConfig = graphContextConfig,
    private readonly contextBuilder = new GraphContextBuilder(repository),
  ) {}

  initRepo(input: RepoRef): InitRepoResult {
    const { repo, created } = this.repository.upsertRepo(input);
    const main = this.repository.ensureScope({
      repo_id: repo.id,
      kind: "main",
      name: input.default_branch,
      ref: input.default_branch,
    });
    const working = this.repository.ensureScope({
      repo_id: repo.id,
      kind: "working",
      name: "working",
      parent_scope_id: main.id,
      ref: "working",
    });

    return {
      repo_id: repo.id,
      main_scope_id: main.id,
      working_scope_id: working.id,
      database_path: defaultDatabasePath(),
      created,
    };
  }

  requireRepo(input: RepoRef): InitRepoResult {
    const repo = this.repository.requireRepo(input);
    const main = this.repository.requireMainScope(repo.id);
    const working = this.repository.requireWorkingScope(repo.id);

    return {
      repo_id: repo.id,
      main_scope_id: main.id,
      working_scope_id: working.id,
      database_path: defaultDatabasePath(),
      created: false,
    };
  }

  readGraph(input: RepoRef): GraphReadResult {
    const initialized = this.requireRepo(input);
    return this.repository.readGraphView(initialized.repo_id);
  }

  buildGraphView(input: RepoRef): string {
    const initialized = this.requireRepo(input);
    const graph = this.repository.readGraphView(initialized.repo_id);
    const provenance = this.repository.readClaimProvenance(initialized.repo_id);
    const supersededClaims = this.repository.readSupersededClaims(initialized.repo_id);
    return buildGraphViewHtml(graph, provenance, supersededClaims, { repoName: input.repo_name });
  }

  async contextGraph(input: RepoRef, query: string): Promise<GraphContextResult> {
    const initialized = this.requireRepo(input);
    return this.contextBuilder.build(initialized.repo_id, this.repository.readGraphView(initialized.repo_id), query, {
      config: this.contextConfig,
      warnOnCreatedEmbeddings: true,
      repoRoot: input.repo_root,
    });
  }

  async auditCodeAnchors(input: RepoRef): Promise<ClaimAnchorAuditResult> {
    const initialized = this.requireRepo(input);
    return auditClaimCodeAnchors(input.repo_root, this.repository.readGraphView(initialized.repo_id).claims);
  }

  async validateProposal(input: RepoRef, proposal: unknown): Promise<ProposalValidationResult> {
    this.requireRepo(input);
    const normalizedProposal = normalizeProposal(proposal, this.repository);
    const validation = validateProposal(normalizedProposal, this.repository);
    if (!validation.valid) return validation;

    const anchorErrors = anchorAuditErrors(
      await auditClaimCodeAnchors(input.repo_root, normalizedProposal.creates.claims ?? []),
    );
    if (anchorErrors.length === 0) return validation;

    return {
      valid: false,
      errors: anchorErrors,
    };
  }

  async applyProposal(input: RepoRef, proposal: unknown): Promise<ApplyProposalResult> {
    const normalizedProposal = normalizeProposal(proposal, this.repository);
    const validation = await this.validateProposal(input, normalizedProposal);
    if (!validation.valid) {
      throw new Error(`Proposal is invalid:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }

    const initialized = this.requireRepo(input);
    const working = this.repository.requireWorkingScope(initialized.repo_id);
    const memoryCommit = this.repository.createMemoryCommit({
      scope_id: working.id,
      title: normalizedProposal.title,
      summary: normalizedProposal.summary,
    });

    this.repository.createProposalRecords(working.id, memoryCommit.id, normalizedProposal);
    const embeddingStatus = await this.contextBuilder.ensureForGraph(
      initialized.repo_id,
      this.repository.readGraphView(initialized.repo_id),
      this.contextConfig,
    );

    await this.writeFingerprints(initialized.repo_id, input, normalizedProposal.creates.claims ?? []);

    return {
      memory_commit_id: memoryCommit.id,
      scope_id: working.id,
      embedding_status: embeddingStatus,
      created: {
        components: normalizedProposal.creates.components?.length ?? 0,
        flows: normalizedProposal.creates.flows?.length ?? 0,
        claims: normalizedProposal.creates.claims?.length ?? 0,
        sources: normalizedProposal.creates.sources?.length ?? 0,
        edges: normalizedProposal.creates.edges?.length ?? 0,
      },
    };
  }

  /**
   * Records a content fingerprint per anchor of every `code_verified` claim, so
   * later reads/heals can tell whether the anchored code has since changed.
   *
   * Best effort, and deliberately non-throwing: the proposal is already durably
   * persisted by the time this runs, so a fingerprinting failure (an unreadable
   * span, a resolver hiccup) must not turn a successful apply into a failed one.
   */
  private async writeFingerprints(repoId: string, input: RepoRef, claims: Claim[]): Promise<void> {
    try {
      const resolver = new CodeAnchorResolver();
      const rows: AnchorFingerprintInput[] = [];
      for (const claim of claims) {
        const anchors = claim.code_anchors ?? [];
        if (claim.truth !== "code_verified" || anchors.length === 0) continue;
        const resolved = await resolver.resolveMany(input.repo_root, anchors);
        for (const anchor of resolved) {
          const contentHash = hashAnchorSpan(input.repo_root, anchor);
          if (contentHash === undefined) continue;
          const stat = statAnchorFile(input.repo_root, anchor.file);
          rows.push({
            repo_id: repoId,
            claim_id: claim.id,
            file: anchor.file,
            symbol: anchor.symbol ?? "", // "" sentinel for file-only anchors (see schema)
            content_hash: contentHash,
            file_mtime_ms: stat.mtime_ms,
            file_size: stat.size,
            resolver_status: anchor.status,
          });
        }
      }
      this.repository.upsertAnchorFingerprints(rows);
    } catch {
      // Freshness metadata is an optimization; never fail apply over it.
    }
  }

  /**
   * Re-verifies every code_verified claim's anchors and demotes the ones that
   * have fully drifted to `truth: unknown`, non-destructively (via supersession)
   * and atomically. Returns the demotions plus any per-claim detection errors.
   * The report-only `auditCodeAnchors` is left untouched.
   */
  async invalidateDriftedAnchors(input: RepoRef): Promise<AnchorInvalidationResult> {
    const initialized = this.requireRepo(input);
    const graph = this.repository.readGraphView(initialized.repo_id);
    const { drifted, errors } = await scanDriftedClaims(input.repo_root, graph.claims);

    if (drifted.length === 0) {
      return { invalidated: [], errors };
    }

    // buildAnchorInvalidation already returns a normalized proposal (edge ids
    // minted via an in-memory graph lookup), so no further normalization here.
    // scanDriftedClaims only finds structural drift, so every demotion is structural.
    const demotions = drifted.map((d) => ({ claim: d.claim, reason: "structural" as const, anchors: d.broken }));
    const { proposal, events } = buildAnchorInvalidation(demotions, graph);
    const working = this.repository.requireWorkingScope(initialized.repo_id);
    const { memory_commit_id } = this.repository.applyAnchorInvalidation({
      repoId: initialized.repo_id,
      scopeId: working.id,
      proposal,
      events,
      commit: { title: proposal.title, git_commit_sha: gitHeadSha(input.repo_root) },
    });

    // Embed the rebuilt claims so they stay retrievable via graph context.
    await this.contextBuilder.ensureForGraph(
      initialized.repo_id,
      this.repository.readGraphView(initialized.repo_id),
      this.contextConfig,
    );

    return {
      memory_commit_id,
      invalidated: events.map((event) => ({
        claim_id: event.original_claim_id,
        superseding_claim_id: event.superseding_claim_id,
        broken_anchor: event.broken_anchor,
        resolver_status: event.resolver_status,
      })),
      errors,
    };
  }

  /**
   * Change-scoped background heal. Re-checks only claims whose anchored files
   * changed since `sinceSha` (undefined = full sweep), demotes the genuinely
   * stale ones — structural OR content — through the same supersession writer as
   * #96, drops their fingerprints, and advances the freshness checkpoint. Never
   * demotes on `unknown` (unreadable / undeterminable). Deterministic: no agent.
   */
  async healDriftedAnchors(input: RepoRef, sinceSha?: string): Promise<HealResult> {
    const initialized = this.requireRepo(input);
    const headSha = gitHeadSha(input.repo_root);
    const graph = this.repository.readGraphView(initialized.repo_id);

    const candidates = this.healCandidates(initialized.repo_id, graph.claims, input.repo_root, sinceSha);
    if (candidates.length === 0) {
      this.saveCheckpoint(initialized.repo_id, headSha);
      return { demoted: [], rechecked: 0, headSha };
    }

    const { demotions, rechecked } = await this.classifyCandidates(candidates, input.repo_root);
    if (demotions.length === 0) {
      this.saveCheckpoint(initialized.repo_id, headSha);
      return { demoted: [], rechecked, headSha };
    }

    const { proposal, events } = buildAnchorInvalidation(demotions, graph);
    const working = this.repository.requireWorkingScope(initialized.repo_id);
    const demoted = demotions.map((demotion) => demotion.claim.id);
    this.repository.applyAnchorInvalidation({
      repoId: initialized.repo_id,
      scopeId: working.id,
      proposal,
      events,
      commit: { title: proposal.title, git_commit_sha: headSha },
    });

    // Embed the rebuilt claims so they stay retrievable via graph context.
    await this.contextBuilder.ensureForGraph(
      initialized.repo_id,
      this.repository.readGraphView(initialized.repo_id),
      this.contextConfig,
    );
    this.saveCheckpoint(initialized.repo_id, headSha);
    return { demoted, rechecked, headSha };
  }

  /** Heal using this repo's stored checkpoint as `sinceSha` (undefined -> full sweep). */
  async healDriftedAnchorsFromCheckpoint(input: RepoRef): Promise<HealResult> {
    const initialized = this.requireRepo(input);
    return this.healDriftedAnchors(input, this.repository.getFreshnessCheckpoint(initialized.repo_id));
  }

  /** The re-verify worklist for this repo: drift-demoted claims still `truth: unknown`. */
  reverifyWorklist(input: RepoRef, limit: number): Claim[] {
    return this.repository.claimsNeedingReverify(this.requireRepo(input).repo_id, limit);
  }

  /** The code_verified claims to re-check: the full set on a sweep, else only those in changed files. */
  private healCandidates(repoId: string, claims: Claim[], repoRoot: string | undefined, sinceSha: string | undefined): Claim[] {
    const codeVerified = claims.filter((claim) => claim.truth === "code_verified" && (claim.code_anchors?.length ?? 0) > 0);
    if (sinceSha === undefined) return codeVerified; // first run / no checkpoint -> full sweep
    const changed = changedFilesSince(repoRoot, sinceSha);
    if (changed === undefined) return codeVerified; // git probe failed -> full sweep, don't silently skip
    if (changed.length === 0) return [];
    const affected = new Set(this.repository.claimIdsForFiles(repoId, changed)); // reverse index (repo-scoped)
    return codeVerified.filter((claim) => affected.has(claim.id));
  }

  /** Re-resolve + classify each candidate; collect the ones that genuinely drifted. */
  private async classifyCandidates(
    candidates: Claim[],
    repoRoot: string | undefined,
  ): Promise<{ demotions: ClaimDemotion[]; rechecked: number }> {
    const resolver = new CodeAnchorResolver();
    const storedByClaim = indexFingerprintsByClaim(this.repository.fingerprintsForClaims(candidates.map((claim) => claim.id)));
    const demotions: ClaimDemotion[] = [];
    let rechecked = 0;
    for (const claim of candidates) {
      try {
        const resolved = await resolver.resolveMany(repoRoot, claim.code_anchors ?? []);
        rechecked += 1;
        const checks = freshnessChecks(resolved, storedByClaim.get(claim.id), repoRoot);
        const demotion = toDemotion(claim, classifyFreshness(checks), checks);
        if (demotion !== undefined) demotions.push(demotion);
      } catch {
        // A resolver failure on one claim is skipped, never fatal to the pass.
      }
    }
    return { demotions, rechecked };
  }

  private saveCheckpoint(repoId: string, headSha: string | undefined): void {
    if (headSha !== undefined) this.repository.setFreshnessCheckpoint(repoId, headSha);
  }

}

/** Map a freshness verdict to a demotion, or undefined when the claim must be left alone. */
function toDemotion(claim: Claim, verdict: FreshnessVerdict, checks: AnchorCheck[]): ClaimDemotion | undefined {
  if (verdict.state !== "stale") return undefined; // fresh or unknown -> never demote
  if (verdict.reason === "content") {
    // Only the anchors whose hash actually drifted, so the audit event names them accurately.
    return { claim, reason: "content", anchors: checks.filter(hasContentDrift).map((check) => check.anchor) };
  }
  return { claim, reason: "structural", anchors: verdict.broken };
}

function anchorAuditErrors(result: ClaimAnchorAuditResult): string[] {
  return [
    ...result.missing_anchors.map((issue) => `${issue.claim_id} is code_verified but has no code anchors`),
    ...result.missing_files.map((issue) => `${issue.claim_id} -> ${formatAnchor(issue.anchor)} file does not exist`),
    ...result.missing_symbols.map((issue) => `${issue.claim_id} -> ${formatAnchor(issue.anchor)} symbol was not found`),
    ...result.ambiguous_symbols.map((issue) => `${issue.claim_id} -> ${formatAnchor(issue.anchor)} symbol is ambiguous`),
    ...result.unsupported_languages.map((issue) => `${issue.claim_id} -> ${formatAnchor(issue.anchor)} language is unsupported for symbol anchors`),
  ];
}

function formatAnchor(anchor: { file: string; symbol?: string } | undefined): string {
  if (anchor === undefined) return "<missing>";
  return anchor.symbol === undefined ? anchor.file : `${anchor.file}#${anchor.symbol}`;
}

export function createLocalKnowledgeGraphService(
  config: GraphContextConfig = graphContextConfig,
): KnowledgeGraphService {
  return new KnowledgeGraphService(new SqliteKnowledgeGraphRepository(openDatabase()), config);
}
