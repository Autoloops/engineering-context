import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const temporary = mkdtempSync(join(tmpdir(), "greplica-managed-collaboration-"));
process.env.GREPLICA_HOME = join(temporary, "greplica-home");

const { ManagedGraphMemoryClient } = await import("../dist/libs/knowledge-graph/managed-client.js");
const { canScheduleMemoryUpdates } = await import("../dist/libs/install/repo-installation-store.js");
const { buildGraphViewHtmlFromData } = await import("../dist/libs/knowledge-graph/graph-view/build-graph-view.js");
const { migrate } = await import("../dist/libs/storage/sqlite/migrate.js");

const action = readFileSync(fileURLToPath(new URL("../action.yml", import.meta.url)), "utf8");
assert.match(action, /npm ci --prefix "\$GITHUB_ACTION_PATH" --include=dev/);
assert.match(action, /node "\$GITHUB_ACTION_PATH\/dist\/apps\/cli\/main\.js" memory reconcile/);
assert.doesNotMatch(action, /greplica@latest/);

const repoRoot = join(temporary, "repo");
exec("git", ["init", "--quiet", repoRoot]);
exec("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
exec("git", ["-C", repoRoot, "config", "user.name", "Test"]);
writeFileSync(join(repoRoot, "example.ts"), "export const example = true;\n");
exec("git", ["-C", repoRoot, "add", "example.ts"]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "example"]);
const mergeSha = exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim();

const calls = [];
let applyBody;
const graph = { components: [], flows: [], claims: [], sources: [], edges: [] };
const viewData = {
  generatedAt: "2026-07-28T00:00:00.000Z",
  counts: { components: 0, flows: 0, claims: 0, superseded: 0 },
  components: [],
  flows: [],
  claims: [],
  supersededClaims: [],
  claimsTimeline: { summary: { total: 0, sessionPct: 0, codePct: 0 }, events: [] },
};
const fetchImpl = async (input, init) => {
  const url = String(input);
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  calls.push({ url, method: init?.method, body });
  if (url.endsWith("/proposals/review")) {
    return jsonResponse({
      valid: true,
      errors: [],
      duplicate_warnings: {},
      working_head: "working-1",
      working_revision: 3,
      main_head: "main-1",
    });
  }
  if (url.endsWith("/proposals/apply")) {
    applyBody = body;
    return jsonResponse({
      memory_commit_id: "commit-1",
      scope_id: "working-user-1",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      created: { components: 0, flows: 0, claims: 0, sources: 1, edges: 0 },
    });
  }
  if (url.includes("/graph/view-data")) return jsonResponse(viewData);
  if (url.endsWith("/graph/context")) {
    return jsonResponse({
      query: body.query,
      search_config_version: "test",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      claims: [],
      components: [],
      flows: [],
      ranked_results: [],
      sources: [],
    });
  }
  if (url.includes("/graph")) return jsonResponse(graph);
  if (url.endsWith("/proposals")) return jsonResponse([]);
  if (url.includes("/proposals/")) return jsonResponse({ id: "proposal-1" });
  if (url.endsWith("/memory-prs")) return jsonResponse([]);
  if (url.includes("/memory-prs/")) return jsonResponse({ id: "memory-pr-1" });
  if (url.endsWith("/memory/status")) return jsonResponse({
    queued: 0,
    running: 0,
    failed: 0,
    repair_attempts: 0,
    repaired_commits: 0,
    promoted_commits: 0,
    quarantined_commits: 0,
    cleared_working_commits: 0,
    remaining_active_working_commits: 0,
  });
  throw new Error(`Unexpected client URL ${url}`);
};

const installation = {
  id: "local-repo-1",
  repoKey: "github:example/project",
  remoteUrl: "https://github.com/example/project.git",
  rootPath: repoRoot,
  repoName: "project",
  defaultBranch: "main",
  status: "active",
  activeMode: "managed",
  managedRepoId: "11111111-1111-4111-8111-111111111111",
  managedRole: "contributor",
  managedAccessStatus: "active",
  hooksEnabled: true,
  autoMemoryUpdates: true,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};
const client = new ManagedGraphMemoryClient(installation, {
  repo_root: repoRoot,
  remote_url: installation.remoteUrl,
  repo_name: "project",
  default_branch: "main",
}, {
  apiUrl: "https://memory.example.test",
  token: "managed-token",
  credentials: {
    version: 2,
    apiUrl: "https://memory.example.test",
    token: "managed-token",
    user: { id: "user-1", githubLogin: "me", githubUserId: "1" },
  },
  fetchImpl,
});

await client.readGraph({ base: "main", working_users: [] });
let request = new URL(calls.at(-1).url);
assert.equal(request.searchParams.get("main_only"), "true");
await client.contextGraph("auth", { base: "main", working_users: ["alice", "alice"] });
assert.deepEqual(calls.at(-1).body.view.working_users, ["me", "alice"]);
await client.viewData({ base: "main", memory_pr_id: "memory-pr-1" });
request = new URL(calls.at(-1).url);
assert.equal(request.searchParams.get("memory_pr_id"), "memory-pr-1");

await client.applyProposal({
  title: "Session memory",
  creates: { sources: [{ id: "source-1", kind: "session", ref: "codex-session:session-1" }] },
});
assert.equal(applyBody.working_revision, 3);
assert.equal(applyBody.main_head, "main-1");
assert.equal(applyBody.context.git_head, mergeSha);
assert.equal(applyBody.context.head_repository, "example/project");
assert.deepEqual(applyBody.context.session_refs, [{ id: "codex-session:session-1", agent_platform: "codex" }]);
assert.equal("author" in applyBody, false);
assert.equal("username" in applyBody, false);

