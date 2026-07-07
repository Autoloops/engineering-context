import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import { runOpenCodeAgent } from "../../agent-runner/opencode.js";
import { hookSessionId } from "../../hooks/hook-input.js";
import type { HookInput } from "../../hooks/types.js";
import {
  isRecord,
  parseJsonLine,
  renderSessionTranscriptMarkdown,
  sanitizeTranscriptMessage,
  type SessionTranscriptMessage,
} from "../../session-transcript/markdown.js";
import type {
  PlatformInstallContext,
  PlatformInstallResult,
  PlatformInstaller,
  WorkingMemoryUpdateInput,
} from "./types.js";

const sessionRefPrefix = "opencode-session:";

export const opencodeInstaller: PlatformInstaller = {
  platform: "opencode",

  install(context: PlatformInstallContext): PlatformInstallResult {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    const skills = copyBundledSkills(join(configHome, "opencode", "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(configHome, "opencode", "hooks.json");
    const command = hookCommand("opencode");
    const hookConfig = mergeHookConfig(readJsonObject(hookConfigPath), "opencode", command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "opencode",
        configFiles: [hookConfigPath],
        events: [...hookEvents],
        command,
      },
    };
  },

  sessionSourceRef(sessionId: string): string {
    return `${sessionRefPrefix}${sessionId}`;
  },

  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith(sessionRefPrefix) ? ref.slice(sessionRefPrefix.length) : undefined;
  },

  transcriptPathFromHook(hook: HookInput): string | undefined {
    const sessionId = hookSessionId(hook);
    if (sessionId === undefined) return undefined;
    return resolveOpenCodeSessionPath(sessionId);
  },

  loadTranscript(transcriptPath: string): string {
    return loadOpenCodeTranscript(transcriptPath);
  },

  transcriptToMarkdown(transcript: string): string {
    return opencodeTranscriptToMarkdown(transcript);
  },

  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runOpenCodeAgent(input);
  },
};

function opencodeDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ?? join(homedir(), ".local", "share");
  return join(base, "opencode");
}

function resolveOpenCodeSessionPath(sessionId: string): string | undefined {
  const fileLayout = join(opencodeDataHome(), "storage", "session", `${sessionId}.json`);
  if (existsSync(fileLayout)) return fileLayout;

  const dbPath = join(opencodeDataHome(), "opencode.db");
  if (existsSync(dbPath)) return `sqlite:${dbPath}#${sessionId}`;

  return undefined;
}

function loadOpenCodeTranscript(transcriptPath: string): string {
  if (transcriptPath.startsWith("sqlite:")) {
    return loadFromSqlite(transcriptPath);
  }

  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return "";
    return normalizeFileLayoutSession(parsed);
  } catch {
    return "";
  }
}

function loadFromSqlite(pointer: string): string {
  const [pathPart, sessionId] = pointer.slice("sqlite:".length).split("#");
  if (!pathPart || !sessionId) return "";
  if (!existsSync(pathPart)) return "";

  const db = new Database(pathPart, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT session_id, role, content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    ).all(sessionId) as Array<{
      session_id: string;
      role: string;
      content: string;
      created_at: string | number;
    }>;

    const lines = rows.map((row) =>
      JSON.stringify({
        session_id: row.session_id,
        role: row.role,
        content: row.content,
        timestamp: typeof row.created_at === "number" ? new Date(row.created_at).toISOString() : row.created_at,
      }),
    );
    return lines.join("\n");
  } catch {
    return "";
  } finally {
    db.close();
  }
}

function normalizeFileLayoutSession(session: Record<string, unknown>): string {
  const sessionId = typeof session.id === "string" ? session.id : undefined;
  const directory = typeof session.directory === "string" ? session.directory : undefined;

  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "session.header",
    session_id: sessionId,
    cwd: directory,
  }));

  for (const message of tryReadMessages(sessionId)) {
    lines.push(JSON.stringify(message));
  }

  return lines.join("\n");
}

function tryReadMessages(sessionId: string | undefined): Array<{ role: string; content: string; timestamp?: string }> {
  if (sessionId === undefined) return [];
  const dir = join(opencodeDataHome(), "storage", "message", sessionId);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const out: Array<{ role: string; content: string; timestamp?: string }> = [];
  for (const name of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!isRecord(parsed)) continue;
      const role = typeof parsed.role === "string" ? parsed.role : undefined;
      const content = extractMessageContent(parsed);
      if (role && content) {
        out.push({
          role,
          content,
          timestamp: typeof parsed.time === "string" ? parsed.time : undefined,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function extractMessageContent(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter(isRecord)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function opencodeTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    if (event.type === "session.header") {
      if (typeof event.session_id === "string") metadata.session_id = event.session_id;
      if (typeof event.cwd === "string") metadata.cwd = event.cwd;
      continue;
    }

    const role = opencodeRole(event.role);
    if (role === undefined) continue;

    const content = typeof event.content === "string" ? event.content : "";
    const sanitized = sanitizeTranscriptMessage(content);
    if (sanitized.length === 0) continue;

    messages.push({
      timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
      role,
      phase: undefined,
      message: sanitized,
    });
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}

function opencodeRole(role: unknown): SessionTranscriptMessage["role"] | undefined {
  if (role === "user" || role === "human") return "human";
  if (role === "assistant" || role === "agent") return "agent";
  return undefined;
}
