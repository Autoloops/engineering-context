import type { Claim } from "./claim.js";
import type { Edge, EdgeKind, EdgeMetadata } from "./edge.js";
import type { Component, Flow, GraphObjectType, Source } from "./schema.js";

export interface MemoryCommitProposal {
  title: string;
  summary?: string;
  creates: {
    components?: Component[];
    flows?: Flow[];
    claims?: Claim[];
    sources?: Source[];
    edges?: Edge[];
  };
}

export type CompactComponent = Component & {
  contains?: string | string[];
  supersedes?: string | string[];
};

export type CompactFlow = Flow & {
  contains?: string | string[];
  touches?: string | string[];
  supersedes?: string | string[];
};

export type CompactClaim = Claim & {
  about?: string | string[];
  evidenced_by?: string | string[];
  supersedes?: string | string[];
};

export interface CompactEdge {
  kind: EdgeKind;
  from: string;
  to: string;
  metadata?: EdgeMetadata;
}

export interface CompactMemoryProposal {
  title: string;
  summary?: string;
  creates: {
    components?: CompactComponent[];
    flows?: CompactFlow[];
    claims?: CompactClaim[];
    sources?: Source[];
    edges?: CompactEdge[];
  };
}

export type ProposalSubject =
  | { type: "component"; id: string }
  | { type: "flow"; id: string }
  | { type: "claim"; id: string }
  | { type: "edge"; id: string }
  | { type: "source"; id: string };

export interface ProposalSubjectLookup {
  subjectType(id: string): GraphObjectType | undefined;
}

export function normalizeProposal(input: unknown, lookup?: ProposalSubjectLookup): MemoryCommitProposal {
  if (!isRecord(input)) {
    return input as MemoryCommitProposal;
  }

  const creates = isRecord(input.creates) ? input.creates : {};
  const components = objectArray<CompactComponent>(creates.components);
  const flows = objectArray<CompactFlow>(creates.flows);
  const claims = objectArray<CompactClaim>(creates.claims);
  const sources = objectArray<Source>(creates.sources);
  const explicitEdges = objectArray<Edge | CompactEdge>(creates.edges);
  const subjectTypes = new Map<string, GraphObjectType>();

  for (const component of components) subjectTypes.set(component.id, "component");
  for (const flow of flows) subjectTypes.set(flow.id, "flow");
  for (const claim of claims) subjectTypes.set(claim.id, "claim");
  for (const source of sources) subjectTypes.set(source.id, "source");

  const normalizedComponents = components.map(({ contains: _contains, supersedes: _supersedes, ...component }) => component);
  const normalizedFlows = flows.map(({ contains: _contains, touches: _touches, supersedes: _supersedes, ...flow }) => flow);
  const normalizedClaims = claims.map(
    ({ about: _about, evidenced_by: _evidencedBy, supersedes: _supersedes, ...claim }) => claim,
  );

  const edges: Edge[] = [];

  for (const component of components) {
    for (const target of asArray(component.contains)) {
      pushEdge(edges, "contains", component.id, "component", target, "component");
    }
    for (const target of asArray(component.supersedes)) {
      pushEdge(edges, "supersedes", component.id, "component", target, "component");
    }
  }

  for (const flow of flows) {
    for (const target of asArray(flow.contains)) {
      pushEdge(edges, "contains", flow.id, "flow", target, "flow");
    }
    for (const target of asArray(flow.touches)) {
      pushEdge(edges, "touches", flow.id, "flow", target, "component");
    }
    for (const target of asArray(flow.supersedes)) {
      pushEdge(edges, "supersedes", flow.id, "flow", target, "flow");
    }
  }

  for (const claim of claims) {
    for (const target of asArray(claim.about)) {
      const targetType = typeof target === "string" ? resolveSubjectType(target, subjectTypes, lookup) : undefined;
      pushEdge(edges, "about", claim.id, "claim", target, targetType ?? "component");
    }
    for (const target of asArray(claim.evidenced_by)) {
      pushEdge(edges, "evidenced_by", claim.id, "claim", target, "source");
    }
    for (const target of asArray(claim.supersedes)) {
      pushEdge(edges, "supersedes", claim.id, "claim", target, "claim");
    }
  }

  for (const edge of explicitEdges) {
    if (isCanonicalEdge(edge)) {
      edges.push(edge);
      continue;
    }

    if (typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.kind !== "string") {
      // Malformed edge (e.g. from_id/to_id without types, or missing kind): pass it
      // through untouched so validateProposal can report it instead of crashing here.
      const raw = edge as unknown as Record<string, unknown>;
      const passthroughId = typeof raw.id === "string" ? raw.id : `edge_invalid_${edges.length}`;
      edges.push({ ...raw, id: passthroughId } as unknown as Edge);
      continue;
    }

    const fromType = resolveSubjectType(edge.from, subjectTypes, lookup) ?? "component";
    const toType = resolveSubjectType(edge.to, subjectTypes, lookup) ?? defaultToType(edge.kind);
    edges.push(makeEdge(edge.kind, edge.from, fromType, edge.to, toType, edge.metadata));
  }

  return {
    title: typeof input.title === "string" ? input.title : "",
    summary: typeof input.summary === "string" ? input.summary : undefined,
    creates: {
      components: normalizedComponents,
      flows: normalizedFlows,
      claims: normalizedClaims,
      sources,
      edges: dedupeEdges(edges),
    },
  };
}

