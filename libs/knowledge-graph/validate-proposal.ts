import { isAllowedEdge } from "./edge.js";
import type { Edge, EdgeKind } from "./edge.js";
import type { MemoryCommitProposal, ProposalSubject } from "./proposal.js";
import type { GraphObjectType } from "./schema.js";

const claimKinds = new Set(["fact", "requirement", "decision", "task", "question", "risk"]);
const claimTruths = new Set(["code_verified", "source_verified", "unknown"]);
const claimIntents = new Set(["intended", "accidental", "unknown"]);
const sourceKinds = new Set(["session"]);
const edgeKinds = new Set(["about", "contains", "touches", "supersedes", "evidenced_by"]);
const graphObjectTypes = new Set(["component", "flow", "claim", "edge", "source"]);
const maxCodeAnchorsPerClaim = 3;

type AcyclicRelationshipEdge = Edge & { kind: "contains" | "supersedes" };

export interface ExistingSubjectLookup {
  subjectExists(type: GraphObjectType, id: string): boolean;
  existingEdges?(): Edge[];
}

export interface ProposalValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProposal(
  proposal: unknown,
  existingSubjects?: ExistingSubjectLookup,
): ProposalValidationResult {
  const errors: string[] = [];

  if (!isRecord(proposal)) {
    return { valid: false, errors: ["Proposal must be an object."] };
  }

  if (!isNonEmptyString(proposal.title)) {
    errors.push("Proposal title must be a non-empty string.");
  }

  if (proposal.summary !== undefined && typeof proposal.summary !== "string") {
    errors.push("Proposal summary must be a string when present.");
  }

  if (!isRecord(proposal.creates)) {
    errors.push("Proposal creates must be an object.");
    return { valid: false, errors };
  }

  const typedProposal = proposal as Partial<MemoryCommitProposal>;
  const creates = typedProposal.creates ?? {};
  const ids = new Map<string, ProposalSubject>();
  const components = arrayField(creates, "components", errors);
  const flows = arrayField(creates, "flows", errors);
  const claims = arrayField(creates, "claims", errors);
  const sources = arrayField(creates, "sources", errors);
  const edges = arrayField(creates, "edges", errors);

  for (const component of components) {
    if (!isRecord(component)) {
      errors.push("Every component must be an object.");
      continue;
    }
    validateSubjectBase("component", component.id, ids, existingSubjects, errors);
    if (!isNonEmptyString(component.name)) errors.push(`Component ${stringId(component.id)} needs a name.`);
    if (component.code_anchor !== undefined && typeof component.code_anchor !== "string") {
      errors.push(`Component ${stringId(component.id)} code_anchor must be a string when present.`);
    }
  }

  for (const flow of flows) {
    if (!isRecord(flow)) {
      errors.push("Every flow must be an object.");
      continue;
    }
    validateSubjectBase("flow", flow.id, ids, existingSubjects, errors);
    if (!isNonEmptyString(flow.name)) errors.push(`Flow ${stringId(flow.id)} needs a name.`);
  }

  for (const claim of claims) {
    if (!isRecord(claim)) {
      errors.push("Every claim must be an object.");
      continue;
    }
    validateSubjectBase("claim", claim.id, ids, existingSubjects, errors);
    if (!claimKinds.has(String(claim.kind))) errors.push(`Claim ${stringId(claim.id)} has invalid kind.`);
    if (!isNonEmptyString(claim.text)) errors.push(`Claim ${stringId(claim.id)} needs text.`);
    if (!claimTruths.has(String(claim.truth))) errors.push(`Claim ${stringId(claim.id)} has invalid truth.`);
    if (!claimIntents.has(String(claim.intent))) errors.push(`Claim ${stringId(claim.id)} has invalid intent.`);
    validateClaimCodeAnchors(claim, errors);
  }

  for (const source of sources) {
    if (!isRecord(source)) {
      errors.push("Every source must be an object.");
      continue;
    }
    validateSubjectBase("source", source.id, ids, existingSubjects, errors);
    if (!sourceKinds.has(String(source.kind))) errors.push(`Source ${stringId(source.id)} has invalid kind.`);
    if (!isNonEmptyString(source.ref)) errors.push(`Source ${stringId(source.id)} needs ref.`);
    if (source.title !== undefined && typeof source.title !== "string") {
      errors.push(`Source ${stringId(source.id)} title must be a string when present.`);
    }
  }

  for (const edge of edges) {
    if (!isRecord(edge)) {
      errors.push("Every edge must be an object.");
      continue;
    }

    validateSubjectBase("edge", edge.id, ids, existingSubjects, errors);

    if (edge.from_type === undefined || edge.to_type === undefined) {
      errors.push(
        `Edge ${stringId(edge.id)} is missing subject references: compact edges use { kind, from, to } (did you mean 'from'/'to' instead of 'from_id'/'to_id'?).`,
      );
      continue;
    }

    const fromType = String(edge.from_type) as GraphObjectType;
    const toType = String(edge.to_type) as GraphObjectType;
    const kind = String(edge.kind) as EdgeKind;

    if (!graphObjectTypes.has(fromType)) errors.push(`Edge ${stringId(edge.id)} has invalid from_type.`);
    if (!graphObjectTypes.has(toType)) errors.push(`Edge ${stringId(edge.id)} has invalid to_type.`);
    if (!edgeKinds.has(kind)) errors.push(`Edge ${stringId(edge.id)} has invalid kind.`);

    if (graphObjectTypes.has(fromType) && !subjectRefExists(fromType, String(edge.from_id), ids, existingSubjects)) {
      errors.push(`Edge ${stringId(edge.id)} references missing from subject ${fromType}:${String(edge.from_id)}.`);
    }

    if (graphObjectTypes.has(toType) && !subjectRefExists(toType, String(edge.to_id), ids, existingSubjects)) {
      errors.push(`Edge ${stringId(edge.id)} references missing to subject ${toType}:${String(edge.to_id)}.`);
    }

    if (
      graphObjectTypes.has(fromType) &&
      graphObjectTypes.has(toType) &&
      edgeKinds.has(kind) &&
      !isAllowedEdge({ from_type: fromType, to_type: toType, kind })
    ) {
      errors.push(`Edge ${stringId(edge.id)} has invalid direction for ${kind}.`);
    }

    if (edge.metadata !== undefined && !isRecord(edge.metadata)) {
      errors.push(`Edge ${stringId(edge.id)} metadata must be an object when present.`);
    }

    if (kind === "evidenced_by") {
      validateEvidenceMetadata(edge, errors);
    }
  }

  validateRelationshipCycles(edges, existingSubjects?.existingEdges?.() ?? [], errors);

  return { valid: errors.length === 0, errors };
}

