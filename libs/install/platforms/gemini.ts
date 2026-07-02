import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand, readJsonObject, writeJson } from "../hook-config.js";
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

const sessionRefPrefix = "gemini-session:";
export const geminiHookEvents = ["BeforeAgent", "AfterAgent"] as const;

export const geminiInstaller: PlatformInstaller = {
  platform: "gemini",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const skills = copyBundledSkills(join(geminiHome(), "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(geminiHome(), "settings.json");
    const command = hookCommand("gemini");
    const hookConfig = mergeGeminiHookConfig(readJsonObject(hookConfigPath), command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "gemini",
        configFiles: [hookConfigPath],
        events: [...geminiHookEvents],
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
  transcriptToMarkdown(transcript: string): string {
    return geminiTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runGeminiHeadless(input);
  },
};

function geminiHome(): string {
  return process.env.GEMINI_HOME ?? join(homedir(), ".gemini");
}

function mergeGeminiHookConfig(base: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooks = isRecord(base.hooks) ? { ...base.hooks } : {};

  for (const event of geminiHookEvents) {
    const existingGroups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const keptGroups = existingGroups
      .map((group) => removeGeminiCommandFromHookGroup(group, command))
      .filter(groupHasGeminiHandlers);
    hooks[event] = [
      ...keptGroups,
      {
        matcher: "*",
        hooks: [geminiCommandHook(command, event)],
      },
    ];
  }

  return { ...base, hooks };
}

function removeGeminiCommandFromHookGroup(group: unknown, command: string): unknown {
  if (!isRecord(group)) return group;
  if (!Array.isArray(group.hooks)) return group;

  return {
    ...group,
    hooks: group.hooks.filter((handler) => !isRecord(handler) || handler.command !== command),
  };
}

function groupHasGeminiHandlers(group: unknown): boolean {
  if (!isRecord(group)) return true;
  return !Array.isArray(group.hooks) || group.hooks.length > 0;
}

function geminiCommandHook(command: string, event: (typeof geminiHookEvents)[number]): Record<string, unknown> {
  return {
    name: event === "BeforeAgent" ? "greplica-guidance" : "greplica-session",
    type: "command",
    command,
    timeout: 5000,
    description: event === "BeforeAgent" ? "Inject Greplica repo-memory guidance" : "Track Greplica session completion",
  };
}

export function geminiTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    if (event.type === "session_metadata") {
      copyStringField(metadata, event, "sessionId", "session_id");
      copyStringField(metadata, event, "startTime", "session_timestamp");
      copyStringField(metadata, event, "projectHash", "project_hash");
      continue;
    }

    if (event.type !== "user" && event.type !== "gemini") continue;

    const message = extractGeminiMessageContent(event.content);
    const sanitizedMessage = sanitizeTranscriptMessage(message);
    if (sanitizedMessage.length === 0) continue;
    messages.push({
      timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
      role: event.type === "user" ? "human" : "agent",
      phase: typeof event.type === "string" ? event.type : undefined,
      message: sanitizedMessage,
    });
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}

function extractGeminiMessageContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n\n").trim();
}

function runGeminiHeadless(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    const args = ["-p", "--output-format", "stream-json", "--yolo"];

    const child = spawn("gemini", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const stdoutChunks: Buffer[] = [];
    child.once("error", (error) => {
      transcript.end();
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      transcript.write(chunk);
    });
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      transcript.end();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      writeFileSync(input.finalMessagePath, extractGeminiFinalResponse(stdout), "utf8");
      if (exitCode !== 0 && exitCode !== null) {
        resolve();
        return;
      }
      resolve();
    });
  });
}

function extractGeminiFinalResponse(stdout: string): string {
  let lastResponse = "";
  for (const line of stdout.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;
    if (typeof event.response === "string" && event.response.trim().length > 0) {
      lastResponse = event.response.trim();
    }
  }
  return lastResponse.length > 0 ? `${lastResponse}\n` : stdout.trim().length > 0 ? `${stdout.trim()}\n` : "";
}
