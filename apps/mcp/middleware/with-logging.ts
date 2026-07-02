import { performance } from "node:perf_hooks";
import type { ToolMiddleware } from "./compose.js";

/**
 * Logs the lifecycle of every tool call (start / finish / threw) with a duration.
 * Placed outermost so it also records results shaped by the error middleware.
 */
export function withLogging(): ToolMiddleware {
  return (next) => async (input, context) => {
    const start = performance.now();
    context.logger.info("tool.start");
    try {
      const result = await next(input, context);
      context.logger.info("tool.finish", {
        duration_ms: elapsedMs(start),
        is_error: result.isError === true,
      });
      return result;
    } catch (error) {
      // Unreachable while withError sits inside this middleware (it never
      // re-throws); kept as a defensive net in case the pipeline order changes.
      context.logger.warn("tool.threw", { duration_ms: elapsedMs(start) });
      throw error;
    }
  };
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}
