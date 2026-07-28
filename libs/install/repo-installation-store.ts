import type Database from "better-sqlite3";
import type { RepoRef } from "../knowledge-graph/service.js";
import { installCommandSuggestion } from "./paths.js";
import {
  SqliteRepository,
  type ManagedAccessStatus,
  type ManagedRepoRole,
  type RepoMode,
  type RepoRecord,
  type RepoStatus,
} from "../storage/sqlite/repository.js";

export interface RepoInstallation {
  id: string;
  repoKey: string;
  remoteUrl?: string;
  rootPath?: string;
  repoName: string;
  defaultBranch: string;
  status: RepoStatus;
  activeMode: RepoMode;
  managedRepoId?: string;
  managedRole?: ManagedRepoRole;
  managedAccessStatus?: ManagedAccessStatus;
  managedAccessRefreshedAt?: string;
  hooksEnabled: boolean;
  autoMemoryUpdates: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivateRepoOptions {
  hooksEnabled: boolean;
  autoMemoryUpdates: boolean;
  allowModeSwitch?: boolean;
}

export interface ActivateManagedRepoOptions extends ActivateRepoOptions {
  managedRepoId: string;
  managedRole: ManagedRepoRole;
  managedAccessStatus?: ManagedAccessStatus;
  allowRebind?: boolean;
}

export class RepoInstallationStore {
  private readonly repository: SqliteRepository;

  constructor(private readonly db: Database.Database) {
    this.repository = new SqliteRepository(db);
  }

  find(input: RepoRef): RepoInstallation | undefined {
    const row = this.repository.getRepo(input);
    return row === undefined ? undefined : toInstallation(row);
  }

  require(input: RepoRef): RepoInstallation {
    const installation = this.find(input);
    if (installation === undefined || installation.status !== "active") {
      throw new Error(
        `Greplica is not installed for this repo, or its installation is inactive. Run ${installCommandSuggestion} here first.`,
      );
    }
    return installation;
  }

  assertCanActivate(
    input: RepoRef,
    nextMode: RepoMode,
    options: { managedRepoId?: string; allowModeSwitch?: boolean; allowRebind?: boolean } = {},
  ): void {
    const repo = this.repository.getRepo(input);
    if (repo === undefined) return;
    this.assertModeSwitch(repo, nextMode, options.allowModeSwitch === true);
    if (
      nextMode === "managed" &&
      options.managedRepoId !== undefined &&
      repo.managed_repo_id !== null &&
      repo.managed_repo_id !== options.managedRepoId &&
      options.allowRebind !== true
    ) {
      throw new Error("This repository is already bound to another managed memory. Re-run with explicit rebind confirmation.");
    }
  }

  activateLocal(input: RepoRef, options: ActivateRepoOptions): RepoInstallation {
    this.assertCanActivate(input, "local", options);
    const { repo } = this.repository.upsertRepo(input);
    return this.updateActivation(repo.id, {
      status: "active",
      activeMode: "local",
      hooksEnabled: options.hooksEnabled,
      autoMemoryUpdates: options.hooksEnabled && options.autoMemoryUpdates,
    });
  }

  activateManaged(input: RepoRef, options: ActivateManagedRepoOptions): RepoInstallation {
    this.assertCanActivate(input, "managed", options);
    const { repo } = this.repository.upsertRepo(input);
    const refreshedAt = new Date().toISOString();
    return this.updateActivation(repo.id, {
      status: "active",
      activeMode: "managed",
      managedRepoId: options.managedRepoId,
      managedRole: options.managedRole,
      managedAccessStatus: options.managedAccessStatus ?? "active",
      managedAccessRefreshedAt: refreshedAt,
      hooksEnabled: options.hooksEnabled,
      autoMemoryUpdates: options.hooksEnabled && options.autoMemoryUpdates,
    });
  }

  deactivate(input: RepoRef): RepoInstallation {
    const repo = this.repository.requireRepo(input);
    return this.updateActivation(repo.id, { status: "inactive" });
  }

