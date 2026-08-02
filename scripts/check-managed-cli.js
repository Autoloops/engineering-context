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
const inviteLinkId = "33333333-3333-4333-8333-333333333333";
const inviteToken = "a".repeat(43);
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
let memoryPrContextBody;
const graphReadUrls = [];
const graphViewUrls = [];
const graphContextBodies = [];
const proposalRecord = {
  id: "proposal-renamed-author",
  memory_commit: {
    id: "memory-commit-renamed-author",
    proposal_id: "proposal-renamed-author",
    scope_id: "working-user-1",
    scope_name: "working/contributor-1",
    state: "active",
    author: {
      id: "10000000-0000-4000-8000-000000000000",
      github_user_id: "1",
      github_login: "contributor-current",
      created_at: now,
    },
    author_github_login_snapshot: "contributor-old",
    session_refs: [{
      id: "codex-session:proposal-1",
      agent_platform: "codex",
    }],
    agent_platform: "codex",
    git: {
      git_head: "b".repeat(40),
      head_repository: "example/project",
      head_ref: "feature/memory",
      branch: "feature/memory",
      dirty: false,
    },
    created_at: now,
  },
  proposal: { title: "Rename-safe provenance" },
  created_at: now,
};
const automatedRepairProposalRecord = {
  id: "proposal-automated-repair",
  memory_commit: {
    id: "memory-commit-automated-repair",
    proposal_id: "proposal-automated-repair",
    scope_id: "repair-scope-1",
    scope_name: "repair/memory-pr-1",
    state: "promoted",
    session_refs: [{
      id: "managed-repair:job-1:1",
      agent_platform: "managed-repair",
    }],
    agent_platform: "managed-repair",
    automation_identity: {
      kind: "managed_repair_agent",
      reconciliation_job_id: "job-1",
      repair_attempt: 1,
    },
    repair_sources: [{
      memory_commit_id: "source-commit-alice",
      contributor_user_id: "30000000-0000-4000-8000-000000000000",
      contributor_github_login: "alice",
      proposal_id: "source-proposal-alice",
    }, {
      memory_commit_id: "source-commit-bob",
      contributor_user_id: "40000000-0000-4000-8000-000000000000",
      contributor_github_login: "bob",
      proposal_id: "source-proposal-bob",
    }],
    created_at: now,
    promoted_at: now,
  },
  proposal: { title: "Automated merged-code repair" },
  created_at: now,
};

