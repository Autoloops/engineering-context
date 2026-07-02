import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpContainer } from "./container.js";
import type { Logger } from "./logger.js";
import { compose, type RequestContext, type ToolHandler } from "./middleware/compose.js";
import { withError } from "./middleware/with-error.js";
import { withLogging } from "./middleware/with-logging.js";
import { applyProposal } from "./controllers/apply-proposal.js";
import { auditAnchors } from "./controllers/audit-anchors.js";
import { queryContext } from "./controllers/query-context.js";
import { readGraphResource } from "./controllers/read-graph.js";
import { validateProposal } from "./controllers/validate-proposal.js";
import {
  applyProposalOutput,
  auditAnchorsOutput,
  proposalInput,
  queryContextInput,
  queryContextOutput,
  repoScopedInput,
  validateProposalOutput,
} from "./schemas.js";

export const graphReadResourceUri = "greplica://graph/read";

export interface McpServerDeps {
  readonly container: McpContainer;
  readonly logger: Logger;
}

/**
 * Transport-agnostic composition root: assembles the McpServer, wraps every
 * controller in the logging + error pipeline, and registers tools and resources.
 * The entrypoint chooses the transport (stdio today; HTTP later without changes here).
 */
export function createGreplicaMcpServer(deps: McpServerDeps): McpServer {
  const { container, logger } = deps;
  const server = new McpServer({ name: "greplica", version: greplicaVersion() });
  const pipeline = compose(withLogging(), withError());

  async function runTool<Input>(name: string, handler: ToolHandler<Input>, input: Input): Promise<CallToolResult> {
    const requestId = randomUUID();
    const context: RequestContext = {
      requestId,
      logger: logger.child({ tool: name, request_id: requestId }),
      container,
    };
    // Safe erasure: middleware passes the input through untouched, and the
    // concrete handler is the only party that reads it (already typed as Input).
    return pipeline(handler as ToolHandler<unknown>)(input, context);
  }

  server.registerTool(
    "query_graph_context",
    {
      title: "Query graph context",
      description:
        "Retrieve relevant repository memory (claims, components, flows) for a natural-language query before broad exploration.",
      inputSchema: queryContextInput.shape,
      outputSchema: queryContextOutput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => runTool("query_graph_context", queryContext, input),
  );

  server.registerTool(
    "validate_proposal",
    {
      title: "Validate memory proposal",
      description: "Validate a Greplica memory proposal (schema, edge rules, code-anchor audit) without writing it.",
      inputSchema: proposalInput.shape,
      outputSchema: validateProposalOutput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => runTool("validate_proposal", validateProposal, input),
  );

  server.registerTool(
    "apply_proposal",
    {
      title: "Apply memory proposal",
      description: "Validate and apply a Greplica memory proposal to working memory as a new memory commit.",
      inputSchema: proposalInput.shape,
      outputSchema: applyProposalOutput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => runTool("apply_proposal", applyProposal, input),
  );

  server.registerTool(
    "audit_anchors",
    {
      title: "Audit code anchors",
      description: "Check every code_verified claim's code anchors against the current repository files.",
      inputSchema: repoScopedInput.shape,
      outputSchema: auditAnchorsOutput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => runTool("audit_anchors", auditAnchors, input),
  );

  server.registerResource(
    "graph",
    graphReadResourceUri,
    {
      title: "Greplica graph view",
      description: "The current merged graph view (components, flows, claims, sources, edges) as JSON.",
      mimeType: "application/json",
    },
    (uri) => readGraphResource(container, logger.child({ resource: "graph" }), uri),
  );

  return server;
}

function greplicaVersion(): string {
  // dist/apps/mcp/server.js -> ../../../package.json is the package root.
  try {
    const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    // Fall through to the unknown-version sentinel below.
  }
  return "0.0.0";
}
