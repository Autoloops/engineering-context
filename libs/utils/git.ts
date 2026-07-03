import { execFileSync } from "node:child_process";

/**
 * Returns the current HEAD commit SHA for `repoRoot`, or `undefined` when it is
 * unavailable (no root, not a git repo, or git not installed). Best-effort: the
 * SHA is a provenance hint on memory writes, never a hard requirement.
 */
export function gitHeadSha(repoRoot: string | undefined): string | undefined {
  if (repoRoot === undefined) return undefined;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
