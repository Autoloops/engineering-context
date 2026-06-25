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
import { defaultDatabasePath, openDatabase } from "../storage/sqlite/db.js";
import type { SqliteRepository } from "../storage/sqlite/repository.js";
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

  validateProposal(input: RepoRef, proposal: unknown): ProposalValidationResult {
    this.requireRepo(input);
    return validateProposal(normalizeProposal(proposal, this.repository), this.repository);
  }

  async applyProposal(input: RepoRef, proposal: unknown): Promise<ApplyProposalResult> {
    const normalizedProposal = normalizeProposal(proposal, this.repository);
    const validation = this.validateProposal(input, normalizedProposal);
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

}

export function createLocalKnowledgeGraphService(
  config: GraphContextConfig = graphContextConfig,
): KnowledgeGraphService {
  return new KnowledgeGraphService(new SqliteKnowledgeGraphRepository(openDatabase()), config);
}
