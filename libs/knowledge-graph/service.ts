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
import { buildAnchorInvalidation } from "./anchor-invalidation.js";
import type { InvalidationResolverStatus } from "./invalidation.js";
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
  resolver_status: InvalidationResolverStatus;
}

export interface AnchorInvalidationResult {
  memory_commit_id?: string;
  invalidated: AnchorInvalidationRecord[];
  errors: DriftScanError[];
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

    await this.writeFingerprints(input, normalizedProposal.creates.claims ?? []);

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
   * later reads/heals can tell whether the anchored code has since changed. Best
   * effort per anchor — an unreadable span is skipped, not fatal.
   */
  private async writeFingerprints(input: RepoRef, claims: Claim[]): Promise<void> {
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
          claim_id: claim.id,
          file: anchor.file,
          symbol: anchor.symbol ?? null,
          content_hash: contentHash,
          file_mtime_ms: stat.mtime_ms,
          file_size: stat.size,
          resolver_status: anchor.status,
        });
      }
    }
    this.repository.upsertAnchorFingerprints(rows);
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
    const { proposal, events } = buildAnchorInvalidation(drifted, graph);
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
