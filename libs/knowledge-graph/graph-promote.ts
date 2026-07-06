export type PromoteSubjectType = "component" | "flow" | "claim" | "edge";

export interface PromoteSubjectRef {
  type: PromoteSubjectType;
  id: string;
}

export interface PromotedCounts {
  components: number;
  flows: number;
  claims: number;
  edges: number;
}

export interface PromoteReport {
  /**
   * The new main-scope memory commit that now owns the promoted subjects, or
   * undefined when the working scope was already empty.
   */
  memory_commit_id: string | undefined;
  promoted: PromotedCounts;
  total: number;
}

/**
 * Tally promoted working memberships by subject type. Pure (no database) so the
 * counting stays unit-testable independently of the SQLite move it summarizes.
 */
export function countPromotedSubjects(refs: readonly PromoteSubjectRef[]): PromotedCounts {
  const counts: PromotedCounts = { components: 0, flows: 0, claims: 0, edges: 0 };
  for (const ref of refs) {
    if (ref.type === "component") counts.components += 1;
    else if (ref.type === "flow") counts.flows += 1;
    else if (ref.type === "claim") counts.claims += 1;
    else counts.edges += 1;
  }
  return counts;
}
