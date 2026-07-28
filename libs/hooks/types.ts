import type { InstallPlatform } from "../install/paths.js";

export interface AgentSession {
  platform: InstallPlatform;
  session_id: string;
  repo_id: string;
  transcript_path: string | null;
  cwd: string | null;
  guidance_injected_at: string | null;
  stops_since_memory_current: number;
  last_seen_at: string;
  last_memory_current_at: string | null;
}

export interface RecordHookInput {
  platform: InstallPlatform;
  sessionId?: string;
  repoId: string;
  transcriptPath?: string;
  cwd?: string;
  eventName?: string;
  now?: Date;
}

export interface RecordHookResult {
  session: AgentSession;
  shouldInjectGuidance: boolean;
}

export interface ClaimedMemoryUpdateAttempt {
  session: AgentSession;
  reason: "stop_threshold" | "time_threshold";
}

export interface MarkMemoryCurrentInput {
  repoId: string;
  platform: InstallPlatform;
  sessionId?: string;
  now?: Date;
}

export interface HookInput {
  session_id?: unknown;
  sessionId?: unknown;
  transcript_path?: unknown;
  transcriptPath?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  hookEventName?: unknown;
  turn_id?: unknown;
  prompt?: unknown;
  // OpenHands variants of hook_event_name / cwd.
  event_type?: unknown;
  working_dir?: unknown;
  message?: unknown;
  // Cursor variants of session_id / cwd.
  conversation_id?: unknown;
  workspace_roots?: unknown;
}
