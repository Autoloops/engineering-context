import type { Claim } from "../claim.js";
import { CodeAnchorResolver } from "./resolver.js";
import { classifyFreshness } from "./freshness.js";
import type { ResolvedCodeAnchor } from "./types.js";

/** A code_verified claim whose anchors have all stopped resolving. */
export interface DriftedClaim {
  claim: Claim;
  broken: ResolvedCodeAnchor[];
}

/** A claim that could not be re-resolved (unexpected resolver failure), recorded but not fatal. */
export interface DriftScanError {
  claim_id: string;
  message: string;
}

export interface DriftScanResult {
  drifted: DriftedClaim[];
  errors: DriftScanError[];
}

/**
 * Re-resolves every `code_verified` claim's anchors against the current working
 * tree and reports which claims have fully drifted.
 *
 * Policy (Option A): a claim drifts only when it has anchors and *every* anchor
 * is broken. If any anchor still resolves — or is inconclusive, e.g.
 * `unsupported_language` — the claim keeps its `code_verified` standing.
 *
 * Resilient: a resolver failure on one claim is recorded in `errors` and
 * skipped, never fatal to the pass. Cache-friendly: a single shared
 * `CodeAnchorResolver` parses each file once even when many claims anchor it.
 */
export async function scanDriftedClaims(
  repoRoot: string | undefined,
  claims: Claim[],
): Promise<DriftScanResult> {
  const resolver = new CodeAnchorResolver();
  const drifted: DriftedClaim[] = [];
  const errors: DriftScanError[] = [];

  for (const claim of claims) {
    const anchors = claim.code_anchors ?? [];
    if (claim.truth !== "code_verified" || anchors.length === 0) continue;

    try {
      const resolved = await resolver.resolveMany(repoRoot, anchors);
      // Structural-only detection: no stored hashes, so only "every anchor broken" trips.
      const checks = resolved.map((anchor) => ({ anchor, currentHash: undefined, storedHash: undefined }));
      const verdict = classifyFreshness(checks);
      if (verdict.state === "stale") drifted.push({ claim, broken: verdict.broken });
    } catch (error) {
      errors.push({ claim_id: claim.id, message: errorMessage(error) });
    }
  }

  return { drifted, errors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error resolving code anchors.";
}
