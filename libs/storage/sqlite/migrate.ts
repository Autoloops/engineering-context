import type Database from "better-sqlite3";
import { schemaSql } from "./schema.js";

export function migrate(db: Database.Database): void {
  db.exec(schemaSql);
  migrateReposTable(db);
  migrateClaimsTable(db);
  migrateGraphObjectTables(db);
  migrateSourceMemberships(db);
  migrateClaimAnchorFingerprints(db);
}

function migrateReposTable(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(repos)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const remoteUrl = columns.find((column) => column.name === "remote_url");
  const hasRootPath = columns.some((column) => column.name === "root_path");
  if (hasRootPath && remoteUrl?.notnull === 0) return;

  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  const legacyAlterTable = db.pragma("legacy_alter_table", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      BEGIN;
      ALTER TABLE repos RENAME TO repos_old;
      CREATE TABLE repos (
        id TEXT PRIMARY KEY,
        remote_url TEXT UNIQUE,
        root_path TEXT UNIQUE,
        repo_name TEXT NOT NULL,
        default_branch TEXT NOT NULL
      );
      INSERT INTO repos (id, remote_url, root_path, repo_name, default_branch)
      SELECT
        id,
        CASE
          WHEN remote_url LIKE 'folder:%' THEN NULL
          WHEN remote_url LIKE 'local:%' THEN NULL
          ELSE remote_url
        END,
        CASE
          WHEN remote_url LIKE 'folder:%' THEN substr(remote_url, 8)
          WHEN remote_url LIKE 'local:%' THEN substr(remote_url, 7)
          ELSE NULL
        END,
        repo_name,
        default_branch
      FROM repos_old;
      DROP TABLE repos_old;
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlterTable ? "ON" : "OFF"}`);
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function migrateClaimsTable(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(claims)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "code_anchors")) return;
  try {
    db.exec("ALTER TABLE claims ADD COLUMN code_anchors TEXT");
  } catch (error: unknown) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

function migrateGraphObjectTables(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(components)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "repo_id")) return;

  assertLegacySourcesCanBeScoped(db);

  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  const legacyAlterTable = db.pragma("legacy_alter_table", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      BEGIN;

      ALTER TABLE components RENAME TO components_old;
      ALTER TABLE flows RENAME TO flows_old;
      ALTER TABLE claims RENAME TO claims_old;
      ALTER TABLE sources RENAME TO sources_old;
      ALTER TABLE edges RENAME TO edges_old;

      CREATE TABLE components (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        code_anchor TEXT,
        PRIMARY KEY(repo_id, id)
      );

      CREATE TABLE flows (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY(repo_id, id)
      );

      CREATE TABLE claims (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        truth TEXT NOT NULL,
        intent TEXT NOT NULL,
        code_anchors TEXT,
        PRIMARY KEY(repo_id, id)
      );

      CREATE TABLE sources (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        title TEXT,
        PRIMARY KEY(repo_id, id)
      );

      CREATE TABLE edges (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        from_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata TEXT,
        PRIMARY KEY(repo_id, id)
      );

      INSERT OR IGNORE INTO components (repo_id, id, name, code_anchor)
      SELECT DISTINCT gs.repo_id, c.id, c.name, c.code_anchor
      FROM components_old c
      JOIN graph_memberships gm ON gm.subject_type = 'component' AND gm.subject_id = c.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id;

      INSERT OR IGNORE INTO flows (repo_id, id, name)
      SELECT DISTINCT gs.repo_id, f.id, f.name
      FROM flows_old f
      JOIN graph_memberships gm ON gm.subject_type = 'flow' AND gm.subject_id = f.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id;

      INSERT OR IGNORE INTO claims (repo_id, id, kind, text, truth, intent, code_anchors)
      SELECT DISTINCT gs.repo_id, c.id, c.kind, c.text, c.truth, c.intent, c.code_anchors
      FROM claims_old c
      JOIN graph_memberships gm ON gm.subject_type = 'claim' AND gm.subject_id = c.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id;

      INSERT OR IGNORE INTO edges (repo_id, id, from_id, from_type, to_id, to_type, kind, metadata)
      SELECT DISTINCT gs.repo_id, e.id, e.from_id, e.from_type, e.to_id, e.to_type, e.kind, e.metadata
      FROM edges_old e
      JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id;

      INSERT OR IGNORE INTO sources (repo_id, id, kind, ref, title)
      SELECT DISTINCT gs.repo_id, s.id, s.kind, s.ref, s.title
      FROM sources_old s
      JOIN edges_old e ON
        (e.from_type = 'source' AND e.from_id = s.id) OR
        (e.to_type = 'source' AND e.to_id = s.id)
      JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id;

      INSERT OR IGNORE INTO sources (repo_id, id, kind, ref, title)
      SELECT r.id, s.id, s.kind, s.ref, s.title
      FROM sources_old s
      CROSS JOIN repos r
      WHERE NOT EXISTS (
        SELECT 1
        FROM edges_old e
        JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
        WHERE (e.from_type = 'source' AND e.from_id = s.id)
           OR (e.to_type = 'source' AND e.to_id = s.id)
      );

      INSERT OR IGNORE INTO graph_memberships (scope_id, subject_type, subject_id, memory_commit_id)
      SELECT DISTINCT gm.scope_id, 'source', s.id, gm.memory_commit_id
      FROM sources_old s
      JOIN edges_old e ON
        (e.from_type = 'source' AND e.from_id = s.id) OR
        (e.to_type = 'source' AND e.to_id = s.id)
      JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id;

      INSERT OR IGNORE INTO graph_memberships (scope_id, subject_type, subject_id, memory_commit_id)
      SELECT gs.id, 'source', s.id, mc.id
      FROM sources_old s
      CROSS JOIN repos r
      JOIN graph_scopes gs ON gs.repo_id = r.id AND gs.kind = 'working' AND gs.name = 'working'
      JOIN memory_commits mc ON mc.id = (
        SELECT latest.id
        FROM memory_commits latest
        WHERE latest.scope_id = gs.id
        ORDER BY latest.created_at DESC, latest.rowid DESC
        LIMIT 1
      )
      WHERE NOT EXISTS (
        SELECT 1
        FROM edges_old e
        JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
        WHERE (e.from_type = 'source' AND e.from_id = s.id)
           OR (e.to_type = 'source' AND e.to_id = s.id)
      );

      DROP TABLE components_old;
      DROP TABLE flows_old;
      DROP TABLE claims_old;
      DROP TABLE sources_old;
      DROP TABLE edges_old;

      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlterTable ? "ON" : "OFF"}`);
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function assertLegacySourcesCanBeScoped(db: Database.Database): void {
  const unlinkedSources = db
    .prepare(
      `SELECT s.id
       FROM sources s
       WHERE NOT EXISTS (
         SELECT 1
         FROM edges e
         JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
         WHERE (e.from_type = 'source' AND e.from_id = s.id)
            OR (e.to_type = 'source' AND e.to_id = s.id)
       )
       ORDER BY s.id`,
    )
    .all() as Array<{ id: string }>;
  if (unlinkedSources.length === 0) return;

  const repoCount = (db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }).count;
  const recoveryTargetCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM graph_scopes gs
         WHERE gs.kind = 'working'
           AND gs.name = 'working'
           AND EXISTS (SELECT 1 FROM memory_commits mc WHERE mc.scope_id = gs.id)`,
      )
      .get() as { count: number }
  ).count;
  if (repoCount === 1 && recoveryTargetCount === 1) return;

  const ids = unlinkedSources.map(({ id }) => id).join(", ");
  throw new Error(
    `Cannot safely migrate unlinked legacy source${unlinkedSources.length === 1 ? "" : "s"} ${ids}: ` +
      "repository ownership is ambiguous or no working memory commit is available. " +
      "The legacy source rows were left unchanged; link each source to an evidenced_by edge or migrate it into a single repository before retrying.",
  );
}

function migrateSourceMemberships(db: Database.Database): void {
  const migrateMemberships = db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO graph_memberships (scope_id, subject_type, subject_id, memory_commit_id)
      SELECT DISTINCT gm.scope_id, 'source', s.id, gm.memory_commit_id
      FROM sources s
      JOIN edges e ON
        e.repo_id = s.repo_id AND (
          (e.from_type = 'source' AND e.from_id = s.id) OR
          (e.to_type = 'source' AND e.to_id = s.id)
        )
      JOIN graph_memberships gm ON gm.subject_type = 'edge' AND gm.subject_id = e.id
      JOIN graph_scopes gs ON gs.id = gm.scope_id AND gs.repo_id = s.repo_id;
    `);

    const unscopedSources = db
      .prepare(
        `SELECT s.repo_id, s.id
         FROM sources s
         WHERE NOT EXISTS (
           SELECT 1
           FROM graph_memberships gm
           JOIN graph_scopes gs ON gs.id = gm.scope_id
           WHERE gs.repo_id = s.repo_id
             AND gm.subject_type = 'source'
             AND gm.subject_id = s.id
         )
         ORDER BY s.repo_id, s.id`,
      )
      .all() as Array<{ repo_id: string; id: string }>;

    const recoveryTarget = db.prepare(
      `SELECT gs.id AS scope_id, mc.id AS memory_commit_id
       FROM graph_scopes gs
       JOIN memory_commits mc ON mc.id = (
         SELECT latest.id
         FROM memory_commits latest
         WHERE latest.scope_id = gs.id
         ORDER BY latest.created_at DESC, latest.rowid DESC
         LIMIT 1
       )
       WHERE gs.repo_id = ? AND gs.kind = 'working' AND gs.name = 'working'`,
    );
    const insertMembership = db.prepare(
      `INSERT INTO graph_memberships (scope_id, subject_type, subject_id, memory_commit_id)
       VALUES (?, 'source', ?, ?)`,
    );

    for (const source of unscopedSources) {
      const target = recoveryTarget.get(source.repo_id) as
        | { scope_id: string; memory_commit_id: string }
        | undefined;
      if (target === undefined) {
        throw new Error(
          `Cannot backfill membership for source ${source.id} in repository ${source.repo_id}: ` +
            "no working memory commit is available. The source row was left unchanged.",
        );
      }
      insertMembership.run(target.scope_id, source.id, target.memory_commit_id);
    }
  });

  migrateMemberships();
}

// Stores, per claim, the baseline fingerprint of each code anchor so drift can
// be detected later. Nullable: claims written before this column exist keep a
// null baseline and are reported as "unknown" rather than drifted.
function migrateClaimAnchorFingerprints(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(claims)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "anchor_fingerprints")) return;
  try {
    db.exec("ALTER TABLE claims ADD COLUMN anchor_fingerprints TEXT");
  } catch (error: unknown) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
