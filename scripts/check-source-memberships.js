import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-source-membership-test-"));

await checkSourceOnlyProposal();
checkConnectedSourceCompatibility();
checkRepositoryIsolation();
checkNonCurrentScopeIsolation();
checkRepoScopedSourceBackfill();
checkRepoScopedConnectedSourceBackfill();
checkLegacyConnectedSourceMigration();
checkLegacySharedConnectedSourceMigration();
checkLegacyUnlinkedSourceMigration();
checkAmbiguousLegacySourceStopsMigration();

console.log("Source membership checks passed.");

async function checkSourceOnlyProposal() {
  const db = openDatabase(join(tmp, "source-only.db"));
  try {
    const repository = new SqliteRepository(db);
    const service = new KnowledgeGraphService(repository, undefined, {
      ensureForGraph: async () => ({ created: 0, reused: 0, provider: "local", model: "test", dimensions: 0 }),
    });
    const repo = {
      repo_root: join(tmp, "source-only"),
      repo_name: "source-only",
      default_branch: "main",
    };
    const initialized = service.initRepo(repo);
    const result = await service.applyProposal(repo, {
      title: "Create standalone source",
      creates: {
        sources: [{ id: "source.standalone", kind: "session", ref: "codex-session:standalone" }],
      },
    });

    assert.equal(result.created.sources, 1);
    assert.deepEqual(service.readGraph(repo).sources.map(({ id }) => id), ["source.standalone"]);
    assert.equal(sourceMembershipCount(db, initialized.repo_id, "source.standalone"), 1);
  } finally {
    db.close();
  }
}

function checkConnectedSourceCompatibility() {
  const db = openDatabase(join(tmp, "connected.db"));
  try {
    const { repository, service, repo, initialized } = initializeRepo(db, "connected");
    createRecords(repository, initialized.working_scope_id, "Create connected source", {
      claims: [
        {
          id: "claim.connected",
          kind: "fact",
          text: "This claim has session evidence.",
          truth: "source_verified",
          intent: "intended",
        },
      ],
      sources: [{ id: "source.connected", kind: "session", ref: "codex-session:connected" }],
      edges: [
        {
          id: "edge.connected-evidence",
          from_id: "claim.connected",
          from_type: "claim",
          to_id: "source.connected",
          to_type: "source",
          kind: "evidenced_by",
          metadata: { reason: "The session records the decision." },
        },
      ],
    });

    const graph = service.readGraph(repo);
    assert.deepEqual(graph.sources.map(({ id }) => id), ["source.connected"]);
    assert.deepEqual(graph.edges.map(({ id }) => id), ["edge.connected-evidence"]);
  } finally {
    db.close();
  }
}

function checkRepositoryIsolation() {
  const db = openDatabase(join(tmp, "repository-isolation.db"));
  try {
    const a = initializeRepo(db, "repo-a");
    const b = initializeRepo(db, "repo-b");
    createRecords(a.repository, a.initialized.working_scope_id, "Repo A source", {
      sources: [{ id: "source.shared", kind: "session", ref: "codex-session:repo-a" }],
    });
    createRecords(b.repository, b.initialized.working_scope_id, "Repo B source", {
      sources: [{ id: "source.shared", kind: "session", ref: "codex-session:repo-b" }],
    });

    assert.deepEqual(a.service.readGraph(a.repo).sources.map(({ ref }) => ref), ["codex-session:repo-a"]);
    assert.deepEqual(b.service.readGraph(b.repo).sources.map(({ ref }) => ref), ["codex-session:repo-b"]);
  } finally {
    db.close();
  }
}

function checkNonCurrentScopeIsolation() {
  const db = openDatabase(join(tmp, "scope-isolation.db"));
  try {
    const { repository, service, repo, initialized } = initializeRepo(db, "scope-isolation");
    const sessionScope = repository.ensureScope({
      repo_id: initialized.repo_id,
      kind: "session",
      name: "inactive-session",
      parent_scope_id: initialized.working_scope_id,
    });
    createRecords(repository, sessionScope.id, "Inactive session source", {
      sources: [{ id: "source.inactive", kind: "session", ref: "codex-session:inactive" }],
    });

    assert.deepEqual(service.readGraph(repo).sources, [], "sources outside main/working scopes must remain hidden");
  } finally {
    db.close();
  }
}

function checkRepoScopedSourceBackfill() {
  const path = join(tmp, "repo-scoped-backfill.db");
  let db = openDatabase(path);
  const { repository, service, repo, initialized } = initializeRepo(db, "repo-scoped-backfill");
  const commit = repository.createMemoryCommit({
    scope_id: initialized.working_scope_id,
    title: "Legacy source-only proposal",
  });
  db.prepare("INSERT INTO sources (repo_id, id, kind, ref, title) VALUES (?, ?, ?, ?, ?)").run(
    initialized.repo_id,
    "source.repo-scoped-orphan",
    "session",
    "codex-session:repo-scoped-orphan",
    null,
  );
  assert.equal(sourceMembershipCount(db, initialized.repo_id, "source.repo-scoped-orphan"), 0);
  db.close();

  db = openDatabase(path);
  try {
    const reopenedRepository = new SqliteRepository(db);
    const reopenedService = new KnowledgeGraphService(reopenedRepository);
    assert.deepEqual(reopenedService.readGraph(repo).sources.map(({ id }) => id), ["source.repo-scoped-orphan"]);
    assert.equal(sourceMembershipCount(db, initialized.repo_id, "source.repo-scoped-orphan"), 1);
    assert.equal(
      db.prepare("SELECT memory_commit_id FROM graph_memberships WHERE subject_type = 'source'").get().memory_commit_id,
      commit.id,
    );
  } finally {
    db.close();
  }
}

