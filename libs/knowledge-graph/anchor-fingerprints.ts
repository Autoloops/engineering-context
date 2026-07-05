import type { AnchorFingerprintRow } from "../storage/sqlite/repository.js";
import type { AnchorCheck } from "./code-anchors/freshness.js";
import { hashAnchorSpan, statAnchorFile } from "./code-anchors/span-hash.js";
import type { ResolvedCodeAnchor } from "./code-anchors/types.js";

/** Fingerprints for one claim, keyed by anchor identity (see {@link anchorKey}). */
type StoredByAnchor = Map<string, AnchorFingerprintRow>;

/** Stable map key for an anchor's identity; `''` symbol matches the storage sentinel. */
function anchorKey(file: string, symbol: string | null | undefined): string {
  return JSON.stringify([file, symbol ?? ""]);
}

/**
 * Group stored fingerprint rows into `claim_id -> (anchorKey -> row)` so the
 * foreground can look up a claim's baseline hashes in O(1) after one batched read.
 */
export function indexFingerprintsByClaim(rows: AnchorFingerprintRow[]): Map<string, StoredByAnchor> {
  const byClaim = new Map<string, StoredByAnchor>();
  for (const row of rows) {
    let byAnchor = byClaim.get(row.claim_id);
    if (byAnchor === undefined) {
      byAnchor = new Map();
      byClaim.set(row.claim_id, byAnchor);
    }
    byAnchor.set(anchorKey(row.file, row.symbol), row);
  }
  return byClaim;
}

/**
 * Build the `AnchorCheck[]` for one claim's resolved anchors, applying the stat
 * prefilter (cache-aside): when the file's mtime+size still match the stored
 * fingerprint, reuse the stored hash instead of re-reading and re-hashing the span.
 * `stored` is that claim's slice of {@link indexFingerprintsByClaim}.
 */
export function freshnessChecks(
  resolved: ResolvedCodeAnchor[],
  stored: StoredByAnchor | undefined,
  repoRoot: string | undefined,
): AnchorCheck[] {
  return resolved.map((anchor) => {
    const row = stored?.get(anchorKey(anchor.file, anchor.symbol));
    return {
      anchor,
      storedHash: row?.content_hash,
      currentHash: currentSpanHash(anchor, row, repoRoot),
    };
  });
}

/** The span's hash right now — reused from the fingerprint when the file is untouched. */
function currentSpanHash(
  anchor: ResolvedCodeAnchor,
  row: AnchorFingerprintRow | undefined,
  repoRoot: string | undefined,
): string | undefined {
  if (row !== undefined && fileUntouched(row, repoRoot, anchor.file)) {
    return row.content_hash; // cache hit: skip the re-read + re-hash
  }
  return hashAnchorSpan(repoRoot, anchor);
}

/** True when the file's mtime+size still match the stored fingerprint (the stat prefilter). */
function fileUntouched(row: AnchorFingerprintRow, repoRoot: string | undefined, file: string): boolean {
  const stat = statAnchorFile(repoRoot, file);
  return stat.mtime_ms === row.file_mtime_ms && stat.size === row.file_size;
}
