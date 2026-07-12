import type { EdgeId, GraphObjectType } from "./schema.js";

export type EdgeKind =
  | "about"
  | "contains"
  | "touches"
  | "supersedes"
  | "evidenced_by"
  | "needs_review";

export type EdgeMetadata = Record<string, unknown>;

export interface Edge {
  id: EdgeId;
  from_id: string;
  from_type: GraphObjectType;
  to_id: string;
  to_type: GraphObjectType;
  kind: EdgeKind;
  metadata?: EdgeMetadata;
}

export function isAllowedEdge(
  edge: Pick<Edge, "from_id" | "from_type" | "to_id" | "to_type" | "kind">,
): boolean {
  switch (edge.kind) {
    case "about":
      return edge.from_type === "claim" && (edge.to_type === "component" || edge.to_type === "flow");

    case "contains":
      return (
        (edge.from_type === "component" && edge.to_type === "component") ||
        (edge.from_type === "flow" && edge.to_type === "flow")
      );

    case "touches":
      return edge.from_type === "flow" && edge.to_type === "component";

    case "supersedes":
      return (
        edge.from_type === edge.to_type &&
        (edge.from_type === "component" || edge.from_type === "flow" || edge.from_type === "claim")
      );

    case "evidenced_by":
      return edge.from_type === "claim" && edge.to_type === "source";

    case "needs_review":
      return edge.from_type === "claim" && edge.to_type === "claim" && edge.from_id === edge.to_id;
  }
}
