import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { greplicaHome } from "../../config/greplica-home.js";
import { migrate } from "./migrate.js";

export function defaultDatabasePath(): string {
  return join(greplicaHome(), "graph.db");
}

export function openDatabase(path = defaultDatabasePath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
