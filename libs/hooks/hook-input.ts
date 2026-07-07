import type { HookInput } from "./types.js";
export type { HookInput } from "./types.js";

export function readHookInput(stdin: string): HookInput {
  const trimmed = stdin.trim();
  if (trimmed.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  return isRecord(parsed) ? parsed : {};
}

export function hookEventName(hook: HookInput): string | undefined {
  const raw = stringField(hook.hook_event_name) ?? stringField(hook.hookEventName) ?? stringField(hook.event_type);
  return raw === undefined ? undefined : normalizeHookEventName(raw);
}

export function hookCwd(hook: HookInput): string | undefined {
  return stringField(hook.cwd) ?? stringField(hook.working_dir) ?? normalizeWorkspaceRoot(firstStringInArray(hook.workspace_roots));
}

// Cursor reports Windows workspace roots as URI-style paths like "/c:/Users/...".
// Strip the leading slash so the path resolves as a real filesystem path.
function normalizeWorkspaceRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^\/([A-Za-z]:[/\\].*)$/.exec(value);
  return match ? match[1] : value;
}

export function hookSessionId(hook: HookInput): string | undefined {
  return stringField(hook.session_id) ?? stringField(hook.sessionId) ?? stringField(hook.conversation_id);
}

export function hookTranscriptPath(hook: HookInput): string | undefined {
  return stringField(hook.transcript_path) ?? stringField(hook.transcriptPath);
}

// Cursor names its lifecycle hooks differently; map them to the canonical
// Greplica events so session tracking and the stop counter work unchanged.
function normalizeHookEventName(raw: string): string {
  if (raw === "beforeSubmitPrompt") return "UserPromptSubmit";
  if (raw === "stop") return "Stop";
  return raw;
}

function firstStringInArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const found = stringField(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
