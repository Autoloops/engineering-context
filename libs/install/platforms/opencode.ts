import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hookCommand } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import {
  copyStringField,
  isRecord,
  parseJsonLine,
  renderSessionTranscriptMarkdown,
  sanitizeTranscriptMessage,
  type SessionTranscriptMessage,
} from "../../session-transcript/markdown.js";
import type { PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

export const opencodeInstaller: PlatformInstaller = {
  platform: "opencode",
  install(): PlatformInstallResult {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    const pluginPath = join(configHome, "opencode", "plugins", "greplica.js");
    mkdirSync(dirname(pluginPath), { recursive: true });
    writeFileSync(pluginPath, opencodePluginSource(hookCommand("opencode")), "utf8");

    return {
      skills: copyBundledSkills(join(configHome, "opencode", "skills")),
      hooks: {
        platform: "opencode",
        configFiles: [pluginPath],
        events: ["session.updated", "session.idle"],
        command: pluginPath,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `opencode-session:${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith("opencode-session:") ? ref.slice("opencode-session:".length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    return opencodeTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runOpenCode(input);
  },
};

function opencodeTranscriptToMarkdown(transcript: string): string {
  const metadata: Record<string, string> = {};
  const messages: SessionTranscriptMessage[] = [];

  for (const event of parseTranscriptEvents(transcript)) {
    copyStringField(metadata, event, "sessionID", "session_id");
    copyStringField(metadata, event, "sessionId", "session_id");
    copyStringField(metadata, event, "session_id", "session_id");
    copyStringField(metadata, event, "id", "session_id");
    copyStringField(metadata, event, "cwd", "cwd");
    copyStringField(metadata, event, "directory", "cwd");

    const message = messageFromEvent(event);
    if (message !== undefined) messages.push(message);
  }

  return renderSessionTranscriptMarkdown({ metadata, messages });
}

function parseTranscriptEvents(transcript: string): Record<string, unknown>[] {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return [];

  const parsedJson = parseJsonLine(trimmed);
  if (Array.isArray(parsedJson)) return parsedJson.filter(isRecord);
  if (isRecord(parsedJson)) return [parsedJson];

  return transcript
    .split("\n")
    .map(parseJsonLine)
    .filter(isRecord);
}

function messageFromEvent(event: Record<string, unknown>): SessionTranscriptMessage | undefined {
  const source = isRecord(event.message) ? event.message : event;
  const role = roleFromValue(source.role ?? event.role ?? event.type);
  if (role === undefined) return undefined;

  const message = extractText(source.content ?? source.text ?? source.message ?? event.content ?? event.text);
  const sanitizedMessage = sanitizeTranscriptMessage(message);
  if (sanitizedMessage.length === 0) return undefined;

  return {
    timestamp: stringValue(event.time ?? event.timestamp ?? source.time ?? source.timestamp),
    role,
    phase: stringValue(event.type),
    message: sanitizedMessage,
  };
}

function roleFromValue(value: unknown): SessionTranscriptMessage["role"] | undefined {
  if (value === "user" || value === "human") return "human";
  if (value === "assistant" || value === "agent") return "agent";
  return undefined;
}

function extractText(value: unknown): string {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runOpenCode(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    const child = spawn("opencode", ["run", input.prompt], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    child.once("error", (error) => {
      transcript.end();
      reject(error);
    });
    child.stdout.pipe(transcript);
    child.once("close", (exitCode, signal) => {
      transcript.end();
      writeFileSync(
        input.finalMessagePath,
        `OpenCode update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve();
    });
  });
}

function opencodePluginSource(command: string): string {
  return `import { spawn } from "node:child_process";

export const GreplicaPlugin = async ({ directory }) => {
  return {
    event: async ({ event }) => {
      if (process.env.GREPLICA_HOOK_DISABLE === "1") return;
      if (!event || typeof event.type !== "string") return;

      const hookEventName = hookEventNameFor(event.type);
      if (hookEventName === undefined) return;

      const payload = {
        hook_event_name: hookEventName,
        session_id: sessionIdFromEvent(event),
        cwd: cwdFromEvent(event, directory),
        transcript_path: transcriptPathFromEvent(event),
      };

      await runHook(${JSON.stringify(command)}, payload);
    },
  };
};

function hookEventNameFor(type) {
  if (type === "session.updated") return "UserPromptSubmit";
  if (type === "session.idle") return "Stop";
  return undefined;
}

function sessionIdFromEvent(event) {
  return stringValue(event.sessionID)
    ?? stringValue(event.sessionId)
    ?? stringValue(event.session_id)
    ?? stringValue(event.session?.id)
    ?? stringValue(event.properties?.sessionID)
    ?? stringValue(event.properties?.sessionId)
    ?? stringValue(event.properties?.session_id);
}

function transcriptPathFromEvent(event) {
  return stringValue(event.transcript_path)
    ?? stringValue(event.transcriptPath)
    ?? stringValue(event.session?.transcript_path)
    ?? stringValue(event.session?.transcriptPath)
    ?? stringValue(event.properties?.transcript_path)
    ?? stringValue(event.properties?.transcriptPath);
}

function cwdFromEvent(event, directory) {
  return stringValue(event.cwd)
    ?? stringValue(event.directory)
    ?? stringValue(event.properties?.cwd)
    ?? stringValue(event.properties?.directory)
    ?? directory;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runHook(command, payload) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });

    child.once("error", () => resolve());
    child.once("close", () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}
`;
}
