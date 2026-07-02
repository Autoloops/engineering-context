import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyError, type McpToolError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ToolMiddleware } from "./compose.js";

/**
 * Centralized error boundary: turns thrown domain errors into structured MCP tool
 * errors. Business failures return `isError: true`; only unexpected faults are
 * logged with their cause. Raw stack traces never reach the client.
 */
export function withError(): ToolMiddleware {
  return (next) => async (input, context) => {
    try {
      return await next(input, context);
    } catch (error) {
      const mapped = classifyError(error);
      logMapped(context.logger, mapped);
      return toToolError(mapped);
    }
  };
}

function logMapped(logger: Logger, error: McpToolError): void {
  if (error.code === "INTERNAL") {
    logger.error("tool.error", error.cause ?? error, { code: error.code });
    return;
  }
  logger.warn("tool.rejected", { code: error.code, message: error.message });
}

function toToolError(error: McpToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `[${error.code}] ${error.message}` }],
  };
}
