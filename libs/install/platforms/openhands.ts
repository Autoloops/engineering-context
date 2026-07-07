import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import { runOpenHandsAgent } from "../../agent-runner/openhands.js";
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

const sessionRefPrefix = "openhands-session:";

export const openhandsInstaller: PlatformInstaller = {
  platform: "openhands",
  install(context: PlatformInstallContext): PlatformInstallResult {
    // OpenHands loads skills and hooks from the repository, not a user home dir.
    const { repoRoot } = context;
    const skills = copyBundledSkills(join(repoRoot, ".agents", "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(repoRoot, ".openhands", "hooks.json");
    const command = hookCommand("openhands");
    const hookConfig = mergeHookConfig(readJsonObject(hookConfigPath), "openhands", command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "openhands",
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
    // Hook input carries no transcript path; events live under the conversation dir.
    const sessionId = hookSessionId(hook);
    if (sessionId === undefined) return undefined;
    return join(openhandsHome(), "conversations", sessionId.replace(/-/g, ""), "events");
  },
  loadTranscript(transcriptPath: string): string {
    return loadOpenHandsEvents(transcriptPath);
  },
  transcriptToMarkdown(transcript: string): string {
    return openhandsTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runOpenHandsAgent(input);
  },
};

function openhandsHome(): string {
  return process.env.OPENHANDS_HOME ?? join(homedir(), ".openhands");
}

// Project the ordered event-*.json files into one compact JSON line each (JSONL).
function loadOpenHandsEvents(eventsDir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(eventsDir);
  } catch {
    return "";
  }

  const lines: string[] = [];
  const sessionId = sessionIdFromEventsDir(eventsDir);
  if (sessionId !== undefined) {
    lines.push(JSON.stringify({ type: "session.header", session_id: sessionId }));
  }
  for (const name of entries.filter((entry) => entry.startsWith("event-") && entry.endsWith(".json")).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(eventsDir, name), "utf8"));
    } catch {
      continue;
    }
    if (isRecord(parsed)) lines.push(JSON.stringify(parsed));
  }
  return lines.join("\n");
}

function openhandsTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    copyOpenHandsMetadata(metadata, event);

    const role = openhandsRole(event.source);
    if (role === undefined) continue;

    // Conversational turns only: MessageEvents + the agent's FinishAction summary.
    const message = openhandsMessageText(event);
    const sanitizedMessage = sanitizeTranscriptMessage(message);
    if (sanitizedMessage.length === 0) continue;

    messages.push({
      timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
      role,
      phase: undefined,
      message: sanitizedMessage,
    });
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}

function sessionIdFromEventsDir(eventsDir: string): string | undefined {
  if (basename(eventsDir) !== "events") return undefined;
  const conversationId = basename(dirname(eventsDir));
  return conversationId.length > 0 ? conversationId : undefined;
}

function copyOpenHandsMetadata(target: Record<string, string>, event: Record<string, unknown>): void {
  const sessionId = stringValue(event.session_id) ?? stringValue(event.sessionId) ?? stringValue(event.conversation_id) ?? stringValue(event.conversationId);
  if (target.session_id === undefined && sessionId !== undefined) target.session_id = sessionId;

  const cwd = stringValue(event.cwd) ?? stringValue(event.working_dir);
  if (target.cwd === undefined && cwd !== undefined) target.cwd = cwd;
}

function openhandsRole(source: unknown): SessionTranscriptMessage["role"] | undefined {
  if (source === "user") return "human";
  if (source === "agent") return "agent";
  return undefined;
}

function openhandsMessageText(event: Record<string, unknown>): string {
  if (event.kind === "MessageEvent" && isRecord(event.llm_message)) {
    return extractTextContent(event.llm_message.content);
  }
  if (event.kind === "ActionEvent" && isRecord(event.action) && event.action.kind === "FinishAction") {
    return typeof event.action.message === "string" ? event.action.message.trim() : "";
  }
  return "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n\n").trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
