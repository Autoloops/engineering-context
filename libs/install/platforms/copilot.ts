import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const copilotSessionRefPrefix = "copilot-session:";
const copilotHookEvents = ["SessionStart", "Stop"] as const;

export const copilotInstaller: PlatformInstaller = {
  platform: "copilot",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const home = copilotHome();
    const skills = copyBundledSkills(join(home, "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(home, "hooks", "greplica.json");
    const command = hookCommand("copilot");
    const hookConfig = mergeCopilotHookConfig(readJsonObject(hookConfigPath), command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "copilot",
        configFiles: [hookConfigPath],
        events: [...copilotHookEvents],
        command,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `${copilotSessionRefPrefix}${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith(copilotSessionRefPrefix) ? ref.slice(copilotSessionRefPrefix.length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    return copilotTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runCopilot(input);
  },
};

function copilotHome(): string {
  return process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
}

function mergeCopilotHookConfig(base: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooks = isRecord(base.hooks) ? { ...base.hooks } : {};

  for (const event of copilotHookEvents) {
    const existingHooks = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...existingHooks.filter((entry) => !isRecord(entry) || entry.command !== command),
      copilotCommandHook(command),
    ];
  }

  return {
    ...base,
    version: typeof base.version === "number" ? base.version : 1,
    hooks,
  };
}

function copilotCommandHook(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    timeoutSec: 5,
  };
}

function copilotTranscriptToMarkdown(jsonl: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const line of jsonl.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    copyStringField(metadata, event, "sessionId", "session_id");
    copyStringField(metadata, event, "session_id", "session_id");
    copyStringField(metadata, event, "cwd", "cwd");
    copyStringField(metadata, event, "model", "model");
    if (event.type === "session.start" && isRecord(event.data)) {
      copyStringField(metadata, event.data, "sessionId", "session_id");
      copyStringField(metadata, event.data, "copilotVersion", "copilot_version");
      if (isRecord(event.data.context)) {
        copyStringField(metadata, event.data.context, "cwd", "cwd");
        copyStringField(metadata, event.data.context, "repository", "repository");
        copyStringField(metadata, event.data.context, "branch", "branch");
      }
    }
    if (event.type === "session.model_change" && isRecord(event.data)) {
      copyStringField(metadata, event.data, "newModel", "model");
    }

    const role = copilotTranscriptRole(event);
    if (role === undefined) continue;

    const message = copilotTranscriptMessage(event);
    const sanitizedMessage = sanitizeTranscriptMessage(message);
    if (sanitizedMessage.length === 0) continue;
    messages.push({
      timestamp: stringValue(event.timestamp) ?? numberTimestamp(event.timestamp),
      role,
      phase: stringValue(event.phase) ?? stringValue(event.type),
      message: sanitizedMessage,
    });
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}

function copilotTranscriptRole(event: Record<string, unknown>): SessionTranscriptMessage["role"] | undefined {
  const directRole = stringValue(event.role);
  if (directRole === "user" || directRole === "human") return "human";
  if (directRole === "assistant" || directRole === "agent") return "agent";

  if (isRecord(event.data)) {
    const dataRole = stringValue(event.data.role);
    if (dataRole === "user" || dataRole === "human") return "human";
    if (dataRole === "assistant" || dataRole === "agent") return "agent";
  }

  if (isRecord(event.message)) {
    const messageRole = stringValue(event.message.role);
    if (messageRole === "user" || messageRole === "human") return "human";
    if (messageRole === "assistant" || messageRole === "agent") return "agent";
  }

  const type = stringValue(event.type) ?? stringValue(event.kind);
  if (type === "user" || type === "user_message" || type === "user.message" || type === "human") return "human";
  if (
    type === "assistant" ||
    type === "assistant_message" ||
    type === "assistant.message" ||
    type === "agent" ||
    type === "agent_message"
  ) {
    return "agent";
  }
  return undefined;
}

function copilotTranscriptMessage(event: Record<string, unknown>): string {
  const direct = extractTextContent(event.content) || extractTextContent(event.text) || extractTextContent(event.message);
  if (direct.length > 0) return direct;
  if (isRecord(event.data)) return extractTextContent(event.data.content) || extractTextContent(event.data.text);
  if (isRecord(event.message)) return extractTextContent(event.message.content) || extractTextContent(event.message.text);
  return "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const extracted = extractTextContent(item);
      if (extracted.length > 0) parts.push(extracted);
    }
    return parts.join("\n\n").trim();
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.content === "string") return value.content.trim();
  if (Array.isArray(value.content)) return extractTextContent(value.content);
  return "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberTimestamp(value: unknown): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

function runCopilot(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const sharePath = `${input.transcriptPath}.share.md`;
    const args = [
      "-s",
      "--allow-all",
      "--no-ask-user",
      `--share=${sharePath}`,
    ];

    const child = spawn("copilot", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const stdoutChunks: Buffer[] = [];
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    // If the child exits before draining the prompt, stdin emits EPIPE;
    // the failure is reported via the exit code on "close".
    child.stdin.once("error", () => {});
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      writeFileSync(input.finalMessagePath, stdout, "utf8");
      writeFileSync(
        input.transcriptPath,
        `${JSON.stringify({
          type: "copilot_run",
          timestamp: new Date().toISOString(),
          exit_code: exitCode,
          signal,
          share_path: sharePath,
          output: stdout.trim(),
        })}\n`,
        "utf8",
      );
      resolve();
    });
  });
}
