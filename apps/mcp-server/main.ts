#!/usr/bin/env node
/**
 * Greplica MCP server (issue #24: Feat: Add Model Context Protocol (MCP) server
 * integration).
 *
 * Wraps the same local knowledge-graph service the CLI uses so MCP-aware agents
 * (Claude Desktop, Cursor, etc.) can query and update repo memory directly as
 * native tools/resources instead of shelling out to `greplica ...`.
 *
 * Exposes:
 * - tool  query_graph_context: same as `greplica graph context <query>`.
 * - tool  apply_proposal: same as `greplica proposal apply <file>`, but takes the
 *   proposal JSON inline instead of a file path.
 * - resource greplica://graph/read: the full current graph view (components,
 *   flows, claims, sources, edges), same data as `greplica graph read`.
 *
 * IMPORTANT: this process communicates over stdio using the MCP JSON-RPC framing
 * on stdout. Nothing may write plain text to stdout other than the SDK itself.
 * Diagnostics must go to stderr (console.error), never console.log/stdout.write.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLocalKnowledgeGraphService, KnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import type { RepoRef } from "../../libs/knowledge-graph/service.js";
import { ensureGreplicaConfig } from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
import { detectRepoContext } from "../cli/repo-context.js";

interface McpServerContext {
  repo: RepoRef;
  service: KnowledgeGraphService;
}

let cachedContext: McpServerContext | undefined;

/**
 * Repo detection and service construction are cheap and safe to redo per call,
 * but caching avoids re-running `git` and re-reading config on every tool call
 * within one server process (one process is expected to serve one repo/session).
 */
function getContext(): McpServerContext {
  if (cachedContext !== undefined) return cachedContext;
  const repo = detectRepoContext();
  const config = ensureGreplicaConfig();
  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
  cachedContext = { repo, service };
  return cachedContext;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

export function createGreplicaMcpServer(): McpServer {
  const server = new McpServer({ name: "greplica", version: "0.1.0" });

  server.registerTool(
    "query_graph_context",
    {
      title: "Query Greplica graph context",
      description:
        "Runs a repo-context query against Greplica's local knowledge graph and returns the matching " +
        "components, flows, claims, sources, and edges as Markdown. Equivalent to `greplica graph context <query>`.",
      inputSchema: {
        query: z.string().min(1, "query must not be empty"),
      },
    },
    async ({ query }) => {
      try {
        const { repo, service } = getContext();
        const result = await service.contextGraph(repo, query);
        return textResult(renderGraphContextMarkdown(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "apply_proposal",
    {
      title: "Apply a Greplica proposal",
      description:
        "Applies a Greplica knowledge-graph proposal (the same JSON shape written by " +
        "greplica-update-working-memory / bootstrap) directly to working memory. Equivalent to " +
        "`greplica proposal apply <file>`, but the proposal is passed inline instead of as a file path.",
      inputSchema: {
        proposal: z.unknown().describe("The proposal JSON object, e.g. { creates: { components: [...], claims: [...] }, ... }"),
      },
    },
    async ({ proposal }) => {
      try {
        const { repo, service } = getContext();
        service.requireRepo(repo);
        const result = await service.applyProposal(repo, proposal);
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerResource(
    "graph_read",
    "greplica://graph/read",
    {
      title: "Greplica graph view",
      description:
        "The full current knowledge-graph view for this repo (main + working memory): all components, " +
        "flows, claims, sources, and edges in scope. Equivalent to `greplica graph read`.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { repo, service } = getContext();
      const graph = service.readGraph(repo);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(graph, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createGreplicaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("greplica-mcp fatal error:", error);
  process.exitCode = 1;
});
