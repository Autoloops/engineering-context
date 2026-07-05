import { execFileSync } from "node:child_process";

/**
 * The repo-relative paths that changed since `sinceSha`: the union of committed
 * changes (`git diff --name-only <sinceSha>..HEAD`) and uncommitted working-tree
 * changes (`git status --porcelain`). The second half is what lets the heal catch
 * edits that haven't been committed yet — the SHA-gate's blind spot.
 *
 * Returns `undefined` when the git probe fails (no repo, bad sha) — distinct
 * from `[]` (nothing changed) — so the caller can full-sweep instead of
 * silently skipping every claim.
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
  return out === undefined ? undefined : nonEmptyLines(out);
}

/** Extract the path from a `git status --porcelain` line (rename shows `old -> new`). */
function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined;
  }
}

function nonEmptyLines(out: string): string[] {
  return out.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}
