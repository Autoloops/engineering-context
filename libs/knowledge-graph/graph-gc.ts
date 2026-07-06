import type { Edge } from "./edge.js";

export type GcSubjectType = "component" | "flow" | "claim" | "edge";

export interface GcSubjectRef {
  type: GcSubjectType;
  id: string;
}

export interface GcAnchorIssue {
  id: string;
  anchor: string;
}

export interface GcDanglingEdge {
  id: string;
  from: string;
  to: string;
}

export interface GcPrunedCounts {
  components: number;
  flows: number;
  claims: number;
  edges: number;
}

export interface GcReport {
  dry_run: boolean;
  stale_components: GcAnchorIssue[];
  stale_claims: GcAnchorIssue[];
  orphaned_claims: string[];
  orphaned_flows: string[];
  dangling_edges: GcDanglingEdge[];
  pruned: GcPrunedCounts;
}

export interface GcPlanInput {
  components: { id: string }[];
  flows: { id: string }[];
  claims: { id: string }[];
  edges: Edge[];
  /** "type:id" keys for edge endpoints whose object row still exists. */
  existingKeys: ReadonlySet<string>;
  staleComponentIds: readonly string[];
  staleClaimIds: readonly string[];
}

export interface GcPlan {
  /** components/flows/claims to prune. */
  subjects: GcSubjectRef[];
  /** edge ids to prune (dangling + edges attached to a pruned subject). */
  edges: string[];
  orphaned_claims: string[];
  orphaned_flows: string[];
  dangling_edges: GcDanglingEdge[];
  pruned: GcPrunedCounts;
}

function subjectKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Compute what `graph gc` should remove from a single repo's active graph.
 *
 * Detection passes:
 *  - stale anchors: components/claims whose code anchor file no longer exists
 *    (ids supplied by the caller, which owns filesystem access);
 *  - orphaned claims/flows: no edge references them;
 *  - dangling edges: an endpoint object row no longer exists.
 *
 * Pruning a subject cascades to every edge that touches it, so a stale claim's
 * `about`/`evidenced_by` edges are removed in the same pass.
 */
export function planGc(input: GcPlanInput): GcPlan {
  const referenced = new Set<string>();
  for (const edge of input.edges) {
    referenced.add(subjectKey(edge.from_type, edge.from_id));
    referenced.add(subjectKey(edge.to_type, edge.to_id));
  }

  const orphanedClaims = input.claims.filter((claim) => !referenced.has(subjectKey("claim", claim.id))).map((claim) => claim.id);
  const orphanedFlows = input.flows.filter((flow) => !referenced.has(subjectKey("flow", flow.id))).map((flow) => flow.id);

  const danglingEdges: GcDanglingEdge[] = input.edges
    .filter(
      (edge) =>
        !input.existingKeys.has(subjectKey(edge.from_type, edge.from_id)) ||
        !input.existingKeys.has(subjectKey(edge.to_type, edge.to_id)),
    )
    .map((edge) => ({
      id: edge.id,
      from: subjectKey(edge.from_type, edge.from_id),
      to: subjectKey(edge.to_type, edge.to_id),
    }));

  const subjectKeys = new Set<string>();
  const subjects: GcSubjectRef[] = [];
  const addSubject = (type: GcSubjectType, id: string): void => {
    const key = subjectKey(type, id);
    if (subjectKeys.has(key)) return;
    subjectKeys.add(key);
    subjects.push({ type, id });
  };
  for (const id of input.staleComponentIds) addSubject("component", id);
  for (const id of input.staleClaimIds) addSubject("claim", id);
  for (const id of orphanedClaims) addSubject("claim", id);
  for (const id of orphanedFlows) addSubject("flow", id);

  const edgeIds = new Set<string>(danglingEdges.map((edge) => edge.id));
  for (const edge of input.edges) {
    if (subjectKeys.has(subjectKey(edge.from_type, edge.from_id)) || subjectKeys.has(subjectKey(edge.to_type, edge.to_id))) {
      edgeIds.add(edge.id);
    }
  }

  const pruned: GcPrunedCounts = {
    components: subjects.filter((subject) => subject.type === "component").length,
    flows: subjects.filter((subject) => subject.type === "flow").length,
    claims: subjects.filter((subject) => subject.type === "claim").length,
    edges: edgeIds.size,
  };

  return {
    subjects,
    edges: [...edgeIds],
    orphaned_claims: orphanedClaims,
    orphaned_flows: orphanedFlows,
    dangling_edges: danglingEdges,
    pruned,
  };
}
