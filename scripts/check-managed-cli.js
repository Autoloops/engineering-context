import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const temporary = mkdtempSync(join(tmpdir(), "greplica-managed-cli-"));
const managedRepoId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-21T00:00:00.000Z";
const managedRepository = {
  id: managedRepoId,
  org_id: orgId,
  name: "shared-memory",
  source_type: "generic",
  discovery: "unlisted",
  effective_role: "reader",
  access_status: "active",
  created_at: now,
  updated_at: now,
};
let deviceStarts = 0;
let requestCount = 0;
let importedSnapshot;

const server = createServer(async (request, response) => {
  requestCount += 1;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const send = (status, value, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(value));
  };

  if (request.method === "POST" && request.url === "/v1/auth/github/device/start") {
    deviceStarts += 1;
    send(200, {
      device_code: `device-${deviceStarts}`,
      user_code: `CODE-${deviceStarts}`,
      verification_uri: "https://github.com/login/device",
      expires_in: 30,
      interval: 0.01,
    });
    return;
  }
  if (request.method === "POST" && request.url === "/v1/auth/github/device/poll") {
    const userNumber = body.device_code === "device-2" ? 2 : 1;
    send(200, {
      status: "complete",
      token: `token-${userNumber}`,
      user: {
        id: `${userNumber}0000000-0000-4000-8000-000000000000`,
        github_user_id: String(userNumber),
        github_login: `contributor-${userNumber}`,
        created_at: now,
        updated_at: now,
      },
    });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/auth/me") {
    const userNumber = request.headers.authorization === "Bearer token-2" ? 2 : 1;
    send(200, {
      user: {
        id: `${userNumber}0000000-0000-4000-8000-000000000000`,
        github_user_id: String(userNumber),
        github_login: `contributor-${userNumber}`,
        created_at: now,
        updated_at: now,
      },
    });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/repos") {
    send(200, [managedRepository], { "x-greplica-token": "renewed-token" });
    return;
  }
  if (request.method === "GET" && request.url === `/v1/repos/${managedRepoId}/graph`) {
    send(200, { components: [], flows: [], claims: [], sources: [], edges: [] }, {
      "x-greplica-repo-role": managedRepository.effective_role,
      "x-greplica-access-status": "active",
    });
    return;
  }
  if (request.method === "POST" && request.url === `/v1/repos/${managedRepoId}/import`) {
    importedSnapshot = body;
    send(200, {
      memory_commit_id: "memory-commit-1",
      scope_id: "main-scope-1",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      created: { components: 0, flows: 0, claims: 0, sources: 0, edges: 0 },
    }, { "x-greplica-repo-role": "memory_admin", "x-greplica-access-status": "active" });
    return;
  }
  send(404, { message: `Unexpected ${request.method} ${request.url}` });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const greplicaHome = join(temporary, "greplica-home");
  const codexHome = join(temporary, "codex-home");
  const fakeBin = join(temporary, "bin");
  const managedRepo = join(temporary, "managed-repo");
  const localRepo = join(temporary, "local-repo");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(managedRepo, { recursive: true });
  mkdirSync(localRepo, { recursive: true });
  writeFileSync(join(fakeBin, "open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "open"), 0o755);
  await run("git", ["init", "--quiet"], managedRepo);
  await run("git", ["init", "--quiet"], localRepo);

  const env = {
    ...process.env,
    GREPLICA_HOME: greplicaHome,
    CODEX_HOME: codexHome,
    GREPLICA_INSTALL_SKIP_PREWARM: "1",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };

  const login = await run(process.execPath, [cliPath, "login", "--api-url", apiUrl], managedRepo, env);
  assert.match(login.stdout, /Logged in as contributor-1/);
  const credentialsPath = join(greplicaHome, "credentials.json");
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);

  const install = await run(process.execPath, [
    cliPath,
    "install",
    "--mode",
    "managed",
    "--platform",
    "codex",
    "--managed-repo",
    managedRepoId,
    "--hooks",
    "enabled",
    "--auto-memory",
    "enabled",
  ], managedRepo, env);
  assert.match(install.stdout, /Mode: managed/);
  assert.match(install.stdout, /reader access records session guidance but does not schedule memory updates/);
  assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).token, "renewed-token");

  const dbPath = join(greplicaHome, "graph.db");
  let db = new Database(dbPath);
  let managedRow = db.prepare("SELECT * FROM repos WHERE managed_repo_id = ?").get(managedRepoId);
  const managedLocalId = managedRow.id;
  assert.equal(managedRow.active_mode, "managed");
  assert.equal(managedRow.managed_role, "reader");
  assert.equal(managedRow.auto_memory_updates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM graph_scopes WHERE repo_id = ?").get(managedRow.id).count, 0);
  db.close();
  const managedGraph = await run(process.execPath, [cliPath, "graph", "read"], managedRepo, env);
  assert.match(managedGraph.stdout, /Current graph view: main \+ working/);

  const requestsBeforeHook = requestCount;
  const hook = await run(process.execPath, [cliPath, "hook", "ingest", "--platform", "codex"], managedRepo, env, JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "managed-reader-session",
    transcript_path: join(temporary, "transcript.jsonl"),
    cwd: managedRepo,
  }));
  assert.match(hook.stdout, /Greplica hook guidance/);
  assert.equal(requestCount, requestsBeforeHook, "foreground hooks must not call the managed API");
  db = new Database(dbPath);
  const session = db.prepare("SELECT * FROM agent_sessions WHERE session_id = 'managed-reader-session'").get();
  assert.equal(session.cwd, managedRepo);
  assert.equal(session.transcript_path, join(temporary, "transcript.jsonl"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get().count, 1);
  db.close();

  const localInstall = await run(process.execPath, [
    cliPath,
    "install",
    "--mode",
    "local",
    "--hooks",
    "disabled",
  ], localRepo, env);
  assert.match(localInstall.stdout, /Installed Greplica for Codex/);
  db = new Database(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repos WHERE active_mode = 'local'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repos WHERE active_mode = 'managed'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM graph_scopes").get().count, 2);
  db.close();
  const requestsBeforeLocalRead = requestCount;
  const localGraph = await run(process.execPath, [cliPath, "graph", "read"], localRepo, env);
  assert.match(localGraph.stdout, /Current graph view: main \+ working/);
  assert.equal(requestCount, requestsBeforeLocalRead, "local graph commands must not call the managed API");

  managedRepository.effective_role = "memory_admin";
  const connected = await run(process.execPath, [
    cliPath,
    "repo",
    "connect",
    "--managed-repo",
    managedRepoId,
    "--confirm-mode-switch",
  ], localRepo, env);
  assert.match(connected.stdout, /Connected/);
  const published = await run(process.execPath, [cliPath, "repo", "publish", "--from-local"], localRepo, env);
  assert.match(published.stdout, /Published one local memory snapshot/);
  assert.ok(importedSnapshot);
  assert.deepEqual(importedSnapshot.anchor_audit.result, {
    missing_anchors: [], missing_files: [], missing_symbols: [], ambiguous_symbols: [], unsupported_languages: [], drifted: [],
  });
  assert.deepEqual(importedSnapshot.anchor_audit.fingerprints, {});
  assert.equal("repo" in importedSnapshot, false);
  assert.equal("cwd" in importedSnapshot, false);
  assert.equal("remote_url" in importedSnapshot, false);

  const secondLogin = await run(process.execPath, [cliPath, "login"], managedRepo, env);
  assert.match(secondLogin.stdout, /Logged in as contributor-2/);
  db = new Database(dbPath);
  managedRow = db.prepare("SELECT * FROM repos WHERE id = ?").get(managedLocalId);
  assert.equal(managedRow.managed_role, null);
  assert.equal(managedRow.managed_access_status, null);
  assert.equal(managedRow.auto_memory_updates, 1);
  db.close();

  await run(process.execPath, [cliPath, "logout"], managedRepo, env);
  assert.equal(existsSync(credentialsPath), false);
  console.log("Managed CLI checks passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function run(command, args, cwd, env = process.env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`));
    });
    child.stdin.end(input);
  });
}
