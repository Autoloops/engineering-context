import { execFileSync } from "node:child_process";

/** Run a git command in `repoRoot`, returning stdout, or `undefined` on any failure. */
function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/**
 * Current HEAD commit SHA for `repoRoot`, or `undefined` when unavailable (no root,
 * not a git repo, git not installed). Best-effort: a provenance hint on memory
 * writes, never a hard requirement.
 */
export function gitHeadSha(repoRoot: string | undefined): string | undefined {
  if (repoRoot === undefined) return undefined;
  const sha = git(repoRoot, ["rev-parse", "HEAD"])?.trim();
  return sha !== undefined && sha.length > 0 ? sha : undefined;
}

/**
 * Repo-relative paths changed since `sinceSha`: the union of committed changes
 * (`git diff --name-only <sinceSha>..HEAD`) and uncommitted working-tree changes
 * (`git status --porcelain`). The second half is what lets a caller catch edits
 * that haven't been committed yet — the SHA-gate's blind spot.
 *
 * Returns `undefined` when the git probe fails (no repo, bad sha) — distinct from
 * `[]` (nothing changed) — so the caller can full-sweep instead of silently
 * skipping every claim.
 */
export function changedFilesSince(repoRoot: string | undefined, sinceSha: string | undefined): string[] | undefined {
  if (repoRoot === undefined) return undefined;
  const committed = sinceSha === undefined ? [] : gitLines(repoRoot, ["diff", "--name-only", `${sinceSha}..HEAD`]);
  const uncommitted = gitLines(repoRoot, ["status", "--porcelain"]);
  if (committed === undefined || uncommitted === undefined) return undefined;
  return [...new Set([...committed, ...uncommitted.map(porcelainPath)])];
}

function gitLines(repoRoot: string, args: string[]): string[] | undefined {
  const out = git(repoRoot, args);
  if (out === undefined) return undefined;
  return out.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/** Extract the path from a `git status --porcelain` line (rename shows `old -> new`). */
function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}