await client.listProposals();
await client.showProposal("proposal/1");
await client.listMemoryPrs();
await client.showMemoryPr("memory/pr");
await client.retryMemoryPr("memory/pr");
await client.memoryStatus();
assert.ok(calls.some((call) => call.url.endsWith("/proposals/proposal%2F1")));
assert.ok(calls.some((call) => call.url.endsWith("/memory-prs/memory%2Fpr/retry")));

assert.equal(canScheduleMemoryUpdates(installation), true);
assert.equal(canScheduleMemoryUpdates({ ...installation, managedRole: "reader" }), false);

const legacyDb = new Database(":memory:");
legacyDb.exec(`
  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    repo_key TEXT UNIQUE,
    remote_url TEXT UNIQUE,
    root_path TEXT UNIQUE,
    repo_name TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('active', 'inactive')),
    active_mode TEXT NOT NULL DEFAULT 'local' CHECK(active_mode IN ('local', 'managed')),
    managed_repo_id TEXT,
    managed_role TEXT CHECK(managed_role IN ('reader', 'memory_admin')),
    managed_access_status TEXT CHECK(managed_access_status IN ('active', 'pending', 'suspended', 'revoked')),
    managed_access_refreshed_at TEXT,
    hooks_enabled INTEGER NOT NULL DEFAULT 1 CHECK(hooks_enabled IN (0, 1)),
    auto_memory_updates INTEGER NOT NULL DEFAULT 1 CHECK(auto_memory_updates IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
migrate(legacyDb);
legacyDb.prepare(
  `INSERT INTO repos (
    id, repo_key, repo_name, default_branch, managed_role, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run("repo-1", "repo-key", "repo", "main", "contributor", "2026-07-28T00:00:00.000Z", "2026-07-28T00:00:00.000Z");
assert.equal(legacyDb.prepare("SELECT managed_role FROM repos").get().managed_role, "contributor");
legacyDb.close();

const html = buildGraphViewHtmlFromData({
  ...viewData,
  counts: { ...viewData.counts, claims: 1 },
  claims: [{
    id: "claim.logical",
    text: "A personal draft",
    kind: "fact",
    session: "codex-session:session-1",
    source: "session",
    freshness: "active",
    componentIds: [],
    flowIds: [],
    createdAt: "2026-07-28T00:00:00.000Z",
    memoryCommitId: "commit-1",
    provenance: {
      version_id: "version-1",
      scope_kind: "working",
      author_github_login: "alice",
      memory_commit_state: "active",
      memory_pr_id: "memory-pr-1",
      commit_role: "repair",
    },
  }],
  claimsTimeline: {
    summary: { total: 1, sessionPct: 100, codePct: 0 },
    events: [],
  },
});
assert.match(html, /data-version-id="version-1"/);
assert.match(html, /data-author="alice"/);
assert.match(html, /provenance-badge[^>]*>repair</);
assert.match(html, /id="claims-filter-scope"/);
assert.match(html, /id="claims-filter-author"/);
assert.match(html, /id="claims-filter-memory-state"/);
assert.match(html, /id="claims-filter-memory-pr"/);
assert.match(html, /id="claims-filter-commit-role"/);

let attestation;
const server = createServer(async (incoming, response) => {
  const url = new URL(incoming.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/oidc") {
    assert.equal(incoming.headers.authorization, "Bearer oidc-request-token");
    assert.equal(url.searchParams.get("audience"), "greplica-managed");
    send(200, { value: "github-oidc-token" });
    return;
  }
  assert.equal(incoming.headers.authorization, "Bearer github-oidc-token");
  if (url.pathname.endsWith("/memory/reconcile/candidate")) {
    assert.equal(url.searchParams.get("merge_sha"), mergeSha);
    send(200, {
      memory_pr_id: "memory-pr-1",
      merge_sha: mergeSha,
      memory_commit_ids: ["commit-1"],
      commits: [{ memory_commit_id: "commit-1", git_head: mergeSha, head_repository: "example/project" }],
      claim_versions: [{
        version_id: "version-1",
        claim: {
          id: "claim.logical",
          kind: "fact",
          text: "Version-keyed audit",
          truth: "code_verified",
          intent: "intended",
        },
      }],
    });
    return;
  }
  if (url.pathname.endsWith("/memory/reconcile/attest")) {
    attestation = body;
    send(200, { accepted: true, memory_pr_id: "memory-pr-1", job_id: "job-1", state: "queued" });
    return;
  }
  send(404, { message: `Unexpected ${incoming.method} ${url.pathname}` });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const result = await run(process.execPath, [
    cliPath,
    "memory",
    "reconcile",
    "--managed-repo",
    installation.managedRepoId,
    "--merge-sha",
    mergeSha,
    "--api-url",
    apiUrl,
  ], repoRoot, {
    ...process.env,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${apiUrl}/oidc?api-version=1`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    GITHUB_REPOSITORY: "example/project",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "123",
  });
  assert.match(result.stdout, /"accepted": true/);
  assert.equal(attestation.audit_key, "version_id");
  assert.deepEqual(attestation.memory_commit_ids, ["commit-1"]);
  assert.deepEqual(attestation.ancestry, [{ memory_commit_id: "commit-1", git_head: mergeSha, is_ancestor: true }]);
  assert.equal(attestation.anchor_audit.result.missing_anchors[0].claim_id, "version-1");
  assert.equal(attestation.repository, "example/project");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Managed collaboration checks passed.");

function exec(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  });
}