function validateRelationshipCycles(proposalEdges: unknown[], existingEdges: Edge[], errors: string[]): void {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of existingEdges) addRelationshipEdge(adjacency, edge);

  for (const value of proposalEdges) {
    const edge = relationshipEdge(value);
    if (edge === undefined) continue;

    const from = relationshipNodeKey(edge.kind, edge.from_type, edge.from_id);
    const to = relationshipNodeKey(edge.kind, edge.to_type, edge.to_id);
    if (from === to) {
      errors.push(`Edge ${edge.id} cannot ${relationshipVerb(edge.kind)} itself.`);
    } else if (hasPath(adjacency, to, from)) {
      errors.push(`Edge ${edge.id} creates a ${edge.kind} cycle.`);
    }
    addRelationshipEdge(adjacency, edge);
  }
}

function relationshipEdge(value: unknown): AcyclicRelationshipEdge | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  const fromType = value.from_type;
  const toType = value.to_type;
  if (kind !== "contains" && kind !== "supersedes") return undefined;
  if (fromType !== toType) return undefined;
  if (kind === "contains" && fromType !== "component" && fromType !== "flow") return undefined;
  if (kind === "supersedes" && fromType !== "component" && fromType !== "flow" && fromType !== "claim") return undefined;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.from_id) || !isNonEmptyString(value.to_id)) return undefined;
  return value as unknown as AcyclicRelationshipEdge;
}

function addRelationshipEdge(adjacency: Map<string, Set<string>>, edge: Edge): void {
  const relationship = relationshipEdge(edge);
  if (relationship === undefined) return;
  const from = relationshipNodeKey(relationship.kind, relationship.from_type, relationship.from_id);
  const to = relationshipNodeKey(relationship.kind, relationship.to_type, relationship.to_id);
  const targets = adjacency.get(from) ?? new Set<string>();
  targets.add(to);
  adjacency.set(from, targets);
}

function hasPath(adjacency: Map<string, Set<string>>, start: string, target: string): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function relationshipNodeKey(kind: "contains" | "supersedes", type: GraphObjectType, id: string): string {
  return `${kind}:${type}:${id}`;
}

function relationshipVerb(kind: "contains" | "supersedes"): string {
  return kind === "contains" ? "contain" : "supersede";
}

