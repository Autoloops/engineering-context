export type ToolErrorCode = "REPO_NOT_INSTALLED" | "INPUT_INVALID" | "PROPOSAL_INVALID" | "INTERNAL";

/**
 * Domain error carrying a stable, client-facing code. The error middleware maps
 * these onto MCP tool errors so raw stack traces never cross the boundary.
 */
export class McpToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function repoNotInstalled(repoRoot: string | undefined, cause?: unknown): McpToolError {
  const where = repoRoot === undefined ? "" : ` for ${repoRoot}`;
  return new McpToolError(
    "REPO_NOT_INSTALLED",
    `Greplica memory is not initialized${where}. Run \`greplica install --platform <agent> --embedding local\` in the repository first.`,
    cause,
  );
}

export function inputInvalid(message: string, cause?: unknown): McpToolError {
  return new McpToolError("INPUT_INVALID", message, cause);
}

/**
 * Normalizes any thrown value into an McpToolError. Known domain errors pass
 * through unchanged; everything else becomes an opaque INTERNAL error whose
 * detail is logged but not returned to the client.
 */
export function classifyError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  // KnowledgeGraphService.applyProposal throws a plain Error with this prefix
  // when its internal validation rejects the proposal (service.ts:149).
  if (error instanceof Error && error.message.startsWith("Proposal is invalid")) {
    return new McpToolError("PROPOSAL_INVALID", error.message, error);
  }
  return new McpToolError("INTERNAL", "Unexpected error while handling the request.", error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
