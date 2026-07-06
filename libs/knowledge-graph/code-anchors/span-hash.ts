import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { ResolvedCodeAnchor } from "./types.js";

export interface FileStat {
  mtime_ms: number;
  size: number;
}

/**
 * SHA-256 of the anchored span's source text — the content fingerprint.
 *
 * Hashes just the `start_line..end_line` range when the resolver pinned a symbol,
 * otherwise the whole file. Returns `undefined` when the file cannot be read
 * (missing, an absolute path, or escaping the repo) so callers degrade gracefully
 * rather than throwing into a query or heal pass.
 */
export function hashAnchorSpan(repoRoot: string | undefined, anchor: ResolvedCodeAnchor): string | undefined {
  const text = readRepoFile(repoRoot, anchor.file);
  if (text === undefined) return undefined;
  return createHash("sha256").update(spanText(text, anchor.start_line, anchor.end_line)).digest("hex");
}

/** Cheap `stat` used as the freshness prefilter; zeros when the file is unavailable. */
export function statAnchorFile(repoRoot: string | undefined, file: string): FileStat {
  const abs = resolveWithinRepo(repoRoot, file);
  if (abs === undefined) return { mtime_ms: 0, size: 0 };
  try {
    const stat = statSync(abs);
    return { mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtime_ms: 0, size: 0 };
  }
}

function readRepoFile(repoRoot: string | undefined, file: string): string | undefined {
  const abs = resolveWithinRepo(repoRoot, file);
  if (abs === undefined) return undefined;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The canonical absolute path for a repo-relative `file`, or `undefined` if it
 * escapes the repo — via a literal `..`/absolute path OR a symlink that resolves
 * outside `repoRoot` (realpath containment, stronger than a pure-path check).
 */
function resolveWithinRepo(repoRoot: string | undefined, file: string): string | undefined {
  if (repoRoot === undefined || isAbsolute(file) || file.split(/[\\/]/).includes("..")) return undefined;
  try {
    const root = realpathSync(repoRoot);
    const abs = realpathSync(join(root, file));
    return abs === root || abs.startsWith(root + sep) ? abs : undefined;
  } catch {
    return undefined; // missing file or broken symlink
  }
}

function spanText(fileText: string, startLine: number | undefined, endLine: number | undefined): string {
  // Normalize CRLF/CR to LF (matching the resolver's `split(/\r?\n/)`) so a
  // cross-platform checkout doesn't hash a trailing \r into every line and
  // report false content drift.
  const lines = fileText.split(/\r?\n/);
  if (startLine === undefined) return lines.join("\n");
  // Anchor lines are 1-based and inclusive; slice() wants a 0-based [start, end) range,
  // so start-1 and an exclusive end of endLine keeps the [startLine..endLine] rows.
  const start = Math.max(0, startLine - 1);
  const end = endLine ?? startLine;
  return lines.slice(start, end).join("\n");
}
