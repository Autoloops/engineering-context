import { createHash } from "node:crypto";
import { normalizeProposal, type MemoryCommitProposal } from "./proposal.js";
import { validateProposal, type ProposalValidationResult } from "./validate-proposal.js";
import type { Claim } from "./claim.js";
import type { Edge } from "./edge.js";
import type { Component, Flow, GraphObjectType, Source } from "./schema.js";
import { GraphContextBuilder } from "./graph-context/context-builder.js";
import { graphContextConfig, type GraphContextConfig } from "./graph-context/config.js";
import type { EmbeddingStatus, GraphContextResult } from "./graph-context/types.js";
import { buildGraphViewHtml } from "./graph-view/build-graph-view.js";
import { auditClaimCodeAnchors } from "./code-anchors/audit.js";
import { CodeAnchorResolver } from "./code-anchors/resolver.js";
import { fingerprintClaimAnchors } from "./code-anchors/fingerprint.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import type { ClaimAnchorAuditIssue } from "./code-anchors/types.js";
import { defaultDatabasePath, openDatabase } from "../storage/sqlite/db.js";
import type { SqliteRepository } from "../storage/sqlite/repository.js";
import { SqliteRepository as SqliteKnowledgeGraphRepository } from "../storage/sqlite/repository.js";
import { bufferToFloat32Array } from "./graph-context/vector.js";
import { createEmbedder } from "./graph-context/embedder.js";
import { buildClaimDocuments } from "./graph-context/documents.js";
import { findSimilarClaims, type SimilarClaimMatch } from "./dedupe/find-similar-claims.js";

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

export interface ProposalReviewResult extends ProposalValidationResult {
  duplicate_warnings: Record<string, SimilarClaimMatch[]>;
}

export interface StaleAnchorReviewResult {
  audited_claims: number;
  marked_claims: number;
  memory_commit_id?: string;
}

