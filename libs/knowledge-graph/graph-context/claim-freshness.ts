import type { SqliteRepository } from "../../storage/sqlite/repository.js";
import { anchorFingerprintKey, fingerprintAnchor } from "../code-anchors/fingerprint.js";
import { classifyStale, isStructurallyBroken, type AnchorCheck } from "../code-anchors/freshness.js";
import { CodeAnchorResolver } from "../code-anchors/resolver.js";
import type { ResolvedCodeAnchor } from "../code-anchors/types.js";
import type { ClaimContextResult } from "./types.js";

type FingerprintReader = Pick<SqliteRepository, "readClaimAnchorFingerprints">;

export async function attachStaleClaims(
  claims: ClaimContextResult[],
  repository: FingerprintReader,
  repoId: string,
  repoRoot: string | undefined,
  resolver: CodeAnchorResolver,
): Promise<ClaimContextResult[]> {
  const candidates = claims.filter((claim) => claim.object.truth === "code_verified" && claim.code_anchors.length > 0);
  const storedByClaim = repository.readClaimAnchorFingerprints(repoId, candidates.map((claim) => claim.object.id));

  return Promise.all(claims.map(async (claim) => {
    const stored = storedByClaim.get(claim.object.id);
    if (stored === undefined || Object.keys(stored).length === 0) return claim;

    const checks = await staleChecks(claim.code_anchors, stored, repoRoot, resolver);
    const reason = classifyStale(checks);
    return reason === undefined ? claim : { ...claim, freshness: { reason } };
  }));
}

async function staleChecks(
  anchors: ResolvedCodeAnchor[],
  stored: Record<string, string>,
  repoRoot: string | undefined,
  resolver: CodeAnchorResolver,
): Promise<AnchorCheck[]> {
  if (anchors.every(isStructurallyBroken)) {
    return anchors.map((anchor) => ({ anchor, storedHash: stored[anchorFingerprintKey(anchor)], currentHash: undefined }));
  }

  return Promise.all(anchors.map(async (anchor) => {
    const storedHash = stored[anchorFingerprintKey(anchor)];
    const shouldHash = storedHash !== undefined && (anchor.status === "resolved" || anchor.status === "file_only");
    return {
      anchor,
      storedHash,
      currentHash: shouldHash ? await fingerprintAnchor(repoRoot, anchor, resolver) : undefined,
    };
  }));
}
