import type Database from "better-sqlite3";
import { schemaSql } from "./schema.js";

export function migrate(db: Database.Database): void {
  db.exec(schemaSql);
  migrateReposTable(db);
  migrateClaimsTable(db);
  migrateGraphObjectTables(db);
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
