import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpContainer } from "../container.js";
import { classifyError } from "../errors.js";
import type { Logger } from "../logger.js";

/**
 * Resource controller for `greplica://graph/read`. The repo is resolved from
 * GREPLICA_REPO_ROOT (resources carry no arguments). Resources signal failure by
 * throwing a protocol error, so we rethrow a clean, code-prefixed message.
 */
export function readGraphResource(container: McpContainer, logger: Logger, uri: URL): ReadResourceResult {
  try {
    const installed = container.getInstalled();
    const graph = container.readGraph(installed);
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(graph, null, 2),
        },
      ],
    };
  } catch (error) {
    const mapped = classifyError(error);
    if (mapped.code === "INTERNAL") {
      logger.error("resource.error", mapped.cause ?? mapped, { code: mapped.code });
    } else {
      logger.warn("resource.rejected", { code: mapped.code, message: mapped.message });
    }
    throw new Error(`[${mapped.code}] ${mapped.message}`);
  }
}
