import { invalidationResolverStatuses } from "../invalidation.js";
import type { ResolvedCodeAnchor, ResolvedCodeAnchorStatus } from "./types.js";

export type FreshnessState = "fresh" | "stale";
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
 * Otherwise it is fresh. Missing hashes (no baseline yet, or an unreadable file) never
 * count as content drift, so freshness never produces a false "stale".
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

  return fresh();
}

function isStructurallyBroken(check: AnchorCheck): boolean {
  return brokenStatuses.has(check.anchor.status);
}

function hasContentDrift(check: AnchorCheck): boolean {
  if (isStructurallyBroken(check)) return false; // handled as structural drift
  if (check.storedHash === undefined || check.currentHash === undefined) return false; // nothing to compare
  return check.currentHash !== check.storedHash;
}

function fresh(): FreshnessVerdict {
  return { state: "fresh", reason: null, broken: [] };
}
