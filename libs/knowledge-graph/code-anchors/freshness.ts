import { invalidationResolverStatuses } from "../invalidation.js";
import type { ResolvedCodeAnchor, ResolvedCodeAnchorStatus } from "./types.js";

export type FreshnessState = "fresh" | "stale";
export type FreshnessReason = "structural" | "content";

/** The freshness verdict for a claim's anchors — the single fresh/stale rule shared by both planes. */
export interface FreshnessVerdict {
  state: FreshnessState;
  reason: FreshnessReason | null;
  broken: ResolvedCodeAnchor[];
}

const brokenStatuses: ReadonlySet<ResolvedCodeAnchorStatus> = new Set(invalidationResolverStatuses);

/**
 * Decide whether a claim's anchors are still fresh. Pure — no I/O.
 *
 * - Structural drift: the claim has anchors and *every* one is broken (Option A, from #96).
 * - Content drift: at least one anchor still resolves, but its stored span hash no longer
 *   matches the current one.
 *
 * `currentHashes` and `storedHashes` are positional to `resolved`; `undefined` means
 * "no hash available" (e.g. no baseline yet), which never triggers a false stale.
 */
export function classifyFreshness(
  resolved: ResolvedCodeAnchor[],
  currentHashes: ReadonlyArray<string | undefined>,
  storedHashes: ReadonlyArray<string | undefined>,
): FreshnessVerdict {
  if (resolved.length === 0) return fresh();

  const broken = resolved.filter((anchor) => brokenStatuses.has(anchor.status));
  if (broken.length === resolved.length) {
    return { state: "stale", reason: "structural", broken };
  }

  for (let i = 0; i < resolved.length; i += 1) {
    if (brokenStatuses.has(resolved[i].status)) continue;
    const stored = storedHashes[i];
    const current = currentHashes[i];
    if (stored !== undefined && current !== undefined && current !== stored) {
      return { state: "stale", reason: "content", broken: [] };
    }
  }

  return fresh();
}

function fresh(): FreshnessVerdict {
  return { state: "fresh", reason: null, broken: [] };
}
