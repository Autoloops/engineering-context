import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), "greplica-repo-installations-"));
process.env.GREPLICA_HOME = join(temporary, "home");

const { canonicalRepoKey } = await import(new URL("dist/libs/install/repo-identity.js", root));
const { RepoInstallationStore } = await import(new URL("dist/libs/install/repo-installation-store.js", root));
const { LocalAgentRuntimeStore } = await import(new URL("dist/libs/hooks/runtime-store.js", root));
const { installGreplica } = await import(new URL("dist/libs/install/install.js", root));
const { ensureGreplicaConfig } = await import(new URL("dist/libs/config/greplica-config.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const {
  managedCredentialsPath,
  managedToken,
  writeManagedCredentials,
} = await import(new URL("dist/libs/config/managed-credentials.js", root));

const ssh = canonicalRepoKey({ remote_url: "git@github.com:Autoloops/greplica.git" });
const https = canonicalRepoKey({ remote_url: "https://github.com/autoloops/greplica.git" });
const sshUrl = canonicalRepoKey({ remote_url: "ssh://git@github.com/Autoloops/greplica.git" });
assert.equal(ssh, https);
assert.equal(https, sshUrl);

const localRepo = repo("local", "git@github.com:Autoloops/greplica.git");
const sameRemoteClone = repo("clone", "https://github.com/autoloops/greplica.git");
const managedRepo = repo("managed", "https://github.com/example/managed.git");
const absentRepo = repo("absent", "https://github.com/example/absent.git");
const db = openDatabase();
const installations = new RepoInstallationStore(db);
const local = installations.activateLocal(localRepo, {
  hooksEnabled: true,
  autoMemoryUpdates: true,
});
const clone = installations.activateLocal(sameRemoteClone, {
  hooksEnabled: true,
  autoMemoryUpdates: true,
});
assert.equal(local.id, clone.id, "equivalent remotes must share one installation row");

const managed = installations.activateManaged(managedRepo, {
  managedRepoId: "managed_repo_1",
  managedRole: "reader",
  hooksEnabled: true,
  autoMemoryUpdates: true,
});
assert.equal(managed.activeMode, "managed");
assert.equal(managed.autoMemoryUpdates, true, "reader installs retain the update preference for later promotion");
await assert.rejects(installGreplica({
  mode: "local",
  platform: "codex",
  embedding: "local",
  hooks: false,
  autoMemoryUpdates: false,
  repo: managedRepo,
}), /mode-switch confirmation/);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM graph_scopes WHERE repo_id = ?").get(managed.id).count, 0,
  "a refused mode switch must not create local graph scopes");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repos").get().count, 2);
assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);

const runtime = new LocalAgentRuntimeStore(db, {
  stopThreshold: 1,
  timeThresholdMinutes: 40,
  currentGraceMinutes: 5,
});
assert.equal(runtime.recordHook({
  repo: absentRepo,
  platform: "codex",
  sessionId: "absent",
  eventName: "Stop",
}), undefined);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repos").get().count, 2, "hooks must not create repo rows");

const readerHook = runtime.recordHook({
  repo: managedRepo,
  platform: "codex",
  sessionId: "reader-session",
  cwd: managedRepo.repo_root,
  eventName: "Stop",
});
assert.ok(readerHook);
assert.equal(runtime.claimDueMemoryUpdateAttempts().length, 0);

const promotionAt = new Date("2026-07-21T00:00:00.000Z");
installations.updateManagedAccess("managed_repo_1", "memory_admin", "active", promotionAt);
const promoted = installations.find(managedRepo);
assert.equal(promoted.managedRole, "memory_admin");
assert.equal(runtime.claimDueMemoryUpdateAttempts(promotionAt).length, 0, "promotion starts prior reader sessions fresh");
assert.equal(
  db.prepare("SELECT stops_since_memory_current FROM agent_sessions WHERE session_id = 'reader-session'").get().stops_since_memory_current,
  0,
  "promotion must start fresh",
);

assert.throws(
  () => installations.activateLocal(managedRepo, { hooksEnabled: true, autoMemoryUpdates: true }),
  /mode-switch confirmation/,
);
const switched = installations.activateLocal(managedRepo, {
  hooksEnabled: true,
  autoMemoryUpdates: true,
  allowModeSwitch: true,
});
assert.equal(switched.managedRepoId, "managed_repo_1", "mode switches retain managed binding");
assert.equal(installations.deactivate(managedRepo).status, "inactive");
db.close();

writeManagedCredentials({
  version: 1,
  token: "stored-token",
  user: { id: "user_1", githubLogin: "octocat", githubUserId: "1" },
});
assert.equal(statSync(managedCredentialsPath()).mode & 0o777, 0o600);
process.env.GREPLICA_MANAGED_TOKEN = "environment-token";
assert.equal(managedToken(), "environment-token");
delete process.env.GREPLICA_MANAGED_TOKEN;

checkLegacyActivationMigration();
checkOldestLegacyActivationMigration();
checkLegacyConfigMigration();
console.log("Repository installation checks passed.");

function repo(name, remoteUrl) {
  const repoRoot = join(temporary, name);
  mkdirSync(repoRoot, { recursive: true });
  return { repo_root: repoRoot, remote_url: remoteUrl, repo_name: name, default_branch: "main" };
}

function checkLegacyActivationMigration() {
  const path = join(temporary, "legacy.db");
  const legacy = new Database(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
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
      parent_scope_id TEXT,
      ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, kind, name)
    );
    INSERT INTO repos VALUES ('repo_active', 'https://github.com/example/active.git', NULL, 'active', 'main');
    INSERT INTO repos VALUES ('repo_inactive', 'https://github.com/example/inactive.git', NULL, 'inactive', 'main');
    INSERT INTO graph_scopes VALUES ('scope_active', 'repo_active', 'main', 'main', NULL, 'main', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const migrated = openDatabase(path);
  assert.equal(migrated.prepare("SELECT status FROM repos WHERE id = 'repo_active'").get().status, "active");
  assert.equal(migrated.prepare("SELECT status FROM repos WHERE id = 'repo_inactive'").get().status, "inactive");
  migrated.close();
}

function checkOldestLegacyActivationMigration() {
  const path = join(temporary, "oldest-legacy.db");
  const legacy = new Database(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      remote_url TEXT NOT NULL UNIQUE,
      repo_name TEXT NOT NULL,
      default_branch TEXT NOT NULL
    );
    CREATE TABLE graph_scopes (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_scope_id TEXT,
      ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, kind, name)
    );
    INSERT INTO repos VALUES ('repo_active', 'https://github.com/example/oldest.git', 'oldest', 'main');
    INSERT INTO graph_scopes VALUES ('scope_active', 'repo_active', 'main', 'main', NULL, 'main', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const migrated = openDatabase(path);
  assert.equal(migrated.prepare("SELECT status FROM repos WHERE id = 'repo_active'").get().status, "active");
  migrated.close();
}

function checkLegacyConfigMigration() {
  const path = join(temporary, "legacy-config.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    mode: "managed",
    embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, batchSize: 100 },
    session: { stopThreshold: 9, timeThresholdMinutes: 50, currentGraceMinutes: 6 },
  }));
  const config = ensureGreplicaConfig(path);
  assert.equal(config.version, 2);
  assert.equal(config.embedding.provider, "openai");
  assert.equal(config.session.stopThreshold, 9);
  assert.equal(config.managed.apiUrl, "https://api.greplica.com");
  const rewritten = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("mode" in rewritten, false, "global mode is removed during config migration");
}
