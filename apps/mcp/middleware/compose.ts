import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpContainer } from "../container.js";
import type { Logger } from "../logger.js";

export interface RequestContext {
  readonly requestId: string;
  readonly logger: Logger;
  readonly container: McpContainer;
}

export type ToolHandler<Input> = (input: Input, context: RequestContext) => Promise<CallToolResult>;

/**
 * Middleware wraps a type-erased handler. Concrete controllers keep their typed
 * input; the transport-facing pipeline only cares that a result comes back.
 */
export type ToolMiddleware = (next: ToolHandler<unknown>) => ToolHandler<unknown>;

export function compose(...middleware: readonly ToolMiddleware[]): ToolMiddleware {
  return (handler) => middleware.reduceRight<ToolHandler<unknown>>((next, mw) => mw(next), handler);
}
