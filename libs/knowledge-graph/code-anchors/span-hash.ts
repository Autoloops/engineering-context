import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
  if (repoRoot === undefined || !isRepoRelative(file)) return { mtime_ms: 0, size: 0 };
  try {
    const stat = statSync(join(repoRoot, file));
    return { mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtime_ms: 0, size: 0 };
  }
}

function readRepoFile(repoRoot: string | undefined, file: string): string | undefined {
  if (repoRoot === undefined || !isRepoRelative(file)) return undefined;
  try {
    return readFileSync(join(repoRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

function isRepoRelative(file: string): boolean {
  return !isAbsolute(file) && !file.split(/[\\/]/).includes("..");
}

function spanText(fileText: string, startLine: number | undefined, endLine: number | undefined): string {
  if (startLine === undefined) return fileText;
  // Anchor lines are 1-based and inclusive; slice() wants a 0-based [start, end) range,
  // so start-1 and an exclusive end of endLine keeps the [startLine..endLine] rows.
  const lines = fileText.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = endLine ?? startLine;
  return lines.slice(start, end).join("\n");
}
