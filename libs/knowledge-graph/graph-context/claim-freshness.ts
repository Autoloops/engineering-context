import type { SqliteRepository } from "../../storage/sqlite/repository.js";
import { freshnessChecks, indexFingerprintsByClaim } from "../anchor-fingerprints.js";
import { classifyFreshness } from "../code-anchors/freshness.js";
import type { ClaimContextResult } from "./types.js";

/**
 * Attach a freshness verdict to each selected claim (read-only, per query).
 *
 * One batched fingerprint read for all claims (no N+1), then per claim a
 * stat-prefiltered set of anchor checks fed to the shared `classifyFreshness`.
 * Returns new result objects — it never mutates its inputs and never writes to
 * the graph; persistence is the background heal's job.
 */
export function attachFreshness(
  claims: Omit<ClaimContextResult, "freshness">[],
  repository: Pick<SqliteRepository, "fingerprintsForClaims">,
  repoRoot: string | undefined,
): ClaimContextResult[] {
  if (claims.length === 0) return [];
  const storedByClaim = indexFingerprintsByClaim(
    repository.fingerprintsForClaims(claims.map((claim) => claim.object.id)),
  );
  return claims.map((claim) => ({
    ...claim,
    freshness: classifyFreshness(freshnessChecks(claim.code_anchors, storedByClaim.get(claim.object.id), repoRoot)),
  }));
}