function validateEvidenceMetadata(edge: Record<string, unknown>, errors: string[]): void {
  if (!isRecord(edge.metadata)) {
    errors.push(`Edge ${stringId(edge.id)} evidenced_by edges require metadata.reason.`);
    return;
  }

  const reason = edge.metadata.reason;
  if (!isNonEmptyString(reason)) {
    errors.push(`Edge ${stringId(edge.id)} evidenced_by metadata.reason must be a non-empty string.`);
  }
}

function validateClaimCodeAnchors(claim: Record<string, unknown>, errors: string[]): void {
  const claimId = stringId(claim.id);
  const anchors = claim.code_anchors;

  if (claim.truth === "code_verified" && (!Array.isArray(anchors) || anchors.length === 0)) {
    errors.push(`Claim ${claimId} is code_verified and must include code_anchors.`);
    return;
  }

  if (anchors === undefined) return;
  if (!Array.isArray(anchors)) {
    errors.push(`Claim ${claimId} code_anchors must be an array when present.`);
    return;
  }

  if (anchors.length > maxCodeAnchorsPerClaim) {
    errors.push(
      `Claim ${claimId} has ${anchors.length} code_anchors; split broad claims so each claim has at most ${maxCodeAnchorsPerClaim} code_anchors.`,
    );
  }

  const seen = new Set<string>();
  for (const [index, anchor] of anchors.entries()) {
    if (!isRecord(anchor)) {
      errors.push(`Claim ${claimId} code_anchors[${index}] must be an object.`);
      continue;
    }

    if (!isNonEmptyString(anchor.file)) {
      errors.push(`Claim ${claimId} code_anchors[${index}].file must be a non-empty string.`);
      continue;
    }
    if (isAbsoluteOrLineAnchor(anchor.file)) {
      errors.push(`Claim ${claimId} code_anchors[${index}].file must be repo-relative and must not include line numbers.`);
    }
    if (anchor.symbol !== undefined && typeof anchor.symbol !== "string") {
      errors.push(`Claim ${claimId} code_anchors[${index}].symbol must be a string when present.`);
    }
    if (typeof anchor.symbol === "string" && anchor.symbol.trim().length === 0) {
      errors.push(`Claim ${claimId} code_anchors[${index}].symbol must not be empty when present.`);
    }

    const key = `${anchor.file}#${typeof anchor.symbol === "string" ? anchor.symbol : ""}`;
    if (seen.has(key)) {
      errors.push(`Claim ${claimId} has duplicate code anchor ${key}.`);
    }
    seen.add(key);
  }
}

function isAbsoluteOrLineAnchor(file: string): boolean {
  if (/^[\\/]/.test(file) || /^[a-zA-Z]:[\\/]/.test(file) || /:\d+(:\d+)?$/.test(file)) return true;
  // Reject any ".." path segment (checked on both separators, since the string
  // itself isn't resolved on this OS yet) so a proposal can't escape the repo
  // root via e.g. "../../../../etc/passwd" -- this validator's error message
  // promises "repo-relative", so it must actually enforce that, not rely on
  // the downstream code-anchor resolver's isRepoRelative() guard as the only line of defense.
  return file.split(/[\\/]/).some((segment) => segment === "..");
}

function validateSubjectBase(
  type: GraphObjectType,
  id: unknown,
  ids: Map<string, ProposalSubject>,
  existingSubjects: ExistingSubjectLookup | undefined,
  errors: string[],
): void {
  if (!isNonEmptyString(id)) {
    errors.push(`${type} must have a non-empty id.`);
    return;
  }

  const key = subjectKey(type, id);
  if (ids.has(key)) {
    errors.push(`Duplicate id ${key} in proposal.`);
  }

  ids.set(key, { type, id });

  if (existingSubjects?.subjectExists(type, id)) {
    errors.push(`${key} already exists.`);
  }
}

function subjectRefExists(
  type: GraphObjectType,
  id: string,
  ids: Map<string, ProposalSubject>,
  existingSubjects: ExistingSubjectLookup | undefined,
): boolean {
  return ids.has(subjectKey(type, id)) || existingSubjects?.subjectExists(type, id) === true;
}

function subjectKey(type: GraphObjectType, id: string): string {
  return `${type}:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayField(source: object, key: string, errors: string[]): unknown[] {
  const value = (source as Record<string, unknown>)[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`creates.${key} must be an array when present.`);
    return [];
  }
  return value;
}

function stringId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "<missing>";
}