function checkRepoScopedConnectedSourceBackfill() {
  const path = join(tmp, "repo-scoped-connected-backfill.db");
  let db = openDatabase(path);
  const { repository, repo, initialized } = initializeRepo(db, "repo-scoped-connected-backfill");
  createRecords(repository, initialized.working_scope_id, "Legacy connected source", {
    claims: [
      {
        id: "claim.repo-scoped-connected",
        kind: "fact",
        text: "This current-schema source predates source memberships.",
        truth: "source_verified",
        intent: "intended",
      },
    ],
    sources: [
      {
        id: "source.repo-scoped-connected",
        kind: "session",
        ref: "codex-session:repo-scoped-connected",
      },
    ],
    edges: [
      {
        id: "edge.repo-scoped-connected",
        from_id: "claim.repo-scoped-connected",
        from_type: "claim",
        to_id: "source.repo-scoped-connected",
        to_type: "source",
        kind: "evidenced_by",
        metadata: { reason: "Connected source migration coverage." },
      },
    ],
  });
  const edgeMembership = db
    .prepare("SELECT scope_id, memory_commit_id FROM graph_memberships WHERE subject_type = 'edge'")
    .get();
  db.prepare("DELETE FROM graph_memberships WHERE subject_type = 'source'").run();
  db.close();

  db = openDatabase(path);
  try {
    const sourceMembership = db
      .prepare("SELECT scope_id, memory_commit_id FROM graph_memberships WHERE subject_type = 'source'")
      .get();
    assert.deepEqual(sourceMembership, edgeMembership, "connected source must inherit its edge's exact scope and commit");
    const reopenedService = new KnowledgeGraphService(new SqliteRepository(db));
    assert.deepEqual(reopenedService.readGraph(repo).sources.map(({ id }) => id), ["source.repo-scoped-connected"]);
  } finally {
    db.close();
  }
}

function checkLegacyConnectedSourceMigration() {
  const path = join(tmp, "legacy-connected.db");
  const db = createLegacyDatabase(path, ["repo-a"]);
  seedLegacySource(db, { connectedRepoId: "repo-a", sourceId: "source.legacy-connected" });
  db.close();

  const migrated = openDatabase(path);
  try {
    assert.deepEqual(
      migrated.prepare("SELECT repo_id, id FROM sources").all(),
      [{ repo_id: "repo-a", id: "source.legacy-connected" }],
    );
    assert.equal(sourceMembershipCount(migrated, "repo-a", "source.legacy-connected"), 1);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  } finally {
    migrated.close();
  }

  assertMigratedSourceSurvivesReopen(path, "repo-a", "source.legacy-connected");
}

function checkLegacySharedConnectedSourceMigration() {
  const path = join(tmp, "legacy-shared-connected.db");
  const db = createLegacyDatabase(path, ["repo-a", "repo-b"]);
  seedLegacySource(db, { connectedRepoId: "repo-a", sourceId: "source.shared-connected" });
  connectLegacySource(db, "repo-b", "source.shared-connected");
  db.close();

  const migrated = openDatabase(path);
  try {
    assert.deepEqual(migrated.prepare("SELECT repo_id, id FROM sources ORDER BY repo_id").all(), [
      { repo_id: "repo-a", id: "source.shared-connected" },
      { repo_id: "repo-b", id: "source.shared-connected" },
    ]);
    assert.equal(sourceMembershipCount(migrated, "repo-a", "source.shared-connected"), 1);
    assert.equal(sourceMembershipCount(migrated, "repo-b", "source.shared-connected"), 1);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  } finally {
    migrated.close();
  }
}

function checkLegacyUnlinkedSourceMigration() {
  const path = join(tmp, "legacy-unlinked.db");
  const db = createLegacyDatabase(path, ["repo-a"]);
  seedLegacySource(db, { sourceId: "source.legacy-unlinked" });
  db.close();

  const migrated = openDatabase(path);
  try {
    assert.deepEqual(
      migrated.prepare("SELECT repo_id, id FROM sources").all(),
      [{ repo_id: "repo-a", id: "source.legacy-unlinked" }],
    );
    assert.equal(sourceMembershipCount(migrated, "repo-a", "source.legacy-unlinked"), 1);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  } finally {
    migrated.close();
  }


  assertMigratedSourceSurvivesReopen(path, "repo-a", "source.legacy-unlinked");
}

