import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import { runCodexAgent } from "../../agent-runner/codex.js";
import {
  copyStringField,
  isRecord,
  parseJsonLine,
  renderSessionTranscriptMarkdown,
  sanitizeTranscriptMessage,
  type SessionTranscriptMessage,
} from "../../session-transcript/markdown.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

export const codexInstaller: PlatformInstaller = {
  platform: "codex",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const skills = copyBundledSkills(join(codexHome, "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(codexHome, "hooks.json");
    const command = hookCommand("codex");
    const hookConfig = mergeHookConfig(readJsonObject(hookConfigPath), "codex", command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "codex",
        configFiles: [hookConfigPath],
        events: [...hookEvents],
        command,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `codex-session:${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith("codex-session:") ? ref.slice("codex-session:".length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    return codexTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runCodexAgent(input);
  },
};

function codexTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    if (event.type === "session_meta" && isRecord(event.payload)) {
      copyStringField(metadata, event.payload, "id", "session_id");
      copyStringField(metadata, event.payload, "timestamp", "session_timestamp");
      copyStringField(metadata, event.payload, "cwd", "cwd");
      copyStringField(metadata, event.payload, "originator", "originator");
      copyStringField(metadata, event.payload, "cli_version", "cli_version");
      copyStringField(metadata, event.payload, "source", "source");
      copyStringField(metadata, event.payload, "model_provider", "model_provider");
      continue;
    }

    if (event.type !== "event_msg" || !isRecord(event.payload)) continue;
    const payloadType = event.payload.type;
    if (payloadType !== "user_message" && payloadType !== "agent_message") continue;

    const message = event.payload.message;
    if (typeof message !== "string" || message.trim().length === 0) continue;
    const sanitizedMessage = sanitizeTranscriptMessage(message);
    if (sanitizedMessage.length === 0) continue;
    messages.push({
      timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
      role: payloadType === "user_message" ? "human" : "agent",
      phase: typeof event.payload.phase === "string" ? event.payload.phase : undefined,
      message: sanitizedMessage,
    });
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}