const server = createServer(async (request, response) => {
  requestCount += 1;
  assert.equal(request.headers["x-greplica-client-version"], "0.2.1");
  assert.match(request.headers["x-greplica-capabilities"] ?? "", /personal-working-v1/);
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
  if (request.method === "POST" && request.url === "/v1/invite-links/claim") {
    assert.equal(body.token, inviteToken);
    send(200, managedRepository);
    return;
  }
  if (request.method === "POST" && request.url === `/v1/repos/${managedRepoId}/invite-links`) {
    send(200, {
      link: {
        id: inviteLinkId,
        repo_id: managedRepoId,
        status: "active",
        created_by: "10000000-0000-4000-8000-000000000000",
        created_at: now,
        claim_count: 0,
      },
      claim_url: `http://127.0.0.1:${server.address().port}/join/${inviteToken}`,
    });
    return;
  }
  if (request.method === "GET" && request.url === `/v1/repos/${managedRepoId}/invite-links`) {
    send(200, [{
      id: inviteLinkId,
      repo_id: managedRepoId,
      status: "active",
      created_by: "10000000-0000-4000-8000-000000000000",
      created_at: now,
      claim_count: 1,
    }]);
    return;
  }
  if (request.method === "POST" && request.url === `/v1/repos/${managedRepoId}/invite-links/${inviteLinkId}/revoke`) {
    send(200, {
      id: inviteLinkId,
      repo_id: managedRepoId,
      status: "revoked",
      created_by: "10000000-0000-4000-8000-000000000000",
      created_at: now,
      revoked_at: now,
      claim_count: 1,
    });
    return;
  }
  if (
    request.method === "GET" &&
    new URL(request.url, "http://127.0.0.1").pathname === `/v1/repos/${managedRepoId}/graph`
  ) {
    graphReadUrls.push(request.url);
    send(200, { components: [], flows: [], claims: [], sources: [], edges: [] }, {
      "x-greplica-repo-role": managedRepository.effective_role,
      "x-greplica-access-status": "active",
      "x-greplica-capabilities": "personal-working-v1,graph-selectors-v1,memory-pr-v1",
    });
    return;
  }
  if (request.method === "POST" && request.url === `/v1/repos/${managedRepoId}/graph/context`) {
    memoryPrContextBody = body;
    graphContextBodies.push(body);
    send(200, {
      query: body.query,
      search_config_version: "test",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      claims: [],
      components: [],
      flows: [],
      ranked_results: [],
      sources: [],
    }, { "x-greplica-capabilities": "personal-working-v1,graph-selectors-v1,memory-pr-v1" });
    return;
  }
  if (
    request.method === "GET" &&
    new URL(request.url, "http://127.0.0.1").pathname === `/v1/repos/${managedRepoId}/graph/view-data`
  ) {
    graphViewUrls.push(request.url);
    send(200, {}, {
      "x-greplica-capabilities": "personal-working-v1,graph-selectors-v1,memory-pr-v1",
    });
    return;
  }
  if (request.method === "GET" && request.url === `/v1/repos/${managedRepoId}/memory/status`) {
    send(200, {
      queued: 0,
      running: 0,
      failed: 0,
      action_verified: true,
      action_verified_at: now,
      action_workflow_ref: `Autoloops/greplica/.github/workflows/reconcile.yml@${"a".repeat(40)}`,
      action_workflow_sha: "a".repeat(40),
      repair_service: "degraded",
      repair_service_detail: "repair proxy is not configured",
      repair_attempts: 0,
      repaired_commits: 0,
      promoted_commits: 0,
      quarantined_commits: 0,
      cleared_working_commits: 0,
      remaining_active_working_commits: 0,
    });
    return;
  }
  if (request.method === "GET" && request.url === `/v1/repos/${managedRepoId}/proposals`) {
    send(200, [proposalRecord, automatedRepairProposalRecord]);
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/repos/${managedRepoId}/proposals/proposal-renamed-author`
  ) {
    send(200, proposalRecord);
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/repos/${managedRepoId}/proposals/proposal-automated-repair`
  ) {
    send(200, automatedRepairProposalRecord);
    return;
  }
  if (request.method === "GET" && request.url === `/v1/repos/${managedRepoId}/memory-prs`) {
    send(200, [{
      id: "direct-default-memory-pr",
      state: "reconciling",
      direct_commit_ids: ["direct-default-commit"],
      dependency_commit_ids: [],
      repair_commit_ids: [],
      contributor_logins: ["contributor-1"],
      created_at: now,
      updated_at: now,
    }]);
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/repos/${managedRepoId}/memory-prs/cleanup-memory-pr`
  ) {
    send(200, {
      id: "cleanup-memory-pr",
      state: "merged",
      direct_commit_ids: ["cleared-commit"],
      dependency_commit_ids: [],
      repair_commit_ids: [],
      contributor_logins: ["contributor-current"],
      promotion: {
        id: "promotion-cleanup",
        status: "merged",
        new_main_head: "main-head",
        cleared_commit_ids: ["cleared-commit"],
        already_canonical_commit_ids: [],
        quarantined_commit_ids: [],
        cleared_by_user: {
          "10000000-0000-4000-8000-000000000000": {
            user_id: "10000000-0000-4000-8000-000000000000",
            github_login: "contributor-current",
            github_login_snapshots: ["contributor-old", "contributor-current"],
            cleared_objects: 3,
            remaining_active_commits: 2,
            remaining_active_objects: 4,
          },
        },
        promoted_at: now,
      },
      created_at: now,
      updated_at: now,
    });
    return;
  }
  const retryMatch = request.url.match(
    new RegExp(`^/v1/repos/${managedRepoId}/memory-prs/(queued|running|neutral)-memory-pr/retry$`),
  );
  if (request.method === "POST" && retryMatch !== null) {
    const responseKind = retryMatch[1];
    send(200, {
      id: `${responseKind}-memory-pr`,
      state: responseKind === "neutral" ? "open" : "reconciling",
      direct_commit_ids: [`${responseKind}-commit`],
      dependency_commit_ids: [],
      repair_commit_ids: [],
      contributor_logins: ["contributor-current"],
      ...(responseKind === "neutral" ? {} : { latest_job_state: responseKind }),
      created_at: now,
      updated_at: now,
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
  const agentRepo = join(temporary, "agent-repo");
  const upgradeRepo = join(temporary, "upgrade-repo");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(managedRepo, { recursive: true });
  mkdirSync(localRepo, { recursive: true });
  mkdirSync(agentRepo, { recursive: true });
  mkdirSync(upgradeRepo, { recursive: true });
  writeFileSync(join(fakeBin, "open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "open"), 0o755);
  await run("git", ["init", "--quiet"], managedRepo);
  await run("git", ["init", "--quiet"], localRepo);
  await run("git", ["init", "--quiet"], agentRepo);
  await run("git", ["init", "--quiet"], upgradeRepo);

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
  const dbPath = join(greplicaHome, "graph.db");
  let db;
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).apiUrl, apiUrl);

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

  const createdLink = await run(process.execPath, [cliPath, "repo", "invite-link", "create"], managedRepo, env);
  assert.match(createdLink.stdout, /npm install --global greplica@latest/);
  assert.match(createdLink.stdout, new RegExp(`greplica install --invite-link ${apiUrl}/join/${inviteToken} --platform codex`));
  const listedLinks = await run(process.execPath, [cliPath, "repo", "invite-link", "list"], managedRepo, env);
  assert.match(listedLinks.stdout, new RegExp(`${inviteLinkId}\\s+active\\s+1`));
  assert.equal(listedLinks.stdout.includes(inviteToken), false, "list output must not expose the invite token");
  const revokedLink = await run(process.execPath, [
    cliPath, "repo", "invite-link", "revoke", "--link", inviteLinkId,
  ], managedRepo, env);
  assert.match(revokedLink.stdout, /is revoked/);

  const agentInstall = await run(process.execPath, [
    cliPath,
    "install",
    "--invite-link",
    `${apiUrl}/join/${inviteToken}`,
    "--platform",
    "codex",
  ], agentRepo, env);
  assert.match(agentInstall.stdout, /Mode: managed/);
  db = new Database(dbPath);
  assert.equal(db.prepare("SELECT active_mode FROM repos WHERE repo_name = 'agent-repo'").get().active_mode, "managed");
  db.close();

  db = new Database(dbPath);
  let managedRow = db.prepare("SELECT * FROM repos WHERE managed_repo_id = ?").get(managedRepoId);
  const managedLocalId = managedRow.id;
  assert.equal(managedRow.active_mode, "managed");
  assert.equal(managedRow.managed_role, "reader");
  assert.equal(managedRow.auto_memory_updates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM graph_scopes WHERE repo_id = ?").get(managedRow.id).count, 0);
  db.close();
  const managedGraph = await run(process.execPath, [cliPath, "graph", "read"], managedRepo, env);
  assert.match(managedGraph.stdout, /Current graph view: main \+ working/);
  const memoryPrContext = await run(process.execPath, [
    cliPath, "memory", "pr", "context", "memory-pr-1", "authentication", "--json",
  ], managedRepo, env);
  assert.match(memoryPrContext.stdout, /"query": "authentication"/);
  assert.deepEqual(memoryPrContextBody.view, {
    base: "main",
    working_users: [],
    memory_pr_id: "memory-pr-1",
  }, "Memory PR context must not include the caller's unrelated personal working scope");
  const memoryStatus = await run(process.execPath, [cliPath, "memory", "status"], managedRepo, env);
  assert.match(memoryStatus.stdout, /Action ready: yes/);
  assert.match(memoryStatus.stdout, new RegExp(`Action verified: ${now}`));
  assert.match(memoryStatus.stdout, /Action workflow ref: Autoloops\/greplica\/\.github\/workflows\/reconcile\.yml@/);
  assert.match(memoryStatus.stdout, new RegExp(`Action workflow SHA: ${"a".repeat(40)}`));
  assert.match(memoryStatus.stdout, /Repair service: degraded \(repair proxy is not configured\)/);
  const proposalList = await run(
    process.execPath,
    [cliPath, "proposal", "list"],
    managedRepo,
    env,
  );
  assert.match(proposalList.stdout, /contributor-current \(formerly contributor-old\)/,
    "proposal summaries must preserve both current and historical GitHub logins");
  assert.match(proposalList.stdout, /head:b{40}/,
    "human proposal list output must expose the immutable Git head");
  assert.match(proposalList.stdout, /agent:codex/,
    "human proposal list output must expose the creating agent platform");
  assert.match(proposalList.stdout, /managed_repair_agent \[sources: alice,bob\]/,
    "automated repair summaries must identify automation and every source contributor without a fake human author");
  const proposalShow = await run(
    process.execPath,
    [cliPath, "proposal", "show", "proposal-renamed-author"],
    managedRepo,
    env,
  );
  assert.match(proposalShow.stdout, /head:b{40}/,
    "human proposal show output must expose the immutable Git head");
  assert.match(proposalShow.stdout, /agent:codex/,
    "human proposal show output must expose the creating agent platform");
  const automatedProposalShow = await run(
    process.execPath,
    [cliPath, "proposal", "show", "proposal-automated-repair"],
    managedRepo,
    env,
  );
  assert.match(automatedProposalShow.stdout, /managed_repair_agent \[sources: alice,bob\]/,
    "proposal show must remain usable when an automated repair has no human author");

  const selectedContext = await run(process.execPath, [
    cliPath,
    "graph",
    "context",
    "authentication",
    "--with-working",
    "alice",
    "--with-working=bob",
    "--with-working",
    "ALICE",
    "--memory-pr",
    "memory-pr-selector",
    "--include-quarantined",
    "--json",
  ], managedRepo, env);
  assert.match(selectedContext.stdout, /"query": "authentication"/);
  assert.deepEqual(graphContextBodies.at(-1).view, {
    base: "main",
    working_users: ["alice", "bob"],
    memory_pr_id: "memory-pr-selector",
    include_quarantined: true,
  }, "a reader without personal working sends only deduplicated explicit contributor overlays");

  await run(process.execPath, [
    cliPath,
    "graph",
    "view",
    "--with-working",
    "alice",
    "--with-working=alice",
    "--with-working",
    "bob",
    "--with-working",
    "ALICE",
    "--memory-pr=memory-pr-selector",
    "--include-quarantined",
    "--json",
    "--no-open",
  ], managedRepo, env);
  const selectedViewUrl = new URL(graphViewUrls.at(-1), "http://127.0.0.1");
  assert.deepEqual(selectedViewUrl.searchParams.getAll("working_user"), ["alice", "bob"]);
  assert.equal(selectedViewUrl.searchParams.get("memory_pr_id"), "memory-pr-selector");
  assert.equal(selectedViewUrl.searchParams.get("include_quarantined"), "true");
  assert.equal(selectedViewUrl.searchParams.get("base"), "main");

  await run(process.execPath, [
    cliPath, "graph", "context", "canonical only", "--main-only", "--json",
  ], managedRepo, env);
  assert.deepEqual(graphContextBodies.at(-1).view, {
    base: "main",
    working_users: [],
  });
  await run(process.execPath, [
    cliPath,
    "graph",
    "context",
    "canonical quarantine",
    "--main-only",
    "--include-quarantined",
    "--json",
  ], managedRepo, env);
  assert.deepEqual(graphContextBodies.at(-1).view, {
    base: "main",
    working_users: [],
    include_quarantined: true,
  }, "main-only must suppress personal working without suppressing an explicit quarantine overlay");
  await run(process.execPath, [
    cliPath,
    "graph",
    "view",
    "--main-only",
    "--memory-pr",
    "memory-pr-selector",
    "--json",
    "--no-open",
  ], managedRepo, env);
  const mainOnlyViewUrl = new URL(graphViewUrls.at(-1), "http://127.0.0.1");
  assert.equal(mainOnlyViewUrl.searchParams.get("main_only"), "true");
  assert.equal(mainOnlyViewUrl.searchParams.get("memory_pr_id"), "memory-pr-selector");
  assert.deepEqual(mainOnlyViewUrl.searchParams.getAll("working_user"), []);
  await run(process.execPath, [
    cliPath, "graph", "read", "--main-only", "--json",
  ], managedRepo, env);
  const mainOnlyReadUrl = new URL(graphReadUrls.at(-1), "http://127.0.0.1");
  assert.equal(mainOnlyReadUrl.searchParams.get("main_only"), "true");

  const requestsBeforeInvalidSelectors = requestCount;
  for (const incompatibleArgs of [
    [cliPath, "graph", "context", "query", "--main-only", "--with-working", "alice"],
    [cliPath, "graph", "view", "--memory-pr", "one", "--memory-pr=two", "--json"],
  ]) {
    const incompatible = await runFailure(process.execPath, incompatibleArgs, managedRepo, env);
    assert.match(
      incompatible.stderr,
      /--main-only cannot be combined|Specify --memory-pr only once/,
      "incompatible graph selectors must fail before a managed request",
    );
  }
  assert.equal(requestCount, requestsBeforeInvalidSelectors,
    "invalid selector combinations must be rejected before network access");
  const directDefaultMemoryPr = await run(
    process.execPath,
    [cliPath, "memory", "pr", "list"],
    managedRepo,
    env,
  );
  assert.match(directDefaultMemoryPr.stdout, /direct-default-memory-pr\s+reconciling\s+direct-default/);
  const cleanupMemoryPr = await run(
    process.execPath,
    [cliPath, "memory", "pr", "show", "cleanup-memory-pr"],
    managedRepo,
    env,
  );
  assert.match(
    cleanupMemoryPr.stdout,
    /contributor-current \(formerly contributor-old\) \[10000000-0000-4000-8000-000000000000\]: cleared 3 objects; 2 active working commits remain; 4 active working objects remain/,
    "cleanup output must use the friendly current login while retaining stable user identity and rename history",
  );
  const queuedRetry = await run(
    process.execPath,
    [cliPath, "memory", "pr", "retry", "queued-memory-pr"],
    managedRepo,
    env,
  );
  assert.match(queuedRetry.stdout, /^Memory PR queued-memory-pr is queued for reconciliation\./);
  assert.doesNotMatch(queuedRetry.stdout, /Queued Memory PR/,
    "retry output must not claim the client itself queued an already-queued job");
  const runningRetry = await run(
    process.execPath,
    [cliPath, "memory", "pr", "retry", "running-memory-pr"],
    managedRepo,
    env,
  );
  assert.match(runningRetry.stdout, /^Memory PR running-memory-pr reconciliation is already running\./);
  assert.doesNotMatch(runningRetry.stdout, /queued for reconciliation/);
  const neutralRetry = await run(
    process.execPath,
    [cliPath, "memory", "pr", "retry", "neutral-memory-pr"],
    managedRepo,
    env,
  );
  assert.match(
    neutralRetry.stdout,
    /^Memory PR neutral-memory-pr reconciliation state is open\./,
  );
  assert.doesNotMatch(neutralRetry.stdout, /queued for reconciliation/);
  const queuedRetryJson = await run(
    process.execPath,
    [cliPath, "memory", "pr", "retry", "queued-memory-pr", "--json"],
    managedRepo,
    env,
  );
  const queuedRetryRecord = JSON.parse(queuedRetryJson.stdout);
  assert.equal(queuedRetryRecord.id, "queued-memory-pr");
  assert.equal(queuedRetryRecord.latest_job_state, "queued");
  assert.equal(queuedRetryRecord.state, "reconciling");
  assert.doesNotMatch(queuedRetryJson.stdout, /queued for reconciliation/,
    "JSON mode must remain a plain ManagedMemoryPr response without status prose");

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
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repos WHERE active_mode = 'managed'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM graph_scopes").get().count, 2);
  db.close();
  const requestsBeforeLocalRead = requestCount;
  const localGraph = await run(process.execPath, [cliPath, "graph", "read"], localRepo, env);
  assert.match(localGraph.stdout, /Current graph view: main \+ working/);
  assert.equal(requestCount, requestsBeforeLocalRead, "local graph commands must not call the managed API");

  await run(process.execPath, [cliPath, "install", "--mode", "local", "--platform", "codex"], upgradeRepo, env);
  const upgradedByInvite = await run(process.execPath, [
    cliPath,
    "install",
    "--invite-link",
    `${apiUrl}/join/${inviteToken}`,
    "--platform",
    "codex",
  ], upgradeRepo, env);
  assert.match(upgradedByInvite.stdout, /Mode: managed/);
  db = new Database(dbPath);
  assert.equal(db.prepare("SELECT active_mode FROM repos WHERE repo_name = 'upgrade-repo'").get().active_mode, "managed");
  db.close();

  const insecureInvite = await runFailure(process.execPath, [
    cliPath, "install", "--invite-link", `http://memory.example.com/join/${inviteToken}`, "--platform", "codex",
  ], agentRepo, env);
  assert.match(insecureInvite.stderr, /must use HTTPS/);

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

  const environmentTokenSwitch = await runFailure(process.execPath, [
    cliPath,
    "install",
    "--invite-link",
    `http://127.0.0.1:1/join/${inviteToken}`,
    "--platform",
    "codex",
  ], agentRepo, { ...env, GREPLICA_MANAGED_TOKEN: "environment-token" });
  assert.match(environmentTokenSwitch.stderr, /Cannot switch invite-link origins/);
  assert.equal(existsSync(credentialsPath), true, "a rejected environment-token switch must not alter credentials");

  const crossOrigin = await runFailure(process.execPath, [
    cliPath,
    "install",
    "--invite-link",
    `http://127.0.0.1:1/join/${inviteToken}`,
    "--platform",
    "codex",
  ], agentRepo, env);
  assert.match(crossOrigin.stderr, /fetch failed|connect/i);
  assert.equal(existsSync(credentialsPath), false, "switching invite origins must discard credentials before network access");

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
    endChildInput(child, input, reject);
  });
}

function runFailure(command, args, cwd, env = process.env, input = "") {
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
      if (code !== 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} ${args.join(" ")} unexpectedly succeeded`));
    });
    endChildInput(child, input, reject);
  });
}

function endChildInput(child, input, reject) {
  child.stdin.on("error", (error) => {
    if (error?.code !== "EPIPE") reject(error);
  });
  child.stdin.end(input);
}
