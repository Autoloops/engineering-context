export interface HookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown;
  prompt?: unknown;
  // OpenHands variants of hook_event_name / cwd.
  event_type?: unknown;
  working_dir?: unknown;
  message?: unknown;
}

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
  return stringField(hook.hook_event_name) ?? stringField(hook.event_type);
}

export function hookCwd(hook: HookInput): string | undefined {
  return stringField(hook.cwd) ?? stringField(hook.working_dir);
}

export function hookSessionId(hook: HookInput): string | undefined {
  return stringField(hook.session_id);
}

export function hookTranscriptPath(hook: HookInput): string | undefined {
  return stringField(hook.transcript_path);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
