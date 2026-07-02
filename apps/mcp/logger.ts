import { stderr } from "node:process";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

type LogFields = Readonly<Record<string, unknown>>;

const levelRank: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  child(bindings: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: unknown, fields?: LogFields): void;
}

export function logLevelFromEnv(value = process.env.GREPLICA_MCP_LOG_LEVEL): LogLevel {
  const candidate = value?.toLowerCase();
  if (candidate !== undefined && candidate in levelRank) {
    return candidate as LogLevel;
  }
  return "info";
}

/**
 * Structured JSON logger that writes to stderr only. stdout is reserved for the
 * MCP JSON-RPC stream, so nothing here may ever touch it.
 */
export function createLogger(level: LogLevel = "info", bindings: LogFields = {}): Logger {
  const threshold = levelRank[level];

  function write(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (levelRank[entryLevel] > threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...bindings,
      ...fields,
    };
    stderr.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    child(childBindings) {
      return createLogger(level, { ...bindings, ...childBindings });
    },
    debug(message, fields) {
      write("debug", message, fields);
    },
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, error, fields) {
      write("error", message, { ...fields, ...errorFields(error) });
    },
  };
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error === undefined) return {};
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
