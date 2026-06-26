import type Database from "better-sqlite3";
import { schemaSql } from "./schema.js";

export function migrate(db: Database.Database): void {
  db.exec(schemaSql);
  migrateReposTable(db);
  migrateClaimsTable(db);
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
