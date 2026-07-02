#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpContainer } from "./container.js";
import { createLogger, logLevelFromEnv, type Logger } from "./logger.js";
import { createGreplicaMcpServer } from "./server.js";

async function main(): Promise<void> {
  const logger = createLogger(logLevelFromEnv());
  installProcessGuards(logger);

  const container = new McpContainer(logger);
  const server = createGreplicaMcpServer({ container, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server.ready", { pid: process.pid });
}

function installProcessGuards(logger: Logger): void {
  process.on("uncaughtException", (error) => {
    logger.error("process.uncaught_exception", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandled_rejection", reason);
    process.exit(1);
  });
}

main().catch((error) => {
  // Startup failure before the logger is guaranteed usable: write once to stderr only.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "server.start_failed", error: message })}\n`);
  process.exit(1);
});
