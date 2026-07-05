import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryCommit } from "../../knowledge-graph/commit.js";
import type { Edge } from "../../knowledge-graph/edge.js";
import type { MemoryCommitProposal } from "../../knowledge-graph/proposal.js";
import type { InvalidationEvent, InvalidationEventInput } from "../../knowledge-graph/invalidation.js";
import type { Component, Flow, GraphObjectType, Source } from "../../knowledge-graph/schema.js";
import type { Claim } from "../../knowledge-graph/claim.js";
import type { GraphScope, GraphScopeKind } from "../../knowledge-graph/scope.js";

export interface RepoRecord {
  id: string;
  remote_url: string | null;
  root_path: string | null;
  repo_name: string;
  default_branch: string;
}

export interface UpsertRepoInput {
  repo_root?: string;
  remote_url?: string;
  repo_name: string;
  default_branch: string;
}

export interface CreateScopeInput {
  repo_id: string;
  kind: GraphScopeKind;
  name: string;
  parent_scope_id?: string;
  ref?: string;
}

export interface CreateMemoryCommitInput {
  scope_id: string;
  git_commit_sha?: string;
  title: string;
  summary?: string;
}

type MembershipRow = {
  subject_type: "component" | "flow" | "claim" | "edge";
  subject_id: string;
};

type ComponentRow = Omit<Component, "code_anchor"> & { code_anchor: string | null };
type ClaimRow = Omit<Claim, "code_anchors"> & { code_anchors: string | null };
type EdgeRow = Omit<Edge, "metadata"> & { metadata: string | null };
type InvalidationEventRow = Omit<InvalidationEvent, "git_commit_sha"> & { git_commit_sha: string | null };
type RepoMatch = { repo: RepoRecord; matchedBy: "remote" | "root" };

export interface ApplyAnchorInvalidationInput {
  repoId: string;
  scopeId: string;
  proposal: MemoryCommitProposal;
  events: InvalidationEventInput[];
  commit: { title: string; summary?: string; git_commit_sha?: string };
}

export interface AnchorFingerprintRow {
  claim_id: string;
  file: string;
  symbol: string; // "" for file-only anchors (see schema: non-null keeps upserts idempotent)
  content_hash: string;
  file_mtime_ms: number;
  file_size: number;
  resolver_status: string;
  checked_at: string;
}

/** A fingerprint row without the server-stamped `checked_at`. */
export type AnchorFingerprintInput = Omit<AnchorFingerprintRow, "checked_at">;

export type EmbeddingObjectType = "claim" | "component" | "flow";

export interface GraphObjectEmbeddingRecord {
  repo_id: string;
  object_type: EmbeddingObjectType;
  object_id: string;
  provider: string;
  model: string;
  dimensions: number;
  embedding: Buffer;
  created_at: string;
}

export interface InsertGraphObjectEmbeddingInput {
  repo_id: string;
  object_type: EmbeddingObjectType;
  object_id: string;
  provider: string;
  model: string;
  dimensions: number;
  embedding: Buffer;
}

export interface ClaimProvenanceRecord {
  claim_id: string;
  created_at: string;
  memory_commit_id: string;
}

export class SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  upsertRepo(input: UpsertRepoInput): { repo: RepoRecord; created: boolean } {
    const existing = this.findRepo(input);
    if (existing) return { repo: this.updateRepo(existing.repo, input, existing.matchedBy), created: false };

    const repo: RepoRecord = {
      id: makeId("repo", identityKey(input)),
      remote_url: input.remote_url ?? null,
      root_path: input.repo_root ?? null,
      repo_name: input.repo_name,
      default_branch: input.default_branch,
    };

    this.db
      .prepare(
        `INSERT INTO repos (id, remote_url, root_path, repo_name, default_branch)
         VALUES (@id, @remote_url, @root_path, @repo_name, @default_branch)`,
      )
      .run(repo);