export class KnowledgeGraphService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly contextConfig: GraphContextConfig = graphContextConfig,
    private readonly contextBuilder = new GraphContextBuilder(repository),
  ) {}

  close(): void {
    this.repository.close();
  }

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
    const claims = this.repository.readGraphView(initialized.repo_id).claims;
    const baselineFingerprints = this.repository.readClaimAnchorFingerprints(
      initialized.repo_id,
      claims.map((claim) => claim.id),
    );
    return auditClaimCodeAnchors(input.repo_root, claims, new CodeAnchorResolver(), baselineFingerprints);
  }

  async markStaleAnchors(
    input: RepoRef,
    options: { changedFiles?: ReadonlySet<string>; head?: string } = {},
  ): Promise<StaleAnchorReviewResult> {
    const initialized = this.requireRepo(input);
    const graph = this.repository.readGraphView(initialized.repo_id);
    const result = await this.auditCodeAnchors(input);
    const issues = staleAnchorIssues(result)
      .filter((issue) => options.changedFiles === undefined || issue.anchor === undefined || options.changedFiles.has(issue.anchor.file));
    const byClaim = new Map<string, ClaimAnchorAuditIssue>();
    for (const issue of issues) if (!byClaim.has(issue.claim_id)) byClaim.set(issue.claim_id, issue);
    const existingReviewClaims = new Set(
      graph.edges
        .filter((edge) => edge.kind === "needs_review" && edge.from_type === "claim")
        .map((edge) => edge.from_id),
    );
    const edges = [...byClaim.values()]
      .filter((issue) => !existingReviewClaims.has(issue.claim_id))
      .map((issue) => needsReviewEdge(issue, options.head));
    if (edges.length === 0) return { audited_claims: graph.claims.length, marked_claims: 0 };

    const applied = await this.applyProposal(input, {
      title: `Mark ${edges.length} stale anchor${edges.length === 1 ? "" : "s"} for review`,
      summary: "Automatically generated by git-aware anchor validation.",
      creates: { edges },
    });
    return {
      audited_claims: graph.claims.length,
      marked_claims: edges.length,
      memory_commit_id: applied.memory_commit_id,
    };
  }

  async validateProposal(input: RepoRef, proposal: unknown): Promise<ProposalReviewResult> {
    const initialized = this.requireRepo(input);
    const normalizedProposal = normalizeProposal(proposal, this.subjectLookup(initialized.repo_id));
    const validation = await this.validateNormalizedProposal(input, initialized.repo_id, normalizedProposal);
    if (!validation.valid) return { ...validation, duplicate_warnings: {} };

    return {
      ...validation,
      duplicate_warnings: await this.checkForDuplicateClaims(initialized.repo_id, normalizedProposal),
    };
  }

  async applyProposal(input: RepoRef, proposal: unknown): Promise<ApplyProposalResult> {
    const initialized = this.requireRepo(input);
    const normalizedProposal = normalizeProposal(proposal, this.subjectLookup(initialized.repo_id));
    const validation = await this.validateNormalizedProposal(input, initialized.repo_id, normalizedProposal);
    if (!validation.valid) {
      throw new Error(`Proposal is invalid:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }

    const working = this.repository.requireWorkingScope(initialized.repo_id);
    const memoryCommit = this.repository.createMemoryCommit({
      scope_id: working.id,
      title: normalizedProposal.title,
      summary: normalizedProposal.summary,
    });

    const anchorFingerprints = await computeAnchorFingerprints(input.repo_root, normalizedProposal.creates.claims ?? []);
    this.repository.createProposalRecords(working.id, memoryCommit.id, normalizedProposal, anchorFingerprints);
    const embeddingStatus = await this.contextBuilder.ensureForGraph(
      initialized.repo_id,
      this.repository.readGraphView(initialized.repo_id),
      this.contextConfig,
    );

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

  private async validateNormalizedProposal(
    input: RepoRef,
    repoId: string,
    proposal: MemoryCommitProposal,
  ): Promise<ProposalValidationResult> {
    const validation = validateProposal(proposal, this.subjectLookup(repoId));
    if (!validation.valid) return validation;

    const anchorErrors = anchorAuditErrors(
      await auditClaimCodeAnchors(input.repo_root, proposal.creates.claims ?? []),
    );
    if (anchorErrors.length === 0) return validation;

    return {
      valid: false,
      errors: anchorErrors,
    };
  }

  private async checkForDuplicateClaims(
    repoId: string,
    proposal: MemoryCommitProposal,
  ): Promise<Record<string, SimilarClaimMatch[]>> {
    const candidateClaims = proposal.creates.claims ?? [];
    if (candidateClaims.length === 0) return {};

    const activeGraph = this.repository.readGraphView(repoId);
    if (activeGraph.claims.length === 0) return {};

    const activeClaimIds = new Set(activeGraph.claims.map((claim) => claim.id));
    const storedVectors = new Map(
      this.repository
        .listGraphObjectEmbeddings({
          repo_id: repoId,
          provider: this.contextConfig.embedding.provider,
          model: this.contextConfig.embedding.model,
          dimensions: this.contextConfig.embedding.dimensions,
        })
        .filter((record) => record.object_type === "claim" && activeClaimIds.has(record.object_id))
        .map((record) => [record.object_id, bufferToFloat32Array(record.embedding)]),
    );

    const activeDocuments = buildClaimDocuments(activeGraph);
    const missingActiveDocuments = activeDocuments.filter((document) => !storedVectors.has(document.id));
    const candidateIds = new Set(candidateClaims.map((claim) => claim.id));
    const candidateDocuments = buildClaimDocuments({
      components: [...activeGraph.components, ...(proposal.creates.components ?? [])],
      flows: [...activeGraph.flows, ...(proposal.creates.flows ?? [])],
      claims: [...activeGraph.claims, ...candidateClaims],
      sources: [...activeGraph.sources, ...(proposal.creates.sources ?? [])],
      edges: [...activeGraph.edges, ...(proposal.creates.edges ?? [])],
    }).filter((document) => candidateIds.has(document.id));

    const embedder = createEmbedder(this.contextConfig.embedding);
    const generatedVectors = await embedder.embedBatch([
      ...missingActiveDocuments.map((document) => document.text),
      ...candidateDocuments.map((document) => document.text),
    ]);

    for (const [index, document] of missingActiveDocuments.entries()) {
      storedVectors.set(document.id, new Float32Array(generatedVectors[index]));
    }

    const existingVectors = activeDocuments.map((document) => ({
      claim_id: document.id,
      vector: storedVectors.get(document.id) as Float32Array,
    }));
    const handledSupersedes = new Set(
      (proposal.creates.edges ?? [])
        .filter(
          (edge) =>
            edge.kind === "supersedes" && edge.from_type === "claim" && edge.to_type === "claim",
        )
        .map((edge) => `${edge.from_id}\0${edge.to_id}`),
    );
    const warnings: Record<string, SimilarClaimMatch[]> = {};

    for (const [index, document] of candidateDocuments.entries()) {
      const vectorIndex = missingActiveDocuments.length + index;
      const matches = findSimilarClaims(
        new Float32Array(generatedVectors[vectorIndex]),
        existingVectors,
        this.contextConfig.dedupe.similarityThreshold,
      ).filter((match) => !handledSupersedes.has(`${document.id}\0${match.claim_id}`));
      if (matches.length > 0) {
        warnings[document.id] = matches;
      }
    }

    return warnings;
  }

  private subjectLookup(repoId: string): {
    subjectExists: (type: GraphObjectType, id: string) => boolean;
    subjectType: (id: string) => GraphObjectType | undefined;
    claimNeedsReview: (id: string) => boolean;
  } {
    return {
      subjectExists: (type, id) => this.repository.subjectExists(repoId, type, id),
      subjectType: (id) => this.repository.subjectType(repoId, id),
      claimNeedsReview: (id) => this.repository.claimNeedsReview(repoId, id),
    };
  }
}

function staleAnchorIssues(result: ClaimAnchorAuditResult): ClaimAnchorAuditIssue[] {
  return [...result.missing_files, ...result.missing_symbols, ...result.drifted];
}

function needsReviewEdge(issue: ClaimAnchorAuditIssue, head: string | undefined): Edge {
  const reason = issue.status === "missing_file"
    ? "file_deleted"
    : issue.status === "missing_symbol"
      ? "symbol_removed"
      : "file_content_changed";
  const hash = createHash("sha1").update(issue.claim_id).digest("hex").slice(0, 12);
  return {
    id: `edge.needs_review.${hash}`,
    from_type: "claim",
    from_id: issue.claim_id,
    to_type: "claim",
    to_id: issue.claim_id,
    kind: "needs_review",
    metadata: {
      reason,
      anchor: issue.anchor,
      head,
      detected_at: new Date().toISOString(),
    },
  };
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

// Fingerprint each claim's code anchors against the repo as it is now, so the
// stored baseline reflects the code the fact was written against. A single
// resolver is shared so per-file parses are cached across claims.
async function computeAnchorFingerprints(
  repoRoot: string | undefined,
  claims: Claim[],
): Promise<Map<string, Record<string, string>>> {
  const resolver = new CodeAnchorResolver();
  const byClaim = new Map<string, Record<string, string>>();
  for (const claim of claims) {
    if (claim.code_anchors === undefined || claim.code_anchors.length === 0) continue;
    const fingerprints = await fingerprintClaimAnchors(repoRoot, claim.code_anchors, resolver);
    if (Object.keys(fingerprints).length > 0) byClaim.set(claim.id, fingerprints);
  }
  return byClaim;
}

export function createLocalKnowledgeGraphService(
  config: GraphContextConfig = graphContextConfig,
): KnowledgeGraphService {
  return new KnowledgeGraphService(new SqliteKnowledgeGraphRepository(openDatabase()), config);
}
