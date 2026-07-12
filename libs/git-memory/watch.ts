import { execFileSync } from "node:child_process";
import type { KnowledgeGraphService, RepoRef, StaleAnchorReviewResult } from "../knowledge-graph/service.js";
import type { SqliteRepository } from "../storage/sqlite/repository.js";

export interface GitWatchOptions {
  anchorThresholdDays: number;
  now?: Date;
}

export interface GitWatchCheckResult extends StaleAnchorReviewResult {
  head: string;
  changed_files: string[];
  full_audit: boolean;
  skipped: boolean;
}

export async function runGitWatchCheck(
  repoRoot: string,
  repoRef: RepoRef,
  service: KnowledgeGraphService,
  repository: SqliteRepository,
  options: GitWatchOptions,
): Promise<GitWatchCheckResult> {
  const initialized = service.requireRepo(repoRef);
  const state = repository.getGitWatchState(initialized.repo_id);
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const now = options.now ?? new Date();
  let fullAudit = state === undefined || fullAuditDue(state.last_full_audit_at, now, options.anchorThresholdDays);
  const changedFilesResult = state === undefined || state.last_head === head
    ? []
    : changedFilesSince(repoRoot, state.last_head, head);
  if (changedFilesResult === undefined) fullAudit = true;
  const changedFiles = changedFilesResult ?? [];
  if (!fullAudit && changedFiles.length === 0) {
    return { head, changed_files: [], full_audit: false, skipped: true, audited_claims: 0, marked_claims: 0 };
  }

  const reviewed = await service.markStaleAnchors(repoRef, {
    changedFiles: fullAudit ? undefined : new Set(changedFiles),
    head,
  });
  repository.upsertGitWatchState({
    repo_id: initialized.repo_id,
    last_head: head,
    last_full_audit_at: fullAudit ? now.toISOString() : (state?.last_full_audit_at ?? null),
    updated_at: now.toISOString(),
  });
  return {
    ...reviewed,
    head,
    changed_files: changedFiles,
    full_audit: fullAudit,
    skipped: false,
  };
}

export function gitHead(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

function changedFilesSince(repoRoot: string, previousHead: string, head: string): string[] | undefined {
  try {
    return git(repoRoot, ["diff", "--name-only", `${previousHead}..${head}`])
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter((file) => file.length > 0);
  } catch {
    return undefined;
  }
}

function fullAuditDue(lastAuditAt: string | null, now: Date, thresholdDays: number): boolean {
  if (lastAuditAt === null) return true;
  const parsed = new Date(lastAuditAt);
  if (Number.isNaN(parsed.getTime())) return true;
  return now.getTime() - parsed.getTime() >= thresholdDays * 24 * 60 * 60 * 1000;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
