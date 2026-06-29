import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import {
  copyStringField,
  isRecord,
  parseJsonLine,
  renderSessionTranscriptMarkdown,
  sanitizeTranscriptMessage,
  type SessionTranscriptMessage,
} from "../../session-transcript/markdown.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

export const claudeInstaller: PlatformInstaller = {
  platform: "claude",
  install(_context: PlatformInstallContext): PlatformInstallResult {
    const claudeHome = join(homedir(), ".claude");
    const skills = copyBundledSkills(join(claudeHome, "skills"));
    const settingsPath = join(claudeHome, "settings.json");
    const command = hookCommand("claude");
    const settings = mergeHookConfig(readJsonObject(settingsPath), "claude", command);
    writeJson(settingsPath, settings);

    return {
      skills,
      hooks: {
        platform: "claude",
        configFiles: [settingsPath],
        events: [...hookEvents],
        command,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `claude-code-session:${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith("claude-code-session:") ? ref.slice("claude-code-session:".length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    return claudeTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runClaudePrint(input);
  },
};

export function claudeTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    copyStringField(metadata, event, "sessionId", "session_id");
    copyStringField(metadata, event, "session_id", "session_id");
    copyStringField(metadata, event, "cwd", "cwd");
    copyStringField(metadata, event, "version", "cli_version");
    copyStringField(metadata, event, "model", "model");

    const role = claudeTranscriptRole(event);
    if (role === undefined) continue;

    const message = isRecord(event.message) ? extractTextContent(event.message.content) : extractTextContent(event.message);
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

function claudeTranscriptRole(event: Record<string, unknown>): SessionTranscriptMessage["role"] | undefined {
  if (event.type === "user") return "human";
  if (event.type === "assistant") return "agent";
  if (isRecord(event.message)) {
    if (event.message.role === "user") return "human";
    if (event.message.role === "assistant") return "agent";
  }
  return undefined;
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

function runClaudePrint(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    const args = [
      "--bare",
      "--print",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];

    const child = spawn(
      "claude",
      args,
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );

    child.once("error", (error) => {
      transcript.end();
      reject(error);
    });
    child.stdout.pipe(transcript);
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      transcript.end();
      writeFileSync(
        input.finalMessagePath,
        `Claude update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve();
    });
  });
}