  updateManagedAccess(
    managedRepoId: string,
    role: ManagedRepoRole | undefined,
    accessStatus: ManagedAccessStatus,
    refreshedAt = new Date(),
  ): RepoInstallation[] {
    const before = this.db
      .prepare("SELECT * FROM repos WHERE managed_repo_id = ?")
      .all(managedRepoId) as RepoRecord[];
    this.db
      .prepare(
        `UPDATE repos
         SET managed_role = ?, managed_access_status = ?, managed_access_refreshed_at = ?, updated_at = ?
         WHERE managed_repo_id = ?`,
      )
      .run(role ?? null, accessStatus, refreshedAt.toISOString(), refreshedAt.toISOString(), managedRepoId);

    if (role === "memory_admin" && before.some((row) => row.managed_role !== "memory_admin")) {
      this.db
        .prepare(
          `UPDATE agent_sessions
           SET last_memory_current_at = ?, stops_since_memory_current = 0
           WHERE repo_id IN (SELECT id FROM repos WHERE managed_repo_id = ?)`,
        )
        .run(refreshedAt.toISOString(), managedRepoId);
    }

    return (this.db.prepare("SELECT * FROM repos WHERE managed_repo_id = ?").all(managedRepoId) as RepoRecord[])
      .map(toInstallation);
  }

  invalidateManagedRoleCache(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE repos
         SET managed_role = NULL, managed_access_status = NULL,
             managed_access_refreshed_at = NULL, updated_at = ?
         WHERE managed_repo_id IS NOT NULL`,
      )
      .run(now);
  }

  list(): RepoInstallation[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY repo_name, id").all() as RepoRecord[]).map(toInstallation);
  }

  private assertModeSwitch(repo: RepoRecord, nextMode: RepoMode, allowed: boolean): void {
    if (repo.active_mode !== nextMode && !allowed) {
      throw new Error(
        `This repository is active in ${repo.active_mode} mode. Re-run with explicit mode-switch confirmation to use ${nextMode} mode.`,
      );
    }
  }

  private updateActivation(
    repoId: string,
    update: {
      status?: RepoStatus;
      activeMode?: RepoMode;
      managedRepoId?: string;
      managedRole?: ManagedRepoRole;
      managedAccessStatus?: ManagedAccessStatus;
      managedAccessRefreshedAt?: string;
      hooksEnabled?: boolean;
      autoMemoryUpdates?: boolean;
    },
  ): RepoInstallation {
    const existing = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as RepoRecord | undefined;
    if (existing === undefined) throw new Error(`Repository installation ${repoId} is missing.`);
    const next = {
      id: repoId,
      status: update.status ?? existing.status,
      active_mode: update.activeMode ?? existing.active_mode,
      managed_repo_id: update.managedRepoId ?? existing.managed_repo_id,
      managed_role: update.managedRole ?? existing.managed_role,
      managed_access_status: update.managedAccessStatus ?? existing.managed_access_status,
      managed_access_refreshed_at: update.managedAccessRefreshedAt ?? existing.managed_access_refreshed_at,
      hooks_enabled: update.hooksEnabled === undefined ? existing.hooks_enabled : Number(update.hooksEnabled),
      auto_memory_updates:
        update.autoMemoryUpdates === undefined ? existing.auto_memory_updates : Number(update.autoMemoryUpdates),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE repos
         SET status = @status, active_mode = @active_mode, managed_repo_id = @managed_repo_id,
             managed_role = @managed_role, managed_access_status = @managed_access_status,
             managed_access_refreshed_at = @managed_access_refreshed_at,
             hooks_enabled = @hooks_enabled, auto_memory_updates = @auto_memory_updates,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(next);
    return toInstallation(this.db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as RepoRecord);
  }
}

export function canScheduleMemoryUpdates(installation: RepoInstallation): boolean {
  if (installation.status !== "active" || !installation.hooksEnabled || !installation.autoMemoryUpdates) return false;
  if (installation.activeMode === "local") return true;
  return installation.managedRole === "memory_admin" && installation.managedAccessStatus === "active";
}

function toInstallation(row: RepoRecord): RepoInstallation {
  return {
    id: row.id,
    repoKey: row.repo_key,
    remoteUrl: row.remote_url ?? undefined,
    rootPath: row.root_path ?? undefined,
    repoName: row.repo_name,
    defaultBranch: row.default_branch,
    status: row.status,
    activeMode: row.active_mode,
    managedRepoId: row.managed_repo_id ?? undefined,
    managedRole: row.managed_role ?? undefined,
    managedAccessStatus: row.managed_access_status ?? undefined,
    managedAccessRefreshedAt: row.managed_access_refreshed_at ?? undefined,
    hooksEnabled: row.hooks_enabled === 1,
    autoMemoryUpdates: row.auto_memory_updates === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
