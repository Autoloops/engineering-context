// Focused smoke check for the Greplica MCP server (issue #24).
//
// Spawns the built `dist/apps/mcp-server/main.js` as a child process, connects
// a real MCP client to it over stdio, and exercises:
// - tools/list includes query_graph_context and apply_proposal
// - apply_proposal creates a component + claim in a freshly installed repo
// - query_graph_context returns Markdown mentioning what was just created
// - resources/read on greplica://graph/read returns the same data as JSON
//
// Run with: npm run smoke:mcp-server

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(repoRoot, "dist", "apps", "mcp-server", "main.js");
const cliPath = join(repoRoot, "dist", "apps", "cli", "main.js");

const repoDir = mkdtempSync(join(tmpdir(), "greplica-mcp-smoke-repo-"));
const greplicaHome = mkdtempSync(join(tmpdir(), "greplica-mcp-smoke-home-"));

const { execFileSync } = await import("node:child_process");

try {
  // Seed a real installed repo the same way a user would, so the MCP server's
  // repo/config detection has something valid to work with.
  execFileSync(process.execPath, [cliPath, "install", "--platform", "codex", "--embedding", "local"], {
    cwd: repoDir,
    env: { ...process.env, HOME: greplicaHome, GREPLICA_HOME: greplicaHome },
    stdio: "pipe",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoDir,
    env: { ...process.env, HOME: greplicaHome, GREPLICA_HOME: greplicaHome },
  });

  const client = new Client({ name: "greplica-mcp-smoke-client", version: "0.0.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert(toolNames.includes("query_graph_context"), `expected query_graph_context in tools, got: ${toolNames}`);
    assert(toolNames.includes("apply_proposal"), `expected apply_proposal in tools, got: ${toolNames}`);

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    assert(
      resourceUris.includes("greplica://graph/read"),
      `expected greplica://graph/read in resources, got: ${resourceUris}`,
    );

    const proposal = {
      title: "MCP server smoke test seed",
      summary: "Component and claim created by the MCP server smoke test to verify apply_proposal.",
      creates: {
        components: [
          {
            id: "component.mcp_smoke_widget",
            name: "MCP Smoke Widget",
            code_anchor: "apps/mcp-server/main.ts",
          },
        ],
        flows: [],
        claims: [
          {
            id: "claim.mcp_smoke_fact",
            kind: "fact",
            text: "The MCP smoke test created this claim through apply_proposal.",
            truth: "unknown",
            intent: "intended",
            about: ["component.mcp_smoke_widget"],
          },
        ],
        sources: [],
        edges: [],
      },
    };

    const applyResult = await client.callTool({
      name: "apply_proposal",
      arguments: { proposal },
    });
    assert(applyResult.isError !== true, `apply_proposal returned an error: ${JSON.stringify(applyResult)}`);
    const applyText = applyResult.content[0]?.text ?? "";
    assert(applyText.includes('"components": 1'), `expected 1 component created, got: ${applyText}`);
    assert(applyText.includes('"claims": 1'), `expected 1 claim created, got: ${applyText}`);

    const contextResult = await client.callTool({
      name: "query_graph_context",
      arguments: { query: "MCP Smoke Widget" },
    });
    assert(contextResult.isError !== true, `query_graph_context returned an error: ${JSON.stringify(contextResult)}`);
    const contextText = contextResult.content[0]?.text ?? "";
    assert(
      contextText.includes("MCP Smoke Widget") || contextText.includes("mcp_smoke_widget"),
      `expected query_graph_context output to mention the new component, got: ${contextText}`,
    );

    const emptyQueryResult = await client.callTool({
      name: "query_graph_context",
      arguments: { query: "" },
    });
    assert(emptyQueryResult.isError === true, "expected an empty query to be rejected as a tool error");

    const graphResource = await client.readResource({ uri: "greplica://graph/read" });
    const graphContent = graphResource.contents[0];
    assert(graphContent?.mimeType === "application/json", `expected application/json, got: ${graphContent?.mimeType}`);
    const graph = JSON.parse(graphContent.text ?? "{}");
    assert(
      Array.isArray(graph.components) && graph.components.some((component) => component.id === "component.mcp_smoke_widget"),
      "expected graph resource to include the newly created component",
    );
  } finally {
    await client.close();
  }

  console.log("MCP server smoke check passed.");
} finally {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(greplicaHome, { recursive: true, force: true });
}
