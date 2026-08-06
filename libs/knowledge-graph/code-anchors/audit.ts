import type { Claim, ClaimCodeAnchor } from "../claim.js";
import { anchorFingerprintKey, fingerprintAnchor } from "./fingerprint.js";
import { CodeAnchorResolver } from "./resolver.js";
import type { ClaimAnchorAuditResult } from "./types.js";

/**
 * Audit each claim's code anchors against the repo. Reports broken anchors
 * (missing file/symbol, etc.) and, when `baselineFingerprints` are supplied,
 * anchors that still resolve but whose code has drifted from the fingerprint
 * stored when the claim was written. Claims with no stored baseline are left
 * unreported rather than assumed drifted.
 */
export async function auditClaimCodeAnchors(
  repoRoot: string | undefined,
  claims: Claim[],
  resolver = new CodeAnchorResolver(),
  baselineFingerprints?: Map<string, Record<string, string>>,
): Promise<ClaimAnchorAuditResult> {
  const result: ClaimAnchorAuditResult = {
    missing_anchors: [],
    missing_files: [],
    missing_symbols: [],
    ambiguous_symbols: [],
    unsupported_languages: [],
    drifted: [],
  };

  for (const claim of claims) {
    if (claim.code_anchors === undefined || claim.code_anchors.length === 0) {
      if (claim.truth !== "code_verified") continue;
      result.missing_anchors.push({ claim_id: claim.id, status: "missing_anchors" });
      continue;
    }

    const baseline = baselineFingerprints?.get(claim.id);
    const resolvedAnchors = await resolver.resolveMany(repoRoot, claim.code_anchors);
    for (const anchor of resolvedAnchors) {
      switch (anchor.status) {
        case "missing_file":
          result.missing_files.push({ claim_id: claim.id, anchor, status: "missing_file" });
          break;
        case "missing_symbol":
          result.missing_symbols.push({ claim_id: claim.id, anchor, status: "missing_symbol" });
          break;
        case "ambiguous_symbol":
          result.ambiguous_symbols.push({ claim_id: claim.id, anchor, status: "ambiguous_symbol" });
          break;
        case "unsupported_language":
          result.unsupported_languages.push({ claim_id: claim.id, anchor, status: "unsupported_language" });
          break;
        case "resolved":
        case "file_only":
          if (await hasDrifted(repoRoot, anchor, resolver, baseline)) {
            result.drifted.push({ claim_id: claim.id, anchor, status: "drifted" });
          }
          break;
      }
    }
  }

  return result;
}

// An anchor has drifted when it has a stored baseline fingerprint and the code
// it currently points to no longer hashes to that baseline.
async function hasDrifted(
  repoRoot: string | undefined,
  anchor: ClaimCodeAnchor,
  resolver: CodeAnchorResolver,
  baseline: Record<string, string> | undefined,
): Promise<boolean> {
  if (baseline === undefined) return false;
  const stored = baseline[anchorFingerprintKey(anchor)];
  if (stored === undefined) return false;
  const current = await fingerprintAnchor(repoRoot, anchor, resolver);
  return current !== undefined && current !== stored;
}
