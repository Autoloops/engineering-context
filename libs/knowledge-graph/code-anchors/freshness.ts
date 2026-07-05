import { invalidationResolverStatuses } from "../invalidation.js";
import type { ResolvedCodeAnchor, ResolvedCodeAnchorStatus } from "./types.js";

export type FreshnessState = "fresh" | "stale" | "unknown";
export type FreshnessReason = "structural" | "content";

/** Why a claim is stale, and which anchors are structurally broken. */
export interface FreshnessVerdict {
  state: FreshnessState;
  reason: FreshnessReason | null;
  broken: ResolvedCodeAnchor[];
}

/** One anchor together with its span hash now and the last time we verified the claim. */
export interface AnchorCheck {
  anchor: ResolvedCodeAnchor;
  currentHash: string | undefined; // hash of the span right now (undefined if unreadable)
  storedHash: string | undefined; // hash recorded when the claim was last verified
}

const brokenStatuses: ReadonlySet<ResolvedCodeAnchorStatus> = new Set(invalidationResolverStatuses);

/**
 * The single fresh/stale rule, shared by the foreground signal and the background heal.
 *
 * A claim is stale when either kind of drift has happened:
 *  - **structural** — every anchor stopped resolving (symbol moved / renamed / deleted);
 *  - **content** — a still-resolving anchor's span changed since we last verified it.
 *
 * When no drift is proven but a resolving anchor's span can't be hashed right now
 * (unreadable file / resolver error), the verdict is **unknown** rather than a false
 * "fresh" — the caller distrusts it lightly instead of vouching for it. A missing
 * baseline alone (span readable, no stored hash) stays fresh.
 */
export function classifyFreshness(checks: AnchorCheck[]): FreshnessVerdict {
  if (checks.length === 0) return fresh();

  const broken = checks.filter(isStructurallyBroken).map((check) => check.anchor);
  if (broken.length === checks.length) {
    return { state: "stale", reason: "structural", broken };
  }

  if (checks.some(hasContentDrift)) {
    // Content drift wins the reason, but still surface any anchors that broke
    // structurally in the same claim so the caller can act on them too.
    return { state: "stale", reason: "content", broken };
  }

  if (checks.some(isUndeterminable)) {
    // Freshness can't be proven, but still surface any anchors that broke
    // structurally in the same claim (consistent with the content branch).
    return { state: "unknown", reason: null, broken };
  }

  return fresh();
}

function isStructurallyBroken(check: AnchorCheck): boolean {
  return brokenStatuses.has(check.anchor.status);
}

/** A still-resolving anchor whose current span hash could not be computed. */
function isUndeterminable(check: AnchorCheck): boolean {
  return !isStructurallyBroken(check) && check.currentHash === undefined;
}

function hasContentDrift(check: AnchorCheck): boolean {
  if (isStructurallyBroken(check)) return false; // handled as structural drift
  if (check.storedHash === undefined || check.currentHash === undefined) return false; // nothing to compare
  return check.currentHash !== check.storedHash;
}

function fresh(): FreshnessVerdict {
  return { state: "fresh", reason: null, broken: [] };
}
