import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const distRoot = new URL("../dist/", import.meta.url);
const { createGreplicaMcpServer, graphReadResourceUri } = await import(new URL("apps/mcp/server.js", distRoot));
const { McpContainer } = await import(new URL("apps/mcp/container.js", distRoot));
const { createLogger } = await import(new URL("apps/mcp/logger.js", distRoot));
const { detectRepoContext } = await import(new URL("apps/cli/repo-context.js", distRoot));
const { KnowledgeGraphService } = await import(new URL("libs/knowledge-graph/service.js", distRoot));
const { normalizeProposal } = await import(new URL("libs/knowledge-graph/proposal.js", distRoot));
const { openDatabase } = await import(new URL("libs/storage/sqlite/db.js", distRoot));
const { SqliteRepository } = await import(new URL("libs/storage/sqlite/repository.js", distRoot));

const home = mkdtempSync(join(tmpdir(), "greplica-mcp-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "greplica-mcp-repo-"));
const uninstalledRoot = mkdtempSync(join(tmpdir(), "greplica-mcp-fresh-"));
process.env.GREPLICA_HOME = home;
process.env.GREPLICA_REPO_ROOT = repoRoot;
process.env.GREPLICA_MCP_LOG_LEVEL = "silent";

try {
  arrangeFixtureGraph(repoRoot);

  const client = await startClient();
  try {
    await checkTools(client);
    await checkResource(client);
    await checkValidateProposal(client);
    await checkApplyInvalidProposal(client);
    await checkAuditAnchors(client);
    await checkRepoNotInstalled(client);
    await checkEmbeddingEndToEnd(client);
  } finally {
    await client.close();
  }

  await checkStdoutHygiene();

  console.log("MCP server checks passed.");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(uninstalledRoot, { recursive: true, force: true });
}

/** Seed a small graph directly through the storage layer (no embeddings needed). */
function arrangeFixtureGraph(root) {
  const db = openDatabase();
  try {
    const repository = new SqliteRepository(db);
    const service = new KnowledgeGraphService(repository);
    const repo = detectRepoContext(root);
    const init = service.initRepo(repo);
    const working = repository.requireWorkingScope(init.repo_id);
    const commit = repository.createMemoryCommit({ scope_id: working.id, title: "fixture memory" });
    const proposal = {
      title: "fixture memory",
      creates: {
        components: [{ id: "component.cli", name: "CLI" }],
        flows: [{ id: "flow.dispatch", name: "Command dispatch" }],
        claims: [
          {
            id: "claim.cli_entry",
            kind: "fact",
            text: "The CLI routes subcommands through a single dispatcher.",
            truth: "source_verified",
            intent: "intended",
            about: ["component.cli"],
          },
        ],
      },
    };
    const normalized = normalizeProposal(proposal, repository);
    repository.createProposalRecords(working.id, commit.id, normalized);
  } finally {
    db.close();
  }
}

async function startClient() {
  const logger = createLogger("silent");
  const server = createGreplicaMcpServer({ container: new McpContainer(logger), logger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "greplica-mcp-check", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function checkTools(client) {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["apply_proposal", "audit_anchors", "query_graph_context", "validate_proposal"]);

  const apply = tools.find((tool) => tool.name === "apply_proposal");
  assert.equal(apply.annotations?.readOnlyHint, false, "apply_proposal must not be read-only");
  assert.equal(apply.annotations?.idempotentHint, false, "apply_proposal must not be idempotent");

  const query = tools.find((tool) => tool.name === "query_graph_context");
  assert.equal(query.annotations?.readOnlyHint, true, "query_graph_context must be read-only");
}

async function checkResource(client) {
  const { resources } = await client.listResources();
  assert.ok(
    resources.some((resource) => resource.uri === graphReadResourceUri),
    "graph read resource must be registered",
  );

  const read = await client.readResource({ uri: graphReadResourceUri });
  const graph = JSON.parse(read.contents[0].text);
  assert.ok(graph.components.length >= 1, "resource should expose the fixture component");
  assert.ok(graph.claims.length >= 1, "resource should expose the fixture claim");
}

async function checkValidateProposal(client) {
  const invalid = await client.callTool({
    name: "validate_proposal",
    arguments: {
      repo_root: repoRoot,
      // code_verified claim without any code anchors -> server-side validation must reject.
      proposal: {
        title: "invalid",
        creates: {
          claims: [
            { id: "claim.bad", kind: "fact", text: "x", truth: "code_verified", intent: "intended" },
          ],
        },
      },
    },
  });
  assert.equal(invalid.structuredContent.valid, false);
  assert.ok(invalid.structuredContent.errors.length >= 1, "invalid proposal must report errors");

  const valid = await client.callTool({
    name: "validate_proposal",
    arguments: {
      repo_root: repoRoot,
      proposal: { title: "ok", creates: { components: [{ id: "component.extra", name: "Extra" }] } },
    },
  });
  assert.equal(valid.structuredContent.valid, true, "well-formed proposal must validate");
}

async function checkApplyInvalidProposal(client) {
  // Validation fails inside service.applyProposal (before any embedding work);
  // the error middleware must surface it as PROPOSAL_INVALID, not INTERNAL.
  const result = await client.callTool({
    name: "apply_proposal",
    arguments: {
      repo_root: repoRoot,
      proposal: {
        title: "invalid apply",
        creates: {
          claims: [{ id: "claim.bad_apply", kind: "fact", text: "x", truth: "code_verified", intent: "intended" }],
        },
      },
    },
  });
  assert.equal(result.isError, true, "invalid proposal must fail apply");
  assert.match(result.content[0].text, /PROPOSAL_INVALID/);
}

async function checkAuditAnchors(client) {
  const audit = await client.callTool({ name: "audit_anchors", arguments: { repo_root: repoRoot } });
  assert.equal(audit.structuredContent.issue_count, 0, "fixture has no code_verified claims to fail");
}

async function checkRepoNotInstalled(client) {
  const result = await client.callTool({ name: "audit_anchors", arguments: { repo_root: uninstalledRoot } });
  assert.equal(result.isError, true, "uninitialized repo must produce a tool error");
  assert.match(result.content[0].text, /REPO_NOT_INSTALLED/);
}

/** Heavy path: exercises real embeddings. Off by default; opt in for full coverage. */
async function checkEmbeddingEndToEnd(client) {
  if (process.env.GREPLICA_MCP_TEST_EMBEDDINGS !== "1") {
    console.log("(skipping embedding end-to-end: set GREPLICA_MCP_TEST_EMBEDDINGS=1 to run)");
    return;
  }

  const applied = await client.callTool({
    name: "apply_proposal",
    arguments: {
      repo_root: repoRoot,
      proposal: {
        title: "session insight",
        creates: {
          claims: [
            {
              id: "claim.dispatch_note",
              kind: "decision",
              text: "Command dispatch resolves the repo before running any subcommand.",
              truth: "source_verified",
              intent: "intended",
              about: ["flow.dispatch"],
            },
          ],
        },
      },
    },
  });
  assert.notEqual(applied.isError, true, "apply_proposal should succeed");
  assert.ok(applied.structuredContent.memory_commit_id.length > 0);

  const context = await client.callTool({
    name: "query_graph_context",
    arguments: { repo_root: repoRoot, query: "command dispatch repo resolution" },
  });
  assert.notEqual(context.isError, true, "query_graph_context should succeed");
  assert.ok(context.structuredContent.markdown.length > 0, "context should return markdown");
}

/**
 * The stdio transport uses stdout for JSON-RPC framing, so logs must go to stderr
 * only. Spawn the real binary and confirm stdout carries valid JSON-RPC.
 */
async function checkStdoutHygiene() {
  const mainPath = fileURLToPath(new URL("apps/mcp/main.js", distRoot));
  const child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, GREPLICA_MCP_LOG_LEVEL: "debug" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "greplica-mcp-smoke", version: "0.0.0" },
    },
  };

  try {
    // Resolve as soon as a complete line lands on stdout, rather than sleeping a
    // fixed interval (which is flaky under load).
    const firstLine = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a stdout frame")), 15_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(stdout.slice(0, newline));
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited before responding (code ${code})\n${stderr}`));
      });
      child.stdin.write(`${JSON.stringify(initialize)}\n`);
    });

    const parsed = JSON.parse(firstLine.trim()); // throws if a log line leaked onto stdout
    assert.equal(parsed.jsonrpc, "2.0", "stdout must contain only JSON-RPC frames");

    // Wait for the ready log on stderr instead of sleeping a fixed interval.
    const readyDeadline = Date.now() + 5_000;
    while (!/server\.ready/.test(stderr) && Date.now() < readyDeadline) {
      await delay(25);
    }
    assert.match(stderr, /server\.ready/, "structured logs must go to stderr");
  } finally {
    child.kill("SIGTERM");
  }
}
