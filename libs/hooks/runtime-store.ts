import type Database from "better-sqlite3";
import type { SessionConfig } from "../config/greplica-config.js";
import type { InstallPlatform } from "../install/paths.js";
import {
  canScheduleMemoryUpdates,
  RepoInstallationStore,
  type RepoInstallation,
} from "../install/repo-installation-store.js";
import type { RepoRef } from "../knowledge-graph/service.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { HookSessionStore, shouldAttemptUpdate } from "./session-state.js";
import type { AgentSession, ClaimedMemoryUpdateAttempt, RecordHookResult } from "./types.js";

export interface RecordHookEventInput {
  repo: RepoRef;
  platform: InstallPlatform;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  eventName?: string;
}

export interface RuntimeHookResult extends RecordHookResult {
  installation: RepoInstallation;
}

export class LocalAgentRuntimeStore {
  private readonly installations: RepoInstallationStore;
  private readonly sessions: HookSessionStore;

  constructor(
    private readonly db: Database.Database = openDatabase(),
    private readonly sessionConfig?: SessionConfig,
    private readonly ownsDatabase = false,
  ) {
    this.installations = new RepoInstallationStore(db);
    this.sessions = new HookSessionStore(db, sessionConfig);
  }

  recordHook(input: RecordHookEventInput): RuntimeHookResult | undefined {
    const installation = this.installations.find(input.repo);
    if (installation === undefined || installation.status !== "active" || !installation.hooksEnabled) return undefined;
    const result = this.sessions.recordHook({
      platform: input.platform,
      repoId: installation.id,
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      cwd: input.cwd,
      eventName: input.eventName,
    });
    return { ...result, installation };
  }

  claimDueMemoryUpdateAttempts(now = new Date()): ClaimedMemoryUpdateAttempt[] {
    const sessions = this.db
      .prepare(
        `SELECT agent_sessions.*
         FROM agent_sessions
         JOIN repos ON repos.id = agent_sessions.repo_id
         WHERE repos.status = 'active'
           AND repos.hooks_enabled = 1
           AND repos.auto_memory_updates = 1
           AND (
             repos.active_mode = 'local'
             OR (
               repos.active_mode = 'managed'
               AND repos.managed_role = 'memory_admin'
               AND repos.managed_access_status = 'active'
             )
           )
         ORDER BY agent_sessions.last_seen_at, agent_sessions.platform, agent_sessions.session_id`,
      )
      .all() as AgentSession[];
    const due: ClaimedMemoryUpdateAttempt[] = [];
    for (const session of sessions) {
      const reason = shouldAttemptUpdate(session, now, this.sessionConfig);
      if (reason !== undefined) due.push({ session, reason });
    }
    return due;
  }

  markMemoryCurrent(repo: RepoRef, platform: InstallPlatform, sessionId: string | undefined): boolean {
    if (sessionId === undefined || sessionId.length === 0) return false;
    const installation = this.installations.require(repo);
    return this.sessions.markMemoryCurrent({ repoId: installation.id, platform, sessionId });
  }

  shouldSchedule(installation: RepoInstallation): boolean {
    return canScheduleMemoryUpdates(installation);
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}

export function createLocalAgentRuntimeStore(sessionConfig?: SessionConfig): LocalAgentRuntimeStore {
  return new LocalAgentRuntimeStore(openDatabase(), sessionConfig, true);
}