function checkAmbiguousLegacySourceStopsMigration() {
  const path = join(tmp, "legacy-ambiguous.db");
  const db = createLegacyDatabase(path, ["repo-a", "repo-b"]);
  seedLegacySource(db, { sourceId: "source.ambiguous" });
  db.close();

  assert.throws(
    () => openDatabase(path),
    (error) =>
      error instanceof Error &&
      /cannot safely migrate unlinked legacy source/i.test(error.message) &&
      error.message.includes("source.ambiguous"),
  );

  const untouched = new Database(path);
  try {
    assert.equal(untouched.prepare("SELECT COUNT(*) AS count FROM sources").get().count, 1);
    assert.deepEqual(untouched.prepare("PRAGMA table_info(sources)").all().map(({ name }) => name), [
      "id",
      "kind",
      "ref",
      "title",
    ]);
  } finally {
    untouched.close();
  }
}

function initializeRepo(db, name) {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = {
    repo_root: join(tmp, name),
    repo_name: name,
    default_branch: "main",
  };
  return { repository, service, repo, initialized: service.initRepo(repo) };
}

function createRecords(repository, scopeId, title, creates) {
  const commit = repository.createMemoryCommit({ scope_id: scopeId, title });
  repository.createProposalRecords(scopeId, commit.id, { title, creates });
}

function sourceMembershipCount(db, repoId, sourceId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM graph_memberships gm
       JOIN graph_scopes gs ON gs.id = gm.scope_id
       WHERE gs.repo_id = ? AND gm.subject_type = 'source' AND gm.subject_id = ?`,
    )
    .get(repoId, sourceId).count;
}

function assertMigratedSourceSurvivesReopen(path, repoId, sourceId) {
  const reopened = openDatabase(path);
  try {
    assert.equal(sourceMembershipCount(reopened, repoId, sourceId), 1, "source backfill must be idempotent");
    assert.equal(
      reopened.prepare("SELECT COUNT(*) AS count FROM sources WHERE repo_id = ? AND id = ?").get(repoId, sourceId).count,
      1,
    );
  } finally {
    reopened.close();
  }
}

function createLegacyDatabase(path, repoIds) {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      remote_url TEXT UNIQUE,
      root_path TEXT UNIQUE,
      repo_name TEXT NOT NULL,
      default_branch TEXT NOT NULL
    );
    CREATE TABLE graph_scopes (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_scope_id TEXT REFERENCES graph_scopes(id) ON DELETE SET NULL,
      ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, kind, name)
    );
    CREATE TABLE memory_commits (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES graph_scopes(id) ON DELETE CASCADE,
      parent_memory_commit_id TEXT REFERENCES memory_commits(id) ON DELETE SET NULL,
      git_commit_sha TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE components (id TEXT PRIMARY KEY, name TEXT NOT NULL, code_anchor TEXT);
    CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      truth TEXT NOT NULL,
      intent TEXT NOT NULL,
      code_anchors TEXT
    );
    CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT);
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      from_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT
    );
    CREATE TABLE graph_memberships (
      scope_id TEXT NOT NULL REFERENCES graph_scopes(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      memory_commit_id TEXT NOT NULL REFERENCES memory_commits(id) ON DELETE CASCADE,
      PRIMARY KEY(scope_id, subject_type, subject_id)
    );
  `);

  for (const repoId of repoIds) {
    const scopeId = `scope-${repoId}-working`;
    const commitId = `commit-${repoId}`;
    db.prepare("INSERT INTO repos VALUES (?, ?, ?, ?, ?)").run(
      repoId,
      `https://example.com/${repoId}.git`,
      `/tmp/${repoId}`,
      repoId,
      "main",
    );
    db.prepare("INSERT INTO graph_scopes VALUES (?, ?, 'working', 'working', NULL, NULL, ?)").run(
      scopeId,
      repoId,
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO memory_commits VALUES (?, ?, NULL, NULL, ?, NULL, ?)").run(
      commitId,
      scopeId,
      `Seed ${repoId}`,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

function seedLegacySource(db, { connectedRepoId, sourceId }) {
  db.prepare("INSERT INTO sources VALUES (?, 'session', ?, NULL)").run(sourceId, `codex-session:${sourceId}`);
  if (connectedRepoId === undefined) return;

  connectLegacySource(db, connectedRepoId, sourceId);
}

function connectLegacySource(db, connectedRepoId, sourceId) {
  const claimId = `claim-${connectedRepoId}`;
  const edgeId = `edge-${connectedRepoId}`;
  const scopeId = `scope-${connectedRepoId}-working`;
  const commitId = `commit-${connectedRepoId}`;
  db.prepare("INSERT INTO claims VALUES (?, 'fact', 'Legacy claim', 'source_verified', 'intended', NULL)").run(claimId);
  db.prepare("INSERT INTO edges VALUES (?, ?, 'claim', ?, 'source', 'evidenced_by', ?)").run(
    edgeId,
    claimId,
    sourceId,
    JSON.stringify({ reason: "Legacy evidence" }),
  );
  db.prepare("INSERT INTO graph_memberships VALUES (?, 'claim', ?, ?)").run(scopeId, claimId, commitId);
  db.prepare("INSERT INTO graph_memberships VALUES (?, 'edge', ?, ?)").run(scopeId, edgeId, commitId);
}
