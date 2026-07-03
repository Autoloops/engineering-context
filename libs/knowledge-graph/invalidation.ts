/**
 * Records why and when a `code_verified` claim was demoted to `truth: unknown`
 * because its code anchor stopped resolving (anchor drift). The claim itself is
 * never mutated — it is superseded by a rebuilt copy — so this table is the
 * queryable audit trail of what went stale.
 */

/** Why a claim was invalidated. Only anchor drift exists today; kept open for future reasons. */
export type InvalidationReason = "anchor_drift";

/**
 * The resolver statuses that count as drift (a subset of ResolvedCodeAnchorStatus).
 * Single source of truth for both detection (drift.ts) and the audit trail.
 */
export const invalidationResolverStatuses = ["missing_file", "missing_symbol", "ambiguous_symbol"] as const;

export type InvalidationResolverStatus = (typeof invalidationResolverStatuses)[number];

export function isInvalidationResolverStatus(status: string): status is InvalidationResolverStatus {
  return (invalidationResolverStatuses as readonly string[]).includes(status);
}

/** A persisted invalidation event, one row per demoted claim. */
export interface InvalidationEvent {
  id: string;
  repo_id: string;
  original_claim_id: string;
  superseding_claim_id: string;
  memory_commit_id: string;
  reason: InvalidationReason;
  broken_anchor: string;
  resolver_status: InvalidationResolverStatus;
  git_commit_sha?: string;
  created_at: string;
}

/**
 * The caller-supplied portion of an invalidation event. The repository stamps
 * `id`, `repo_id`, `memory_commit_id`, `git_commit_sha`, and `created_at` when
 * it writes the batch, so callers only describe what drifted.
 */
export interface InvalidationEventInput {
  original_claim_id: string;
  superseding_claim_id: string;
  reason: InvalidationReason;
  broken_anchor: string;
  resolver_status: InvalidationResolverStatus;
}
