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
const {
  buildGraphViewData,
  buildGraphViewHtmlFromData,
} = await import("../dist/libs/knowledge-graph/graph-view/build-graph-view.js");
const { renderGraphContextMarkdown } = await import(
  "../dist/libs/knowledge-graph/graph-context/render.js"
);
const { fingerprintClaimAnchors } = await import(
  "../dist/libs/knowledge-graph/code-anchors/fingerprint.js"
);
const { migrate } = await import("../dist/libs/storage/sqlite/migrate.js");

const action = readFileSync(fileURLToPath(new URL("../action.yml", import.meta.url)), "utf8");
assert.match(action, /npm ci --prefix "\$GITHUB_ACTION_PATH" --include=dev/);
assert.match(action, /node "\$GITHUB_ACTION_PATH\/dist\/apps\/cli\/main\.js" memory reconcile/);
assert.match(action, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
assert.match(action, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
assert.doesNotMatch(action, /uses: actions\/(?:checkout|setup-node)@v\d/);
assert.doesNotMatch(action, /greplica@latest/);
const reusableWorkflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/reconcile.yml", import.meta.url)),
  "utf8",
);
assert.match(reusableWorkflow, /workflow_call:/);
assert.match(reusableWorkflow, /contents: read/);
assert.match(reusableWorkflow, /id-token: write/);
assert.match(reusableWorkflow, /api-url: https:\/\/memory\.autoloops\.ai/);
assert.match(reusableWorkflow, /oidc-audience: greplica-managed/);
assert.doesNotMatch(reusableWorkflow, /\$\{\{ inputs\.(?:api-url|oidc-audience) \}\}/);
assert.match(
  reusableWorkflow,
  /uses: Autoloops\/greplica@b7a7969b786f9af4f257fa4564628d2e40874454/,
);
assert.doesNotMatch(reusableWorkflow, /uses: Autoloops\/greplica@(main|refs\/heads\/|v\d)/);

const repoRoot = join(temporary, "repo");
exec("git", ["init", "--quiet", repoRoot]);
exec("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
exec("git", ["-C", repoRoot, "config", "user.name", "Test"]);
writeFileSync(join(repoRoot, "example.ts"), "export function example() { return 0; }\n");
exec("git", ["-C", repoRoot, "add", "example.ts"]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "example"]);
const baseSha = exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim();
const defaultBranch = exec("git", ["-C", repoRoot, "branch", "--show-current"]).trim();
exec("git", ["-C", repoRoot, "checkout", "--quiet", "-b", "feature"]);
writeFileSync(join(repoRoot, "example.ts"), "export function example() { return 1; }\n");
exec("git", ["-C", repoRoot, "add", "example.ts"]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "feature"]);
const featureSha = exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim();
exec("git", ["-C", repoRoot, "checkout", "--quiet", defaultBranch]);
writeFileSync(join(repoRoot, "example.ts"), "export function example() { return 2; }\n");
exec("git", ["-C", repoRoot, "add", "example.ts"]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "squash feature"]);
const codeMergeSha = exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim();
exec("git", ["-C", repoRoot, "commit", "--quiet", "--allow-empty", "-m", "default branch descendant"]);
const mergeSha = exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim();
assert.equal(gitIsAncestor(repoRoot, codeMergeSha, mergeSha), true,
  "fixture must place the code PR merge before the exact default checkout");
assert.equal(gitIsAncestor(repoRoot, featureSha, mergeSha), false, "fixture must model a squash/rebase merge");
const unrelatedCodeMergeSha = exec(
  "git",
  ["-C", repoRoot, "commit-tree", `${featureSha}^{tree}`, "-p", featureSha, "-m", "force-pushed merge"],
).trim();
assert.equal(gitIsAncestor(repoRoot, unrelatedCodeMergeSha, mergeSha), false,
  "fixture must include a code merge outside the exact default checkout");
