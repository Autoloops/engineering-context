import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const cli = new URL("dist/apps/cli/main.js", root);
const { ManagedKnowledgeGraphClient } = await import(new URL("dist/libs/knowledge-graph/managed-client.js", root));
const { createKnowledgeGraphProvider } = await import(new URL("dist/libs/knowledge-graph/provider-factory.js", root));

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({
    url,
    method: init?.method,
    headers: init?.headers,
    body: JSON.parse(String(init?.body ?? "{}")),
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => responseFor(url),
    text: async () => "",
  };
};

const repo = {
  repo_root: "/tmp/repo",
  remote_url: "git@example.com:org/repo.git",
  repo_name: "repo",
  default_branch: "main",
};

const client = new ManagedKnowledgeGraphClient({
  apiUrl: "https://api.example.test/",
  authToken: "secret-token",
  fetchImpl,
});

assert.equal(client.mode, "managed");
assert.equal(createKnowledgeGraphProvider(managedConfig(fetchImpl)).mode, "managed");

await client.initRepo(repo);
await client.requireRepo(repo);
await client.readGraph(repo);
await client.contextGraph(repo, "auth startup");
await client.validateProposal(repo, { title: "test", creates: {} });
await client.applyProposal(repo, { title: "test", creates: {} });
await client.recordHook({
  repo,
  platform: "codex",
  sessionId: "session-1",
  transcriptPath: "/tmp/session.jsonl",
  cwd: "/tmp/repo",
  eventName: "UserPromptSubmit",
});
await client.claimDueMemoryUpdateAttempts();
await client.markMemoryCurrent({ repo, platform: "codex", sessionId: "session-1" });

assert.deepEqual(
  calls.map((call) => call.url),
  [
    "https://api.example.test/v1/repos/init",
    "https://api.example.test/v1/repos/require",
    "https://api.example.test/v1/graph/read",
    "https://api.example.test/v1/graph/context",
    "https://api.example.test/v1/proposals/validate",
    "https://api.example.test/v1/proposals/apply",
    "https://api.example.test/v1/hooks/record",
    "https://api.example.test/v1/hooks/claim-due-memory-updates",
    "https://api.example.test/v1/sessions/mark-memory-current",
  ],
);
assert.ok(calls.every((call) => call.method === "POST"));
assert.ok(calls.every((call) => call.headers.authorization === "Bearer secret-token"));
assert.deepEqual(calls[3].body, { repo, query: "auth startup" });
assert.equal(calls[6].body.eventName, "UserPromptSubmit");
assert.equal(calls[8].body.sessionId, "session-1");

await checkCliManagedModeDoesNotCreateLocalGraphDb();

console.log("Managed client checks passed.");

function managedConfig(fetch) {
  return {
    version: 1,
    mode: "managed",
    embedding: {
      provider: "local",
      model: "all-mpnet-base-v2",
      dimensions: 768,
      batchSize: 16,
    },
    managed: {
      apiUrl: "https://api.example.test",
      authToken: "secret-token",
      fetchImpl: fetch,
    },
    session: {
      stopThreshold: 7,
      timeThresholdMinutes: 40,
      currentGraceMinutes: 5,
      autoMemoryUpdates: true,
    },
  };
}

function responseFor(url) {
  if (url.endsWith("/graph/read")) {
    return { components: [], flows: [], claims: [], sources: [], edges: [] };
  }
  if (url.endsWith("/graph/context")) {
    return {
      query: "auth startup",
      search_config_version: "test",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      claims: [],
      components: [],
      flows: [],
      ranked_results: [],
      sources: [],
    };
  }
  if (url.endsWith("/proposals/validate")) return { valid: true, errors: [] };
  if (url.endsWith("/proposals/apply")) {
    return {
      memory_commit_id: "commit_1",
      scope_id: "scope_1",
      embedding_status: { checked_objects: 0, created: 0, reused: 0 },
      created: { components: 0, flows: 0, claims: 0, sources: 0, edges: 0 },
    };
  }
  if (url.endsWith("/hooks/record")) {
    return {
      session: {
        platform: "codex",
        session_id: "session-1",
        repo_id: "repo_1",
        transcript_path: "/tmp/session.jsonl",
        cwd: "/tmp/repo",
        guidance_injected_at: "2026-07-09T00:00:00.000Z",
        stops_since_memory_current: 0,
        last_seen_at: "2026-07-09T00:00:00.000Z",
        last_memory_current_at: null,
      },
      shouldInjectGuidance: true,
    };
  }
  if (url.endsWith("/hooks/claim-due-memory-updates")) return [];
  if (url.endsWith("/sessions/mark-memory-current")) return true;
  return {
    repo_id: "repo_1",
    main_scope_id: "scope_main",
    working_scope_id: "scope_working",
    database_path: "managed:https://api.example.test",
    created: true,
  };
}

async function checkCliManagedModeDoesNotCreateLocalGraphDb() {
  const tmp = mkdtempSync(join(tmpdir(), "greplica-managed-cli-test-"));
  const repoDir = join(tmp, "repo");
  const greplicaHome = join(tmp, "greplica-home");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(greplicaHome, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repoDir, encoding: "utf8" });

  const serverCalls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      serverCalls.push({
        url: req.url,
        body: bodyText.length === 0 ? {} : JSON.parse(bodyText),
      });
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify(responseFor(`http://127.0.0.1${req.url}`)));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(
      join(greplicaHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        mode: "managed",
        embedding: {
          provider: "local",
          model: "all-mpnet-base-v2",
          dimensions: 768,
          batchSize: 16,
        },
        managed: {
          apiUrl: `http://127.0.0.1:${address.port}`,
          authToken: "cli-token",
        },
        session: {
          stopThreshold: 7,
          timeThresholdMinutes: 40,
          currentGraceMinutes: 5,
          autoMemoryUpdates: false,
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const env = {
      ...process.env,
      GREPLICA_HOME: greplicaHome,
    };
    const contextOutput = await execFileText(process.execPath, [cli.pathname, "graph", "context", "managed smoke"], {
      cwd: repoDir,
      env,
      timeout: 10000,
    });
    assert.match(contextOutput, /Graph Context/);

    await execFileText(process.execPath, [cli.pathname, "hook", "ingest", "--platform", "codex"], {
      cwd: repoDir,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "managed-session",
        cwd: repoDir,
      }),
      env,
      timeout: 10000,
    });

    assert.deepEqual(
      serverCalls.map((call) => call.url),
      ["/v1/graph/context", "/v1/hooks/record"],
    );
    assert.equal(existsSync(join(greplicaHome, "graph.db")), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      ...options,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}
