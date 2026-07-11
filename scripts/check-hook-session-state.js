import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { HookSessionStore } = await import(new URL("dist/libs/hooks/session-state.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { migrate } = await import(new URL("dist/libs/storage/sqlite/migrate.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-hook-session-state-test-"));
const db = openDatabase(join(tmp, "graph.db"));
const sessionConfig = {
  stopThreshold: 7,
  timeThresholdMinutes: 40,
  currentGraceMinutes: 5,
  autoMemoryUpdates: true,
};
const startedAt = new Date("2026-07-11T00:00:00.000Z");
const beforeThreshold = new Date("2026-07-11T00:39:00.000Z");
const afterThreshold = new Date("2026-07-11T00:41:00.000Z");

try {
  db.prepare(
    `INSERT INTO repos (id, remote_url, root_path, repo_name, default_branch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("repo.session-state", null, join(tmp, "repo"), "session-state", "main");

  const store = new HookSessionStore(db, sessionConfig);
  const firstHook = store.recordHook({
    platform: "codex",
    sessionId: "session-time-threshold",
    repoId: "repo.session-state",
    eventName: "UserPromptSubmit",
    now: startedAt,
  });
  assert.equal(firstHook.session.first_seen_at, startedAt.toISOString());
  assert.deepEqual(store.claimDueMemoryUpdateAttempts(startedAt), []);

  const secondHook = store.recordHook({
    platform: "codex",
    sessionId: "session-time-threshold",
    repoId: "repo.session-state",
    eventName: "UserPromptSubmit",
    now: beforeThreshold,
  });
  assert.equal(secondHook.session.first_seen_at, startedAt.toISOString());
  assert.deepEqual(store.claimDueMemoryUpdateAttempts(beforeThreshold), []);

  const thresholdHook = store.recordHook({
    platform: "codex",
    sessionId: "session-time-threshold",
    repoId: "repo.session-state",
    eventName: "UserPromptSubmit",
    now: afterThreshold,
  });
  assert.equal(thresholdHook.session.first_seen_at, startedAt.toISOString());
  assert.deepEqual(
    store.claimDueMemoryUpdateAttempts(afterThreshold).map((attempt) => attempt.reason),
    ["time_threshold"],
  );

  assert.equal(
    store.markMemoryCurrent({
      platform: "codex",
      sessionId: "session-time-threshold",
      repoId: "repo.session-state",
      now: afterThreshold,
    }),
    true,
  );
  const afterCurrent = new Date("2026-07-11T00:42:00.000Z");
  store.recordHook({
    platform: "codex",
    sessionId: "session-time-threshold",
    repoId: "repo.session-state",
    eventName: "UserPromptSubmit",
    now: afterCurrent,
  });
  assert.deepEqual(store.claimDueMemoryUpdateAttempts(afterCurrent), []);
} finally {
  db.close();
}

const legacyDb = new Database(join(tmp, "legacy.db"));
try {
  legacyDb.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      remote_url TEXT UNIQUE,
      root_path TEXT UNIQUE,
      repo_name TEXT NOT NULL,
      default_branch TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
      platform TEXT NOT NULL,
      session_id TEXT NOT NULL,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      transcript_path TEXT,
      cwd TEXT,
      guidance_injected_at TEXT,
      stops_since_memory_current INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      last_memory_current_at TEXT,
      PRIMARY KEY(platform, session_id)
    );
  `);
  legacyDb.prepare(
    `INSERT INTO repos (id, remote_url, root_path, repo_name, default_branch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("repo.legacy", null, join(tmp, "legacy-repo"), "legacy", "main");
  legacyDb.prepare(
    `INSERT INTO agent_sessions (
      platform, session_id, repo_id, transcript_path, cwd, guidance_injected_at,
      stops_since_memory_current, last_seen_at, last_memory_current_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("codex", "legacy-session", "repo.legacy", null, null, null, 0, startedAt.toISOString(), null);

  migrate(legacyDb);

  const migrated = legacyDb
    .prepare("SELECT first_seen_at, last_seen_at FROM agent_sessions WHERE session_id = ?")
    .get("legacy-session");
  assert.equal(migrated.first_seen_at, startedAt.toISOString());
  assert.equal(migrated.last_seen_at, startedAt.toISOString());

  const migratedStore = new HookSessionStore(legacyDb, sessionConfig);
  assert.deepEqual(
    migratedStore.claimDueMemoryUpdateAttempts(afterThreshold).map((attempt) => attempt.reason),
    ["time_threshold"],
  );
} finally {
  legacyDb.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("check-hook-session-state: ok");