const originRoot = join(temporary, "origin.git");
exec("git", ["init", "--quiet", "--bare", originRoot]);
exec("git", ["-C", repoRoot, "remote", "add", "origin", originRoot]);
exec("git", ["-C", repoRoot, "push", "--quiet", "origin", `${defaultBranch}:refs/heads/${defaultBranch}`]);
exec("git", ["-C", repoRoot, "push", "--quiet", "origin", `${featureSha}:refs/pull/7/head`]);
const versionOneAnchor = { file: "example.ts", symbol: "example" };
const componentAnchor = { file: "example.ts" };
exec("git", ["-C", repoRoot, "checkout", "--quiet", "--detach", featureSha]);
const versionOneBaseline = await fingerprintClaimAnchors(repoRoot, [versionOneAnchor]);
const componentBaseline = await fingerprintClaimAnchors(repoRoot, [componentAnchor]);
exec("git", ["-C", repoRoot, "checkout", "--quiet", "--detach", mergeSha]);
assert.notEqual(
  (await fingerprintClaimAnchors(repoRoot, [versionOneAnchor]))["example.ts#example"],
  versionOneBaseline["example.ts#example"],
  "fixture must change the anchored symbol body on the merged checkout",
);

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
  calls.push({ url, method: init?.method, body, headers: new Headers(init?.headers) });
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
      claims: [{
        object: {
          id: "claim.conflict",
          kind: "fact",
          text: "First personal version",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "example.ts", symbol: "example" }],
          provenance: {
            version_id: "context-version-1",
            scope_kind: "working",
            author_github_login: "alice",
            author_github_login_snapshot: "alice-old",
            proposal_id: "context-proposal-1",
            memory_commit_id: "context-commit-1",
            session_refs: [{ id: "codex-session:context-1", agent_platform: "codex" }],
            agent_platform: "codex",
            git_head: mergeSha,
            head_repository: "example/project",
            head_ref: "feature",
            branch: "feature",
            dirty: false,
            code_pr_number: 7,
            memory_pr_id: "memory-pr-1",
            commit_role: "repair",
            memory_commit_state: "active",
            promotion_id: "promotion-1",
            quarantine_reason: "superseded repair",
            origins: [{
              version_id: "source-version-bob",
              scope_kind: "working",
              author_user_id: "22222222-2222-4222-8222-222222222222",
              author_github_login: "bob",
              author_github_login_snapshot: "bob-old",
              proposal_id: "origin-proposal-bob",
              memory_commit_id: "origin-commit-bob",
              session_refs: [{ id: "claude-session:origin-bob", agent_platform: "claude" }],
              agent_platform: "claude",
              git_head: featureSha,
              head_repository: "bob/project",
              head_ref: "feature",
              branch: "feature",
              dirty: true,
            }],
          },
        },
        code_anchors: [],
        about: [],
        evidence: [],
      }, {
        object: {
          id: "claim.conflict",
          kind: "fact",
          text: "Second personal version",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "example.ts", symbol: "notThere" }],
          provenance: {
            version_id: "context-version-2",
            scope_kind: "working",
            author_github_login: "bob",
          },
        },
        code_anchors: [],
        about: [],
        evidence: [],
      }],
      components: [],
      flows: [],
      ranked_results: [{
        type: "claim",
        object: {
          id: "claim.conflict",
          kind: "fact",
          text: "First personal version",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "example.ts", symbol: "example" }],
          provenance: {
            version_id: "context-version-1",
            scope_kind: "working",
            author_github_login: "alice",
            author_github_login_snapshot: "alice-old",
            proposal_id: "context-proposal-1",
            memory_commit_id: "context-commit-1",
            session_refs: [{ id: "codex-session:context-1", agent_platform: "codex" }],
            agent_platform: "codex",
            git_head: mergeSha,
            head_repository: "example/project",
            head_ref: "feature",
            branch: "feature",
            dirty: false,
            code_pr_number: 7,
            memory_pr_id: "memory-pr-1",
            commit_role: "repair",
            memory_commit_state: "active",
            promotion_id: "promotion-1",
            quarantine_reason: "superseded repair",
            origins: [{
              version_id: "source-version-bob",
              scope_kind: "working",
              author_user_id: "22222222-2222-4222-8222-222222222222",
              author_github_login: "bob",
              author_github_login_snapshot: "bob-old",
              proposal_id: "origin-proposal-bob",
              memory_commit_id: "origin-commit-bob",
              session_refs: [{ id: "claude-session:origin-bob", agent_platform: "claude" }],
              agent_platform: "claude",
              git_head: featureSha,
              head_repository: "bob/project",
              head_ref: "feature",
              branch: "feature",
              dirty: true,
            }],
          },
        },
        code_anchors: [],
        about: [],
        evidence: [],
      }, {
        type: "claim",
        object: {
          id: "claim.conflict",
          kind: "fact",
          text: "Second personal version",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "example.ts", symbol: "notThere" }],
          provenance: {
            version_id: "context-version-2",
            scope_kind: "working",
            author_github_login: "bob",
          },
        },
        code_anchors: [],
        about: [],
        evidence: [],
      }],
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
assert.match(calls.at(-1).headers.get("x-greplica-capabilities"), /graph-selectors-v1/);
assert.equal(calls.at(-1).headers.get("x-greplica-client-version"), "0.2.1");
const contextResult = await client.contextGraph("auth", { base: "main", working_users: ["alice", "alice"] });
assert.deepEqual(calls.at(-1).body.view.working_users, ["me", "alice"]);
assert.equal(contextResult.ranked_results[0].code_anchors[0].status, "resolved");
assert.equal(contextResult.ranked_results[1].code_anchors[0].status, "missing_symbol");
const contextMarkdown = renderGraphContextMarkdown(contextResult);
assert.match(contextMarkdown, /version context-version-1/);
assert.match(contextMarkdown, /formerly @alice-old/);
assert.match(contextMarkdown, /proposal context-proposal-1/);
assert.match(contextMarkdown, /session codex-session:context-1/);
assert.match(contextMarkdown, /branch feature/);
assert.match(contextMarkdown, /head repository example\/project/);
assert.match(contextMarkdown, /head ref feature/);
assert.match(contextMarkdown, /clean working tree/);
assert.match(contextMarkdown, /code PR #7/);
assert.match(contextMarkdown, /promotion promotion-1/);
assert.match(contextMarkdown, /quarantine superseded repair/);
assert.match(contextMarkdown, /Origins: \[working; version source-version-bob; @bob; formerly @bob-old/);
assert.match(contextMarkdown, /origin-proposal-bob/);
assert.match(contextMarkdown, /claude-session:origin-bob/);
assert.match(contextMarkdown, /head repository bob\/project/);
assert.match(contextMarkdown, /dirty working tree/);
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
assert.equal(applyBody.context.dirty, false);
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

const legacySelectorClient = new ManagedGraphMemoryClient(installation, {
  repo_root: repoRoot,
  remote_url: installation.remoteUrl,
  repo_name: "project",
  default_branch: "main",
}, {
  apiUrl: "https://legacy-memory.example.test",
  token: "managed-token",
  fetchImpl: async () => jsonResponse(graph, false),
});
await assert.rejects(
  legacySelectorClient.readGraph({ base: "main", working_users: [] }),
  /does not acknowledge graph-selectors-v1/,
);

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
  counts: { ...viewData.counts, components: 1, flows: 1, claims: 1 },
  components: [{
    id: "component.provenance",
    name: "Provenance component",
    folder: "provenance",
    anchors: ["example.ts"],
    flowCount: 1,
    claimCount: 1,
    subcomponentCount: 0,
    provenance: {
      version_id: "component-version",
      scope_kind: "working",
      author_github_login: "component-author",
      memory_commit_id: "component-commit",
    },
  }],
  flows: [{
    id: "flow.provenance",
    name: "Provenance flow",
    folder: "provenance",
    touchedComponentFolders: ["provenance"],
    claimCount: 1,
    provenance: {
      version_id: "flow-version",
      scope_kind: "working",
      author_github_login: "flow-author",
      memory_commit_id: "flow-commit",
    },
  }],
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
      author_github_login_snapshot: "alice-old",
      proposal_id: "proposal-1",
      memory_commit_id: "commit-1",
      session_refs: [{ id: "codex-session:session-1", agent_platform: "codex" }],
      agent_platform: "codex",
      git_head: mergeSha,
      head_repository: "example/project",
      head_ref: "feature",
      branch: "feature",
      dirty: false,
      code_pr_number: 7,
      memory_commit_state: "active",
      memory_pr_id: "memory-pr-1",
      commit_role: "repair",
      promotion_id: "promotion-1",
      origins: [{
        version_id: "origin-version-1",
        scope_kind: "working",
        author_github_login: "carol",
        author_github_login_snapshot: "carol-old",
        proposal_id: "origin-proposal-1",
        memory_commit_id: "origin-commit-1",
        session_refs: [{ id: "origin-session-1", agent_platform: "claude" }],
        head_repository: "carol/project",
        head_ref: "memory",
        branch: "memory",
        dirty: true,
      }],
    },
  }, {
    id: "claim.logical",
    text: "A conflicting personal draft",
    kind: "decision",
    session: "claude-session:session-2",
    source: "session",
    freshness: "active",
    componentIds: ["component.other"],
    flowIds: [],
    createdAt: "2026-07-28T00:01:00.000Z",
    memoryCommitId: "commit-2",
    provenance: {
      version_id: "version-2",
      scope_kind: "working",
      author_github_login: "bob",
      memory_commit_id: "commit-2",
      memory_commit_state: "active",
      commit_role: "direct",
    },
  }],
  claimsTimeline: {
    summary: { total: 1, sessionPct: 100, codePct: 0 },
    events: [],
  },
});
assert.match(html, /data-version-id="version-1"/);
assert.match(html, /data-version-id="version-2"/);
assert.match(html, /data-author="alice,carol"/);
assert.match(html, /provenance-badge[^>]*>repair</);
assert.match(html, /formerly @alice-old/);
assert.match(html, /origin @carol/);
assert.match(html, /origin formerly @carol-old/);
assert.match(html, /origin proposal origin-proposal-1/);
assert.match(html, /head repository example\/project/);
assert.match(html, /head ref feature/);
assert.match(html, /provenance-badge[^>]*>clean</);
assert.match(html, /code PR #7/);
assert.match(html, /data-id="component\.provenance"[^>]*data-author="component-author"/);
assert.match(html, /data-id="flow\.provenance"[^>]*data-author="flow-author"/);
assert.match(html, /id="components-filter-author"/);
assert.match(html, /id="flows-filter-author"/);
assert.match(html, /claimTextByVersion/);
assert.match(html, /componentIdsByClaimVersion/);
assert.match(html, /id="claims-filter-scope"/);
assert.match(html, /id="claims-filter-author"/);
assert.match(html, /id="claims-filter-author-snapshot"/);
assert.match(html, /id="claims-filter-proposal"/);
assert.match(html, /id="claims-filter-memory-commit"/);
assert.match(html, /id="claims-filter-agent"/);
assert.match(html, /id="claims-filter-branch"/);
assert.match(html, /id="claims-filter-head-repository"/);
assert.match(html, /id="claims-filter-head-ref"/);
assert.match(html, /id="claims-filter-dirty"/);
assert.match(html, /id="claims-filter-code-pr"/);
assert.match(html, /id="claims-filter-memory-state"/);
assert.match(html, /id="claims-filter-memory-pr"/);
assert.match(html, /id="claims-filter-commit-role"/);
assert.match(html, /id="claims-filter-promotion"/);
assert.match(html, /provenance\.origins/);

const builtViewData = buildGraphViewData({
  components: [{
    id: "component.built",
    name: "Built component",
    provenance: {
      version_id: "component-version-built",
      scope_kind: "working",
      author_github_login: "component-builder",
    },
  }],
  flows: [{
    id: "flow.built",
    name: "Built flow",
    provenance: {
      version_id: "flow-version-built",
      scope_kind: "working",
      author_github_login: "flow-builder",
    },
  }],
  claims: [{
    id: "claim.provenance",
    kind: "fact",
    text: "Managed provenance survives row construction",
    truth: "source_verified",
    intent: "intended",
    provenance: {
      version_id: "version-built",
      scope_kind: "main",
      memory_commit_state: "promoted",
    },
  }],
  sources: [],
  edges: [],
}, [], []);
assert.equal(builtViewData.claims[0].provenance.version_id, "version-built");
assert.equal(builtViewData.components[0].provenance.version_id, "component-version-built");
assert.equal(builtViewData.flows[0].provenance.version_id, "flow-version-built");

const attestations = [];
const rejections = [];
const rejectedMemoryPrIds = new Set();
let candidateCalls = 0;
let forcePushMode = false;
let codeMergeFailureMode = false;
let codeMergeFailureSha = unrelatedCodeMergeSha;
let codeMergeFailureMemoryPrId = "memory-pr-code-merge-away";
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
  assert.match(incoming.headers["x-greplica-capabilities"], /oidc-reconciliation-v1/);
  assert.equal(incoming.headers["x-greplica-client-version"], "0.2.1");
  if (url.pathname.endsWith("/memory/reconcile/candidate")) {
    candidateCalls += 1;
    assert.equal(url.searchParams.get("merge_sha"), mergeSha);
    const excluded = url.searchParams.getAll("exclude_memory_pr");
    if (codeMergeFailureMode) {
      assert.deepEqual(excluded, []);
      if (rejectedMemoryPrIds.has(codeMergeFailureMemoryPrId)) {
        send(404, { message: "No Memory PR is ready for this merged checkout." });
        return;
      }
      send(200, {
        memory_pr_id: codeMergeFailureMemoryPrId,
        merge_sha: mergeSha,
        code_merge_sha: codeMergeFailureSha,
        memory_commit_ids: ["commit-code-merge-proof"],
        commits: [{
          memory_commit_id: "commit-code-merge-proof",
          git_head: baseSha,
          head_repository: "example/project",
          proof_mode: "default_ancestry",
        }],
        claim_versions: [],
      });
      return;
    }
    if (forcePushMode) {
      assert.deepEqual(excluded, []);
      if (rejectedMemoryPrIds.has("memory-pr-force-push")) {
        send(404, { message: "No Memory PR is ready for this merged checkout." });
        return;
      }
      send(200, {
        memory_pr_id: "memory-pr-force-push",
        merge_sha: mergeSha,
        memory_commit_ids: ["commit-force-pushed-away"],
        commits: [{
          memory_commit_id: "commit-force-pushed-away",
          git_head: featureSha,
          head_repository: "example/project",
          proof_mode: "pr_head",
          code_pr_number: 7,
          verified_head_sha: mergeSha,
          verified_base_sha: baseSha,
        }],
        claim_versions: [],
      });
      return;
    }
    if (excluded.length === 2) {
      assert.deepEqual(excluded, ["memory-pr-1", "memory-pr-2"]);
      if (!rejectedMemoryPrIds.has("memory-pr-3")) {
        send(200, {
          memory_pr_id: "memory-pr-3",
          merge_sha: mergeSha,
          memory_commit_ids: ["commit-3"],
          commits: [{
            memory_commit_id: "commit-3",
            git_head: featureSha,
            head_repository: "example/project",
            proof_mode: "default_ancestry",
          }],
          claim_versions: [],
        });
        return;
      }
      if (!rejectedMemoryPrIds.has("memory-pr-4")) {
        send(200, {
          memory_pr_id: "memory-pr-4",
          merge_sha: mergeSha,
          memory_commit_ids: ["commit-common-base"],
          commits: [{
            memory_commit_id: "commit-common-base",
            git_head: baseSha,
            head_repository: "example/project",
            proof_mode: "pr_head",
            code_pr_number: 7,
            verified_head_sha: featureSha,
            verified_base_sha: baseSha,
          }],
          claim_versions: [],
        });
        return;
      }
      send(404, { message: "No Memory PR is ready for this merged checkout." });
      return;
    }
    if (excluded.length === 1) {
      assert.deepEqual(excluded, ["memory-pr-1"]);
      send(200, {
        memory_pr_id: "memory-pr-2",
        merge_sha: mergeSha,
        memory_commit_ids: ["commit-2"],
        commits: [{
          memory_commit_id: "commit-2",
          git_head: baseSha,
          head_repository: "example/project",
          proof_mode: "default_ancestry",
        }],
        claim_versions: [],
      });
      return;
    }
    send(200, {
      memory_pr_id: "memory-pr-1",
      merge_sha: mergeSha,
      code_merge_sha: codeMergeSha,
      memory_commit_ids: ["commit-1", "commit-dependency-1"],
      commits: [{
        memory_commit_id: "commit-1",
        git_head: featureSha,
        head_repository: "example/project",
        proof_mode: "pr_head",
        code_pr_number: 7,
        verified_head_sha: featureSha,
        verified_base_sha: baseSha,
      }, {
        memory_commit_id: "commit-dependency-1",
        git_head: featureSha,
        head_repository: "example/project",
        proof_mode: "pr_head",
        code_pr_number: 7,
        verified_head_sha: featureSha,
        verified_base_sha: baseSha,
      }],
      claim_versions: [{
        version_id: "version-1",
        baseline_fingerprints: versionOneBaseline,
        claim: {
          id: "claim.logical",
          kind: "fact",
          text: "Version-keyed audit",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [versionOneAnchor],
        },
      }],
      component_versions: [{
        version_id: "version-component-1",
        baseline_fingerprints: componentBaseline,
        component: {
          id: "component.logical",
          name: "Version-keyed component audit",
          code_anchor: "example.ts",
        },
      }, {
        version_id: "version-component-missing",
        baseline_fingerprints: {},
        component: {
          id: "component.missing",
          name: "Missing component anchor",
          code_anchor: "missing-component.ts",
        },
      }],
    });
    return;
  }
  if (url.pathname.endsWith("/memory/reconcile/attest")) {
    attestations.push(body);
    send(200, {
      accepted: true,
      memory_pr_id: body.memory_pr_id,
      job_id: `job-${attestations.length}`,
      state: "queued",
    });
    return;
  }
  if (url.pathname.endsWith("/memory/reconcile/reject")) {
    rejections.push(body);
    rejectedMemoryPrIds.add(body.memory_pr_id);
    send(200, {
      accepted: true,
      memory_pr_id: body.memory_pr_id,
      removed_commit_ids: body.rejected_memory_commit_ids,
      remaining_commit_ids: body.reason === "code_merge_not_ancestor"
        ? body.memory_commit_ids
        : [],
    });
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
    GITHUB_REF: `refs/heads/${defaultBranch}`,
    GITHUB_RUN_ID: "123",
  });
  assert.match(result.stdout, /"accepted": true/);
  assert.match(result.stdout, /"reconciliation_count": 2/);
  assert.match(result.stdout, /"audited_component_versions": 2/);
  assert.match(result.stdout, /"skipped_count": 2/);
  assert.match(result.stdout, /"reason": "git_head_not_in_pr_delta"/);
  assert.equal(candidateCalls, 5);
  assert.equal(rejections.length, 2);
  assert.equal(rejections[0].memory_pr_id, "memory-pr-3");
  assert.equal(rejections[0].reason, "git_head_not_ancestor");
  assert.deepEqual(rejections[0].rejected_memory_commit_ids, ["commit-3"]);
  assert.equal(rejections[1].memory_pr_id, "memory-pr-4");
  assert.equal(rejections[1].reason, "git_head_not_in_pr_delta");
  assert.deepEqual(rejections[1].rejected_memory_commit_ids, ["commit-common-base"]);
  assert.ok(rejections.every((rejection) => rejection.observed_default_head_sha === mergeSha));
  assert.equal(attestations[0].audit_key, "version_id");
  assert.deepEqual(attestations[0].memory_commit_ids, ["commit-1", "commit-dependency-1"]);
  assert.deepEqual(attestations[0].ancestry, [{
    memory_commit_id: "commit-1",
    git_head: featureSha,
    proof_mode: "pr_head",
    verified_head_sha: featureSha,
    verified_base_sha: baseSha,
    is_ancestor: true,
  }, {
    memory_commit_id: "commit-dependency-1",
    git_head: featureSha,
    proof_mode: "pr_head",
    verified_head_sha: featureSha,
    verified_base_sha: baseSha,
    is_ancestor: true,
  }]);
  assert.equal(attestations[0].observed_default_head_sha, mergeSha);
  assert.equal(attestations[0].code_merge_sha, codeMergeSha);
  assert.equal(attestations[0].code_merge_is_ancestor, true,
    "the Action must attest that the code PR merge is an ancestor of the later exact checkout");
  assert.equal(attestations[0].anchor_audit.result.drifted[0].claim_id, "version-1");
  assert.ok(attestations[0].anchor_audit.result.drifted.some((issue) =>
    issue.claim_id === "version-component-1"
  ), "component anchors must be audited under immutable component version IDs");
  assert.notEqual(
    attestations[0].anchor_audit.fingerprints["version-1"]["example.ts#example"],
    versionOneBaseline["example.ts#example"],
  );
  assert.notEqual(
    attestations[0].anchor_audit.fingerprints["version-component-1"]["example.ts"],
    componentBaseline["example.ts"],
  );
  assert.ok(attestations[0].anchor_audit.result.missing_files.some((issue) =>
    issue.claim_id === "version-component-missing" &&
    issue.anchor.file === "missing-component.ts"
  ), "missing component anchors must fail under immutable component version IDs");
  assert.deepEqual(attestations[0].anchor_audit.fingerprints["version-component-missing"], {});
  assert.equal(attestations[0].repository, "example/project");
  assert.deepEqual(attestations[1].ancestry, [{
    memory_commit_id: "commit-2",
    git_head: baseSha,
    proof_mode: "default_ancestry",
    is_ancestor: true,
  }]);
  assert.equal(Object.hasOwn(attestations[1], "code_merge_sha"), false,
    "legacy candidates without code-merge proof must remain compatible");
  assert.equal(Object.hasOwn(attestations[1], "code_merge_is_ancestor"), false,
    "legacy attestations must not send unsupported proof fields");
  assert.equal(
    exec("git", ["-C", repoRoot, "rev-parse", "FETCH_HEAD"]).trim(),
    featureSha,
    "PR-head proof must fetch the base repository pull ref even when the object already exists",
  );

  exec("git", [
    "-C",
    repoRoot,
    "push",
    "--quiet",
    "--force",
    "origin",
    `${mergeSha}:refs/pull/7/head`,
  ]);
  const attestationsBeforeMismatch = attestations.length;
  await assert.rejects(
    run(process.execPath, [
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
      GITHUB_REF: `refs/heads/${defaultBranch}`,
      GITHUB_RUN_ID: "124",
    }),
    /does not match verified head/,
  );
  assert.equal(
    attestations.length,
    attestationsBeforeMismatch,
    "a mismatched base-repository PR ref must never be attested",
  );

  forcePushMode = true;
  const candidateCallsBeforeDurableRejection = candidateCalls;
  const rejectionsBeforeDurableRejection = rejections.length;
  const forcePushResult = await run(process.execPath, [
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
    GITHUB_REF: `refs/heads/${defaultBranch}`,
    GITHUB_RUN_ID: "125",
  });
  assert.match(forcePushResult.stdout, /"reconciliation_count": 0/);
  assert.match(forcePushResult.stdout, /"skipped_count": 1/);
  assert.match(forcePushResult.stdout, /"memory_pr_id": "memory-pr-force-push"/);
  assert.equal(candidateCalls, candidateCallsBeforeDurableRejection + 2,
    "the Action must refetch after the managed service removes a rejected selection");
  assert.equal(rejections.length, rejectionsBeforeDurableRejection + 1);
  assert.deepEqual(rejections.at(-1).rejected_memory_commit_ids, ["commit-force-pushed-away"]);
  assert.equal(rejections.at(-1).ancestry[0].verified_head_sha, mergeSha);
  assert.equal(rejections.at(-1).ancestry[0].verified_base_sha, baseSha);
  assert.equal(rejections.at(-1).ancestry[0].is_ancestor, false);

  forcePushMode = false;
  codeMergeFailureMode = true;
  const candidateCallsBeforeCodeMergeRejection = candidateCalls;
  const rejectionsBeforeCodeMergeRejection = rejections.length;
  const codeMergeResult = await run(process.execPath, [
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
    GITHUB_REF: `refs/heads/${defaultBranch}`,
    GITHUB_RUN_ID: "126",
  });
  assert.match(codeMergeResult.stdout, /"reconciliation_count": 0/);
  assert.match(codeMergeResult.stdout, /"skipped_count": 1/);
  assert.match(codeMergeResult.stdout, /"reason": "code_merge_not_ancestor"/);
  assert.match(codeMergeResult.stdout, /"memory_commit_ids": \[\]/);
  assert.equal(candidateCalls, candidateCallsBeforeCodeMergeRejection + 2,
    "a candidate-level code-merge rejection must be persisted before candidate refetch");
  assert.equal(rejections.length, rejectionsBeforeCodeMergeRejection + 1);
  const codeMergeRejection = rejections.at(-1);
  assert.equal(codeMergeRejection.memory_pr_id, "memory-pr-code-merge-away");
  assert.equal(codeMergeRejection.code_merge_sha, unrelatedCodeMergeSha);
  assert.equal(codeMergeRejection.code_merge_is_ancestor, false);
  assert.equal(codeMergeRejection.reason, "code_merge_not_ancestor");
  assert.deepEqual(codeMergeRejection.rejected_memory_commit_ids, [],
    "a code-merge failure must not be mislabeled as a per-memory-commit failure");
  assert.deepEqual(codeMergeRejection.memory_commit_ids, ["commit-code-merge-proof"]);
  assert.equal(codeMergeRejection.ancestry[0].is_ancestor, true,
    "independent memory-commit ancestry may pass while the code merge proof fails");

  codeMergeFailureSha = "f".repeat(40);
  codeMergeFailureMemoryPrId = "memory-pr-code-merge-missing";
  const missingCodeMergeResult = await run(process.execPath, [
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
    GITHUB_REF: `refs/heads/${defaultBranch}`,
    GITHUB_RUN_ID: "127",
  });
  assert.match(missingCodeMergeResult.stdout, /"reason": "code_merge_not_ancestor"/);
  assert.equal(rejections.at(-1).code_merge_sha, "f".repeat(40));
  assert.equal(rejections.at(-1).code_merge_is_ancestor, false,
    "an unavailable code merge object must never be accepted as trusted ancestry");

  codeMergeFailureMode = false;
  const advancedDefaultSha = exec(
    "git",
    ["-C", repoRoot, "commit-tree", `${mergeSha}^{tree}`, "-p", mergeSha, "-m", "advance default"],
  ).trim();
  exec("git", [
    "-C",
    repoRoot,
    "push",
    "--quiet",
    "origin",
    `${advancedDefaultSha}:refs/heads/${defaultBranch}`,
  ]);
  const candidateCallsBeforeReplay = candidateCalls;
  await assert.rejects(
    run(process.execPath, [
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
      GITHUB_REF: `refs/heads/${defaultBranch}`,
      GITHUB_RUN_ID: "128",
    }),
    /historical workflow reruns cannot reconcile memory/,
  );
  assert.equal(candidateCalls, candidateCallsBeforeReplay,
    "a historical workflow rerun must fail before requesting a reconciliation candidate");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Managed collaboration checks passed.");

function exec(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

function jsonResponse(value, capabilities = true) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(capabilities
        ? { "x-greplica-capabilities": "personal-working-v1,graph-selectors-v1,memory-pr-v1" }
        : {}),
    },
  });
}

function gitIsAncestor(repoRoot, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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
