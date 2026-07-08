import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SessionConfig } from "../config/greplica-config.js";
import type { InstallPlatform } from "../install/paths.js";
import type { AgentSession, ClaimedMemoryUpdateAttempt, MarkMemoryCurrentInput, RecordHookInput, RecordHookResult } from "./types.js";

const defaultStopThreshold = 7;
const defaultTimeThresholdMinutes = 40;
const defaultCurrentGraceMinutes = 5;

export class HookSessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionConfig?: SessionConfig,
  ) {}

  recordHook(input: RecordHookInput): RecordHookResult {
    const now = iso(input.now);
    const sessionId = input.sessionId ?? fallbackSessionId(input);
    const existing = this.find(input.platform, sessionId);
    const shouldInjectGuidance = isGuidanceEvent(input.platform, input.eventName) && existing?.guidance_injected_at == null;
    const incrementStop = input.eventName === "Stop" ? 1 : 0;

    if (existing === undefined) {
      const session: AgentSession = {
        platform: input.platform,
        session_id: sessionId,
        repo_id: input.repoId,
        transcript_path: input.transcriptPath ?? null,
        cwd: input.cwd ?? null,
        guidance_injected_at: shouldInjectGuidance ? now : null,
        stops_since_memory_current: incrementStop,
        last_seen_at: now,
        last_memory_current_at: null,
      };
      this.insert(session);
      return { session, shouldInjectGuidance };
    }

    const session: AgentSession = {
      ...existing,
      repo_id: input.repoId,
      transcript_path: input.transcriptPath ?? existing.transcript_path,
      cwd: input.cwd ?? existing.cwd,
      guidance_injected_at: shouldInjectGuidance ? now : existing.guidance_injected_at,
      stops_since_memory_current: existing.stops_since_memory_current + incrementStop,
      last_seen_at: now,
    };
    this.updateSessionState(session);
    return { session, shouldInjectGuidance };
  }

  claimDueMemoryUpdateAttempts(now = new Date()): ClaimedMemoryUpdateAttempt[] {
    return this.db.transaction((claimedAt: Date) => {
      const sessions = this.listSessions();
      const claimed: ClaimedMemoryUpdateAttempt[] = [];

      for (const session of sessions) {
        const reason = shouldAttemptUpdate(session, claimedAt, this.sessionConfig);
        if (reason === undefined) continue;
        claimed.push({ session, reason });
      }

      return claimed;
    })(now) as ClaimedMemoryUpdateAttempt[];
  }

  markMemoryCurrent(input: MarkMemoryCurrentInput): boolean {
    if (input.sessionId === undefined || input.sessionId.length === 0) return false;
    const updated = this.db
      .prepare(
        `UPDATE agent_sessions
         SET last_memory_current_at = ?,
             stops_since_memory_current = 0
         WHERE repo_id = ? AND platform = ? AND session_id = ?`,
      )
      .run(iso(input.now), input.repoId, input.platform, input.sessionId);
    return updated.changes > 0;
  }

  private find(platform: InstallPlatform, sessionId: string): AgentSession | undefined {
    return this.db
      .prepare("SELECT * FROM agent_sessions WHERE platform = ? AND session_id = ?")
      .get(platform, sessionId) as AgentSession | undefined;
  }

  private listSessions(): AgentSession[] {
    return this.db.prepare("SELECT * FROM agent_sessions").all() as AgentSession[];
  }

  private insert(session: AgentSession): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (
          platform, session_id, repo_id, transcript_path, cwd, guidance_injected_at,
          stops_since_memory_current, last_seen_at, last_memory_current_at
        ) VALUES (
          @platform, @session_id, @repo_id, @transcript_path, @cwd, @guidance_injected_at,
          @stops_since_memory_current, @last_seen_at, @last_memory_current_at
        )`,
      )
      .run(session);
  }

  private updateSessionState(session: AgentSession): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
         SET repo_id = @repo_id,
             transcript_path = @transcript_path,
             cwd = @cwd,
             guidance_injected_at = @guidance_injected_at,
             stops_since_memory_current = @stops_since_memory_current,
             last_seen_at = @last_seen_at
         WHERE platform = @platform AND session_id = @session_id`,
      )
      .run(session);
  }
}

export function shouldAttemptUpdate(
  session: AgentSession,
  now = new Date(),
  config?: SessionConfig,
): ClaimedMemoryUpdateAttempt["reason"] | undefined {
  const thresholds = sessionThresholds(config);

  if (session.stops_since_memory_current >= thresholds.stopAttemptInterval) {
    return "stop_threshold";
  }

  const lastCurrentAt = parseTime(session.last_memory_current_at);
  const lastSeenAt = parseTime(session.last_seen_at);
  if (lastSeenAt === undefined) return undefined;

  if (lastCurrentAt === undefined) {
    return now.getTime() - lastSeenAt.getTime() >= thresholds.timeAttemptIntervalMs
      ? "time_threshold"
      : undefined;
  }

  if (lastSeenAt.getTime() <= lastCurrentAt.getTime() + thresholds.memoryCurrentGraceMs) return undefined;
  return now.getTime() - lastCurrentAt.getTime() >= thresholds.timeAttemptIntervalMs ? "time_threshold" : undefined;
}

function sessionThresholds(config: SessionConfig | undefined): {
  stopAttemptInterval: number;
  timeAttemptIntervalMs: number;
  memoryCurrentGraceMs: number;
} {
  return {
    stopAttemptInterval: config?.stopThreshold ?? defaultStopThreshold,
    timeAttemptIntervalMs: (config?.timeThresholdMinutes ?? defaultTimeThresholdMinutes) * 60 * 1000,
    memoryCurrentGraceMs: (config?.currentGraceMinutes ?? defaultCurrentGraceMinutes) * 60 * 1000,
  };
}

function fallbackSessionId(input: RecordHookInput): string {
  const identity = `${input.platform}:${input.repoId}:${input.transcriptPath ?? ""}:${input.cwd ?? ""}`;
  const hash = createHash("sha1").update(identity).digest("hex").slice(0, 16);
  return `unknown_${hash}`;
}

function isGuidanceEvent(platform: InstallPlatform, eventName: string | undefined): boolean {
  if (platform === "copilot") return eventName === "SessionStart";
  return eventName === "UserPromptSubmit";
}

function iso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function parseTime(value: string | null): Date | undefined {
  if (value === null) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
