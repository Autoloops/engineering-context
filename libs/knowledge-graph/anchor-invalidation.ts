import type { Claim, ClaimCodeAnchor } from "./claim.js";
import type { ResolvedCodeAnchor, ResolvedCodeAnchorStatus } from "./code-anchors/types.js";
import type { Edge } from "./edge.js";
import { isInvalidationResolverStatus, type InvalidationEventInput } from "./invalidation.js";
import {
  normalizeProposal,
  type CompactEdge,
  type CompactMemoryProposal,
  type MemoryCommitProposal,
  type ProposalSubjectLookup,
} from "./proposal.js";
import type { GraphObjectType } from "./schema.js";
import type { GraphReadResult } from "./service.js";

/** Suffix that turns an original claim id into its rebuilt (demoted) counterpart. */
const driftSuffix = "__drift";

/**
 * A claim to demote, and why. `reason: "structural"` means every anchor stopped
 * resolving (`anchors` are the broken ones); `reason: "content"` means a still-
 * resolving anchor's span changed (`anchors` are the drifted, resolving ones).
 */
export interface ClaimDemotion {
  claim: Claim;
  reason: "structural" | "content";
  anchors: ResolvedCodeAnchor[];
}

export interface AnchorInvalidationPlan {
  proposal: MemoryCommitProposal;
  events: InvalidationEventInput[];
}

/**
 * Pure translation of demoted claims into the writes that supersede them: for
 * each claim, a rebuilt `truth: unknown` copy (keeping its anchors as evidence),
 * its `about`/`evidenced_by` edges re-pointed at the rebuild, a `supersedes`
 * edge rebuild -> original, and one invalidation event recording the drift kind.
 *
 * No I/O: edge ids are minted by `normalizeProposal` using an in-memory lookup
 * built from the graph, and outgoing edges are read from a `from_id` index built
 * once (O(edges + claims), never O(edges * claims)).
 */
export function buildAnchorInvalidation(demotions: ClaimDemotion[], graph: GraphReadResult): AnchorInvalidationPlan {
  const edgesByFrom = indexEdgesByFrom(graph.edges);

  const claims: Claim[] = [];
  const edges: CompactEdge[] = [];
  const events: InvalidationEventInput[] = [];

  for (const { claim, reason, anchors } of demotions) {
    const supersedingId = `${claim.id}${driftSuffix}`;

    claims.push({
      id: supersedingId,
      kind: claim.kind,
      text: claim.text,
      truth: "unknown",
      intent: claim.intent,
      code_anchors: claim.code_anchors,
    });

    // The original's edges go dead once it is superseded, so clone the ones that
    // keep the claim meaningful onto the rebuild.
    for (const edge of edgesByFrom.get(claim.id) ?? []) {
      if (edge.kind === "about" || edge.kind === "evidenced_by") {
        edges.push({ kind: edge.kind, from: supersedingId, to: edge.to_id, metadata: edge.metadata });
      }
    }
    edges.push({ kind: "supersedes", from: supersedingId, to: claim.id });

    events.push(demotionEvent(claim.id, supersedingId, reason, anchors[0]));
  }

  const proposal: CompactMemoryProposal = {
    title: invalidationTitle(demotions.length),
    creates: { claims, edges },
  };

  return { proposal: normalizeProposal(proposal, graphSubjectLookup(graph)), events };
}

function demotionEvent(
  originalId: string,
  supersedingId: string,
  reason: ClaimDemotion["reason"],
  anchor: ResolvedCodeAnchor,
): InvalidationEventInput {
  return {
    original_claim_id: originalId,
    superseding_claim_id: supersedingId,
    reason: reason === "content" ? "content_drift" : "anchor_drift",
    broken_anchor: formatAnchor(anchor),
    // Structural drift must carry a drift status (guarded); content drift records
    // the anchor's still-resolving status as-is.
    resolver_status: reason === "content" ? anchor.status : assertDriftStatus(anchor),
  };
}

function indexEdgesByFrom(edges: Edge[]): Map<string, Edge[]> {
  const index = new Map<string, Edge[]>();
  for (const edge of edges) {
    const existing = index.get(edge.from_id);
    if (existing) existing.push(edge);
    else index.set(edge.from_id, [edge]);
  }
  return index;
}

function graphSubjectLookup(graph: GraphReadResult): ProposalSubjectLookup {
  const types = new Map<string, GraphObjectType>();
  for (const component of graph.components) types.set(component.id, "component");
  for (const flow of graph.flows) types.set(flow.id, "flow");
  for (const claim of graph.claims) types.set(claim.id, "claim");
  for (const source of graph.sources) types.set(source.id, "source");
  return { subjectType: (id) => types.get(id) };
}

function assertDriftStatus(anchor: ResolvedCodeAnchor): ResolvedCodeAnchorStatus {
  // A structural demotion's anchors only ever carry drift statuses; this guard
  // narrows the type and fails loud if that invariant is ever violated.
  if (!isInvalidationResolverStatus(anchor.status)) {
    throw new Error(`Anchor ${formatAnchor(anchor)} has non-drift status "${anchor.status}".`);
  }
  return anchor.status;
}

function formatAnchor(anchor: ClaimCodeAnchor): string {
  return anchor.symbol === undefined ? anchor.file : `${anchor.file}#${anchor.symbol}`;
}

function invalidationTitle(count: number): string {
  return `Anchor drift invalidation (${count} claim${count === 1 ? "" : "s"})`;
}