// Compact relationship fields (component.contains, flow.touches, claim.about,
// etc.) are declared as string/string[] in the Compact*/Edge types, but this
// function runs on untrusted proposal JSON before any validation -- the
// owning subject's id, or an individual target, can be missing or a
// non-string at runtime despite what the types claim. Building straight into
// makeEdge/edgeId/slug in that case throws a raw TypeError (the same crash
// class as #82, just reached via a subject/target id instead of an
// explicit edge's from_id/to_id). Guard here instead: on a valid pair, build
// the edge as before; otherwise push a placeholder with no from_type/to_type
// so validateProposal's existing "missing subject references" check reports
// it clearly instead of normalizeProposal crashing.
function pushEdge(
  edges: Edge[],
  kind: EdgeKind,
  fromId: unknown,
  fromType: GraphObjectType,
  toId: unknown,
  toType: GraphObjectType,
  metadata?: EdgeMetadata,
): void {
  if (typeof fromId === "string" && fromId.length > 0 && typeof toId === "string" && toId.length > 0) {
    edges.push(makeEdge(kind, fromId, fromType, toId, toType, metadata));
    return;
  }

  edges.push({
    id: `edge_invalid_${edges.length}`,
    kind,
    from_id: fromId,
    to_id: toId,
  } as unknown as Edge);
}

function makeEdge(
  kind: EdgeKind,
  fromId: string,
  fromType: GraphObjectType,
  toId: string,
  toType: GraphObjectType,
  metadata?: EdgeMetadata,
): Edge {
  return {
    id: edgeId(kind, fromType, fromId, toType, toId),
    from_id: fromId,
    from_type: fromType,
    to_id: toId,
    to_type: toType,
    kind,
    metadata,
  };
}

function edgeId(kind: EdgeKind, fromType: GraphObjectType, fromId: string, toType: GraphObjectType, toId: string): string {
  return `edge_${slug(kind)}_${slug(fromType)}_${slug(fromId)}_${slug(toType)}_${slug(toId)}`;
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const deduped: Edge[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    deduped.push(edge);
  }
  return deduped;
}

function resolveSubjectType(
  id: string,
  createdSubjects: Map<string, GraphObjectType>,
  lookup: ProposalSubjectLookup | undefined,
): GraphObjectType | undefined {
  return createdSubjects.get(id) ?? lookup?.subjectType(id);
}

function defaultToType(kind: EdgeKind): GraphObjectType {
  switch (kind) {
    case "about":
      return "component";
    case "contains":
      return "component";
    case "touches":
      return "component";
    case "supersedes":
      return "component";
    case "evidenced_by":
      return "source";
  }
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function objectArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isCanonicalEdge(edge: Edge | CompactEdge): edge is Edge {
  return "from_id" in edge && "from_type" in edge && "to_id" in edge && "to_type" in edge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