    return { repo, created: true };
  }

  getRepoByRemote(remoteUrl: string): RepoRecord | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE remote_url = ?").get(remoteUrl) as RepoRecord | undefined;
  }

  getRepoByRootPath(rootPath: string): RepoRecord | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE root_path = ?").get(rootPath) as RepoRecord | undefined;
  }

  getRepo(input: UpsertRepoInput): RepoRecord | undefined {
    return this.findRepo(input)?.repo;
  }

  requireRepo(input: UpsertRepoInput): RepoRecord {
    const repo = this.getRepo(input);
    if (!repo) {
      throw new Error("Greplica is not installed for this repo. Run greplica install --platform <codex|claude|copilot|opencode> --embedding local from the repo you want to use.");
    }
    return repo;
  }

  private findRepo(input: UpsertRepoInput): RepoMatch | undefined {
    if (input.remote_url !== undefined) {
      const byRemote = this.getRepoByRemote(input.remote_url);
      if (byRemote !== undefined) return { repo: byRemote, matchedBy: "remote" };
    }
    if (input.repo_root !== undefined) {
      for (const rootPath of rootPathCandidates(input.repo_root)) {
        const byRootPath = this.getRepoByRootPath(rootPath);
        if (byRootPath !== undefined) return { repo: byRootPath, matchedBy: "root" };
      }
    }
    return undefined;
  }

  private updateRepo(existing: RepoRecord, input: UpsertRepoInput, matchedBy: RepoMatch["matchedBy"]): RepoRecord {
    const shouldUpdateRootPath =
      matchedBy === "root" || existing.root_path === null || existing.root_path === input.repo_root;
    const repo: RepoRecord = {
      id: existing.id,
      remote_url: input.remote_url ?? existing.remote_url,
      root_path: shouldUpdateRootPath ? (input.repo_root ?? existing.root_path) : existing.root_path,
      repo_name: input.repo_name,
      default_branch: input.default_branch,
    };

    this.db
      .prepare(
        `UPDATE repos
         SET remote_url = @remote_url,
             root_path = @root_path,
             repo_name = @repo_name,
             default_branch = @default_branch
         WHERE id = @id`,
      )
      .run(repo);

    return repo;
  }

  ensureScope(input: CreateScopeInput): GraphScope {
    const existing = this.db
      .prepare("SELECT * FROM graph_scopes WHERE repo_id = ? AND kind = ? AND name = ?")
      .get(input.repo_id, input.kind, input.name) as GraphScope | undefined;

    if (existing) return existing;

    const scope: GraphScope = {
      id: makeId("scope", `${input.repo_id}:${input.kind}:${input.name}`),
      kind: input.kind,
      name: input.name,
      parent_scope_id: input.parent_scope_id,
      ref: input.ref,
      created_at: now(),
    };

    this.db
      .prepare(
        `INSERT INTO graph_scopes (id, repo_id, kind, name, parent_scope_id, ref, created_at)
         VALUES (@id, @repo_id, @kind, @name, @parent_scope_id, @ref, @created_at)`,
      )
      .run({ ...scope, repo_id: input.repo_id });

    return scope;
  }

  requireWorkingScope(repoId: string): GraphScope {
    const scope = this.db
      .prepare("SELECT * FROM graph_scopes WHERE repo_id = ? AND kind = 'working' AND name = 'working'")
      .get(repoId) as GraphScope | undefined;
    if (!scope) throw new Error("Working scope is missing. Run 'greplica install --platform <codex|claude|copilot|opencode> --embedding local' from this repo.");
    return scope;
  }

  requireMainScope(repoId: string): GraphScope {
    const scope = this.db
      .prepare("SELECT * FROM graph_scopes WHERE repo_id = ? AND kind = 'main' ORDER BY created_at LIMIT 1")
      .get(repoId) as GraphScope | undefined;
    if (!scope) throw new Error("Main scope is missing. Run 'greplica install --platform <codex|claude|copilot|opencode> --embedding local' from this repo.");
    return scope;
  }

  readSupersededClaims(repoId: string): Claim[] {
    const scopeIds = this.currentScopeIds(repoId);
    const memberships = this.membershipsForScopes(scopeIds);
    const rawEdges = this.loadEdges(selectIds(memberships, "edge"));
    const supersededIds = new Set(
      rawEdges
        .filter((edge) => edge.kind === "supersedes" && edge.to_type === "claim")
        .map((edge) => edge.to_id),
    );
    const claimIds = selectIds(memberships, "claim").filter((id) => supersededIds.has(id));
    return this.loadClaims(claimIds);
  }

  readClaimProvenance(repoId: string): ClaimProvenanceRecord[] {
    return this.db
      .prepare(
        `SELECT gm.subject_id AS claim_id, mc.created_at AS created_at, gm.memory_commit_id AS memory_commit_id
         FROM graph_memberships gm
         JOIN memory_commits mc ON mc.id = gm.memory_commit_id
         JOIN graph_scopes gs ON gs.id = gm.scope_id
         WHERE gm.subject_type = 'claim'
           AND gs.repo_id = ?
           AND gs.kind IN ('main', 'working')`,
      )
      .all(repoId) as ClaimProvenanceRecord[];
  }

  readGraphView(repoId: string): {
    components: Component[];
    flows: Flow[];
    claims: Claim[];
    sources: Source[];
    edges: Edge[];
  } {
    const scopeIds = this.currentScopeIds(repoId);
    const memberships = this.membershipsForScopes(scopeIds);
    const rawEdges = this.loadEdges(selectIds(memberships, "edge"));
    const active = activeSubjectKeys(memberships, rawEdges);

    const edges = rawEdges.filter(
      (edge) =>
        active.has(subjectKey("edge", edge.id)) &&
        active.has(subjectKey(edge.from_type, edge.from_id)) &&
        (edge.to_type === "source" || active.has(subjectKey(edge.to_type, edge.to_id))),
    );

    return {
      components: this.loadComponents(selectActiveIds(memberships, active, "component")),
      flows: this.loadFlows(selectActiveIds(memberships, active, "flow")),
      claims: this.loadClaims(selectActiveIds(memberships, active, "claim")),
      sources: this.loadSources([...new Set(edges.filter((edge) => edge.to_type === "source").map((edge) => edge.to_id))]),
      edges,
    };
  }

  createMemoryCommit(input: CreateMemoryCommitInput): MemoryCommit {
    const parent = this.db
      .prepare("SELECT id FROM memory_commits WHERE scope_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(input.scope_id) as { id: string } | undefined;

    const memoryCommit: MemoryCommit = {
      id: `mc_${randomUUID()}`,
      scope_id: input.scope_id,
      parent_memory_commit_id: parent?.id,
      git_commit_sha: input.git_commit_sha,
      title: input.title,
      summary: input.summary,
      created_at: now(),
    };

    this.db
      .prepare(
        `INSERT INTO memory_commits
          (id, scope_id, parent_memory_commit_id, git_commit_sha, title, summary, created_at)
         VALUES
          (@id, @scope_id, @parent_memory_commit_id, @git_commit_sha, @title, @summary, @created_at)`,
      )
      .run(memoryCommit);

    return memoryCommit;
  }

  createProposalRecords(scopeId: string, memoryCommitId: string, proposal: MemoryCommitProposal): void {
    const write = this.db.transaction(() => {
      this.insertProposalRecords(scopeId, memoryCommitId, proposal);
    });
    write();
  }

  /**
   * Demotes drifted claims by writing their rebuilt (superseding) claims and
   * edges alongside the invalidation events, all under one memory commit and one
   * transaction. Integrity relies on the claim primary key plus the transaction:
   * a duplicate rebuilt-claim id or any constraint breach rolls back the whole
   * batch, so nothing partial is ever committed.
   */
  applyAnchorInvalidation(input: ApplyAnchorInvalidationInput): { memory_commit_id: string } {
    const insertEvent = this.db.prepare(
      `INSERT INTO invalidation_events
        (id, repo_id, original_claim_id, superseding_claim_id, memory_commit_id, reason, broken_anchor, resolver_status, git_commit_sha, created_at)
       VALUES
        (@id, @repo_id, @original_claim_id, @superseding_claim_id, @memory_commit_id, @reason, @broken_anchor, @resolver_status, @git_commit_sha, @created_at)`,
    );

    const write = this.db.transaction((): string => {
      const commit = this.createMemoryCommit({
        scope_id: input.scopeId,
        title: input.commit.title,
        summary: input.commit.summary,
        git_commit_sha: input.commit.git_commit_sha,
      });
      this.insertProposalRecords(input.scopeId, commit.id, input.proposal);

      const createdAt = now();
      for (const event of input.events) {
        insertEvent.run({
          id: `ev_${randomUUID()}`,
          repo_id: input.repoId,
          original_claim_id: event.original_claim_id,
          superseding_claim_id: event.superseding_claim_id,
          memory_commit_id: commit.id,
          reason: event.reason,
          broken_anchor: event.broken_anchor,
          resolver_status: event.resolver_status,
          git_commit_sha: input.commit.git_commit_sha ?? null,
          created_at: createdAt,
        });
      }

      return commit.id;
    });

    return { memory_commit_id: write() };
  }

  listInvalidationEvents(repoId: string): InvalidationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, repo_id, original_claim_id, superseding_claim_id, memory_commit_id,
                reason, broken_anchor, resolver_status, git_commit_sha, created_at
         FROM invalidation_events
         WHERE repo_id = ?
         ORDER BY created_at DESC`,
      )
      .all(repoId) as InvalidationEventRow[];
    return rows.map((row) => ({ ...row, git_commit_sha: row.git_commit_sha ?? undefined }));
  }

  /** Cache-aside write: upsert (INSERT OR REPLACE) the freshness fingerprints, one transaction. */
  upsertAnchorFingerprints(rows: AnchorFingerprintInput[]): void {
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO anchor_fingerprints
        (claim_id, file, symbol, content_hash, file_mtime_ms, file_size, resolver_status, checked_at)
       VALUES
        (@claim_id, @file, @symbol, @content_hash, @file_mtime_ms, @file_size, @resolver_status, @checked_at)`,
    );
    const write = this.db.transaction((records: AnchorFingerprintInput[]) => {
      const checkedAt = now();
      for (const record of records) insert.run({ ...record, checked_at: checkedAt });
    });
    write(rows);
  }

  /** Batch read (no N+1) of the fingerprints for the given claims. */
  fingerprintsForClaims(claimIds: string[]): AnchorFingerprintRow[] {
    if (claimIds.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM anchor_fingerprints WHERE claim_id IN (${placeholders(claimIds)})`)
      .all(...claimIds) as AnchorFingerprintRow[];
  }

  /** Reverse index: the distinct claims anchored in any of the given files. */
  claimIdsForFiles(files: string[]): string[] {
    if (files.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT DISTINCT claim_id FROM anchor_fingerprints WHERE file IN (${placeholders(files)})`)
      .all(...files) as { claim_id: string }[];
    return rows.map((row) => row.claim_id);
  }

  private insertProposalRecords(scopeId: string, memoryCommitId: string, proposal: MemoryCommitProposal): void {
    for (const component of proposal.creates.components ?? []) {
      this.db
        .prepare("INSERT INTO components (id, name, code_anchor) VALUES (@id, @name, @code_anchor)")
        .run({ ...component, code_anchor: component.code_anchor ?? null });
      this.createMembership(scopeId, "component", component.id, memoryCommitId);
    }

    for (const flow of proposal.creates.flows ?? []) {
      this.db.prepare("INSERT INTO flows (id, name) VALUES (@id, @name)").run(flow);
      this.createMembership(scopeId, "flow", flow.id, memoryCommitId);
    }

    for (const claim of proposal.creates.claims ?? []) {
      this.db
        .prepare(
          `INSERT INTO claims (id, kind, text, truth, intent, code_anchors)
           VALUES (@id, @kind, @text, @truth, @intent, @code_anchors)`,
        )
        .run({
          ...claim,
          code_anchors: claim.code_anchors === undefined ? null : JSON.stringify(claim.code_anchors),
        });
      this.createMembership(scopeId, "claim", claim.id, memoryCommitId);
    }

    for (const source of proposal.creates.sources ?? []) {
      this.db
        .prepare("INSERT INTO sources (id, kind, ref, title) VALUES (@id, @kind, @ref, @title)")
        .run({ ...source, title: source.title ?? null });
    }

    for (const edge of proposal.creates.edges ?? []) {
      this.db
        .prepare(
          `INSERT INTO edges (id, from_id, from_type, to_id, to_type, kind, metadata)
           VALUES (@id, @from_id, @from_type, @to_id, @to_type, @kind, @metadata)`,
        )
        .run({ ...edge, metadata: edge.metadata === undefined ? null : JSON.stringify(edge.metadata) });
      this.createMembership(scopeId, "edge", edge.id, memoryCommitId);
    }
  }

  subjectExists(type: GraphObjectType, id: string): boolean {
    const table = tableForType(type);
    const row = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    return row !== undefined;
  }

  subjectType(id: string): GraphObjectType | undefined {
    for (const type of ["component", "flow", "claim", "edge", "source"] as const) {
      if (this.subjectExists(type, id)) return type;
    }
    return undefined;
  }

  listGraphObjectEmbeddings(input: {
    repo_id: string;
    provider: string;
    model: string;
    dimensions: number;
  }): GraphObjectEmbeddingRecord[] {
    return this.db
      .prepare(
        `SELECT repo_id, object_type, object_id, provider, model, dimensions, embedding, created_at
         FROM graph_object_embeddings
         WHERE repo_id = @repo_id
           AND provider = @provider
           AND model = @model
           AND dimensions = @dimensions`,
      )
      .all(input) as GraphObjectEmbeddingRecord[];
  }

  insertGraphObjectEmbeddings(inputs: InsertGraphObjectEmbeddingInput[]): void {
    if (inputs.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO graph_object_embeddings
        (repo_id, object_type, object_id, provider, model, dimensions, embedding, created_at)
       VALUES
        (@repo_id, @object_type, @object_id, @provider, @model, @dimensions, @embedding, @created_at)`,
    );
    const write = this.db.transaction((records: InsertGraphObjectEmbeddingInput[]) => {
      for (const record of records) insert.run({ ...record, created_at: now() });
    });
    write(inputs);
  }

  private createMembership(
    scopeId: string,
    subjectType: "component" | "flow" | "claim" | "edge",
    subjectId: string,
    memoryCommitId: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO graph_memberships (scope_id, subject_type, subject_id, memory_commit_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(scopeId, subjectType, subjectId, memoryCommitId);
  }

  private currentScopeIds(repoId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM graph_scopes WHERE repo_id = ? AND kind IN ('main', 'working') ORDER BY kind")
      .all(repoId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  private membershipsForScopes(scopeIds: string[]): MembershipRow[] {
    if (scopeIds.length === 0) return [];
    return this.db
      .prepare(`SELECT subject_type, subject_id FROM graph_memberships WHERE scope_id IN (${placeholders(scopeIds)})`)
      .all(...scopeIds) as MembershipRow[];
  }

  private loadComponents(ids: string[]): Component[] {
    return this.loadByIds<ComponentRow>("components", ids).map((row) => ({
      id: row.id,
      name: row.name,
      code_anchor: row.code_anchor ?? undefined,
    }));
  }

  private loadFlows(ids: string[]): Flow[] {
    return this.loadByIds<Flow>("flows", ids);
  }

  private loadClaims(ids: string[]): Claim[] {
    return this.loadByIds<ClaimRow>("claims", ids).map((row) => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      truth: row.truth,
      intent: row.intent,
      code_anchors: row.code_anchors === null ? undefined : JSON.parse(row.code_anchors) as Claim["code_anchors"],
    }));
  }

  private loadSources(ids: string[]): Source[] {
    return this.loadByIds<Source>("sources", ids);
  }

  private loadEdges(ids: string[]): Edge[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE id IN (${placeholders(ids)})`)
      .all(...ids) as EdgeRow[];
    return rows.map((row) => ({
      ...row,
      metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata) as Record<string, unknown>),
    }));
  }

  private loadByIds<T>(table: string, ids: string[]): T[] {
    if (ids.length === 0) return [];
    return this.db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders(ids)})`).all(...ids) as T[];
  }
}

function activeSubjectKeys(memberships: MembershipRow[], edges: Edge[]): Set<string> {
  const active = new Set(memberships.map((membership) => subjectKey(membership.subject_type, membership.subject_id)));
  const superseded = new Set(
    edges
      .filter((edge) => edge.kind === "supersedes")
      .map((edge) => subjectKey(edge.to_type, edge.to_id)),
  );

  for (const key of superseded) {
    active.delete(key);
  }

  return active;
}

function selectIds(memberships: MembershipRow[], type: MembershipRow["subject_type"]): string[] {
  return [...new Set(memberships.filter((membership) => membership.subject_type === type).map((membership) => membership.subject_id))];
}

function selectActiveIds(memberships: MembershipRow[], active: Set<string>, type: MembershipRow["subject_type"]): string[] {
  return selectIds(memberships, type).filter((id) => active.has(subjectKey(type, id)));
}

function subjectKey(type: GraphObjectType, id: string): string {
  return `${type}:${id}`;
}

function tableForType(type: GraphObjectType): string {
  switch (type) {
    case "component":
      return "components";
    case "flow":
      return "flows";
    case "claim":
      return "claims";
    case "edge":
      return "edges";
    case "source":
      return "sources";
  }
}

function makeId(prefix: string, value: string): string {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

function identityKey(input: UpsertRepoInput): string {
  if (input.remote_url !== undefined) return input.remote_url;
  if (input.repo_root !== undefined) return `root:${input.repo_root}`;
  throw new Error("Repo memory needs either a remote URL or a root path.");
}

function rootPathCandidates(rootPath: string): string[] {
  const candidates = [rootPath];
  if (rootPath.startsWith("/private/var/")) candidates.push(rootPath.slice("/private".length));
  if (rootPath.startsWith("/var/")) candidates.push(`/private${rootPath}`);
  return candidates;
}

function now(): string {
  return new Date().toISOString();
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}
