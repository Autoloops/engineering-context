import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import type { Claim, ClaimKind } from "./claim.js";
import type { Edge } from "./edge.js";
import type { GraphReadResult } from "./service.js";
import type { Component, Flow, Source } from "./schema.js";
import { buildGraphHtmlExport } from "./html-export.js";

export interface ExportedGraphFile {
  path: string;
  content: string;
}

type EntityType = "component" | "flow";
type Entity = Component | Flow;

interface EntityIndex<T extends Entity> {
  byId: Map<string, T>;
  childrenByParentId: Map<string, string[]>;
  parentByChildId: Map<string, string>;
  pathsById: Map<string, string>;
  roots: string[];
}

export function buildGraphFolderExport(graph: GraphReadResult): ExportedGraphFile[] {
  const components = buildEntityIndex("component", graph.components, graph.edges);
  const flows = buildEntityIndex("flow", graph.flows, graph.edges);
  const claimsBySubjectId = buildClaimsBySubjectId(graph.claims, graph.edges);
  const touchedComponentIdsByFlowId = buildTouchedComponentIdsByFlowId(graph.edges);
  const flowIdsByTouchedComponentId = invertMap(touchedComponentIdsByFlowId);
  const evidenceByClaimId = buildEvidenceByClaimId(graph.edges);
  const sourceById = new Map(graph.sources.map((source) => [source.id, source]));

  const files: ExportedGraphFile[] = [
    {
      path: "index.md",
      content: renderRootIndex(graph, components, flows),
    },
    {
      path: "index.html",
      content: buildGraphHtmlExport(graph),
    },
    {
      path: "sources.md",
      content: renderSources(graph.sources, graph.claims, evidenceByClaimId),
    },
  ];

  for (const component of sortByName(graph.components)) {
    files.push({
      path: `${components.pathsById.get(component.id) ?? `components/${segmentForId(component.id, "component")}`}/index.md`,
      content: renderComponentIndex({
        component,
        components,
        flows,
        claims: claimsBySubjectId.get(component.id) ?? [],
        relatedFlowIds: flowIdsByTouchedComponentId.get(component.id) ?? [],
        evidenceByClaimId,
        sourceById,
      }),
    });
  }

  for (const flow of sortByName(graph.flows)) {
    files.push({
      path: `${flows.pathsById.get(flow.id) ?? `flows/${segmentForId(flow.id, "flow")}`}/index.md`,
      content: renderFlowIndex({
        flow,
        flows,
        components,
        claims: claimsBySubjectId.get(flow.id) ?? [],
        touchedComponentIds: touchedComponentIdsByFlowId.get(flow.id) ?? [],
        evidenceByClaimId,
        sourceById,
      }),
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildEntityIndex<T extends Entity>(type: EntityType, entities: T[], edges: Edge[]): EntityIndex<T> {
  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  const childrenByParentId = new Map<string, string[]>();
  const parentCandidatesByChildId = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.kind !== "contains" || edge.from_type !== type || edge.to_type !== type) continue;
    if (!byId.has(edge.from_id) || !byId.has(edge.to_id)) continue;
    appendToMap(childrenByParentId, edge.from_id, edge.to_id);
    appendToMap(parentCandidatesByChildId, edge.to_id, edge.from_id);
  }

  sortMapValues(childrenByParentId, byId);
  sortMapValues(parentCandidatesByChildId, byId);

  const parentByChildId = new Map<string, string>();
  for (const [childId, parentIds] of parentCandidatesByChildId) {
    const parentId = parentIds[0];
    if (parentId !== undefined) parentByChildId.set(childId, parentId);
  }

  const roots = sortByName(entities)
    .map((entity) => entity.id)
    .filter((id) => !parentByChildId.has(id));
  const pathsById = new Map<string, string>();

  for (const entity of entities) {
    pathsById.set(entity.id, entityPath(type, entity.id, byId, parentByChildId, new Set()));
  }

  return { byId, childrenByParentId, parentByChildId, pathsById, roots };
}

function entityPath<T extends Entity>(
  type: EntityType,
  id: string,
  byId: Map<string, T>,
  parentByChildId: Map<string, string>,
  visiting: Set<string>,
): string {
  const entity = byId.get(id);
  const segment = segmentForId(id, type);
  const root = `${type}s`;
  if (entity === undefined || visiting.has(id)) return `${root}/${segment}`;

  const parentId = parentByChildId.get(id);
  if (parentId === undefined || !byId.has(parentId)) return `${root}/${segment}`;

  visiting.add(id);
  const parentPath = entityPath(type, parentId, byId, parentByChildId, visiting);
  visiting.delete(id);
  return `${parentPath}/${segment}`;
}

function renderRootIndex(graph: GraphReadResult, components: EntityIndex<Component>, flows: EntityIndex<Flow>): string {
  return lines(
    "# Graph View",
    "",
    "Current graph view: main + working.",
    "",
    `Components: ${graph.components.length}`,
    `Flows: ${graph.flows.length}`,
    `Claims: ${graph.claims.length}`,
    `Sources: ${graph.sources.length}`,
    "",
    "## Components",
    "",
    ...renderEntityTree("index.md", components.roots, components),
    "",
    "## Flows",
    "",
    ...renderEntityTree("index.md", flows.roots, flows),
    "",
    "## Sources",
    "",
    "- [sources](sources.md)",
  );
}

function renderComponentIndex(input: {
  component: Component;
  components: EntityIndex<Component>;
  flows: EntityIndex<Flow>;
  claims: Claim[];
  relatedFlowIds: string[];
  evidenceByClaimId: Map<string, Evidence[]>;
  sourceById: Map<string, Source>;
}): string {
  const content = [`# ${input.component.name}`, "", `ID: \`${input.component.id}\``];
  const currentPath = `${input.components.pathsById.get(input.component.id) ?? ""}/index.md`;
  const parentId = input.components.parentByChildId.get(input.component.id);
  const childIds = input.components.childrenByParentId.get(input.component.id) ?? [];

  if (input.component.code_anchor !== undefined) content.push(`Code anchor: \`${input.component.code_anchor}\``);
  if (parentId !== undefined) {
    content.push(`Parent component: ${linkToEntity(currentPath, parentId, input.components) ?? `\`${parentId}\``}`);
  }

  pushEntitySection(content, "Child Components", currentPath, childIds, input.components);
  pushEntitySection(content, "Related Flows", currentPath, input.relatedFlowIds, input.flows);
  pushClaimSection(content, input.claims, input.evidenceByClaimId, input.sourceById);

  return lines(...content);
}

function renderFlowIndex(input: {
  flow: Flow;
  flows: EntityIndex<Flow>;
  components: EntityIndex<Component>;
  claims: Claim[];
  touchedComponentIds: string[];
  evidenceByClaimId: Map<string, Evidence[]>;
  sourceById: Map<string, Source>;
}): string {
  const content = [`# ${input.flow.name}`, "", `ID: \`${input.flow.id}\``];
  const currentPath = `${input.flows.pathsById.get(input.flow.id) ?? ""}/index.md`;
  const parentId = input.flows.parentByChildId.get(input.flow.id);
  const childIds = input.flows.childrenByParentId.get(input.flow.id) ?? [];

  if (parentId !== undefined) content.push(`Parent flow: ${linkToEntity(currentPath, parentId, input.flows) ?? `\`${parentId}\``}`);

  pushEntitySection(content, "Child Flows", currentPath, childIds, input.flows);
  pushEntitySection(content, "Touched Components", currentPath, input.touchedComponentIds, input.components);
  pushClaimSection(content, input.claims, input.evidenceByClaimId, input.sourceById);

  return lines(...content);
}

function renderSources(sources: Source[], claims: Claim[], evidenceByClaimId: Map<string, Evidence[]>): string {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const claimIdsBySourceId = new Map<string, string[]>();

  for (const [claimId, evidence] of evidenceByClaimId) {
    for (const item of evidence) appendToMap(claimIdsBySourceId, item.sourceId, claimId);
  }

  const content = ["# Sources", ""];
  for (const source of sortByTitle(sources)) {
    content.push(`## ${source.title ?? source.ref}`, "", `\`${source.id}\` | \`${source.kind}\` | \`${source.ref}\``, "");
    const claimIds = claimIdsBySourceId.get(source.id) ?? [];
    if (claimIds.length === 0) {
      content.push("- No claims reference this source.");
    } else {
      for (const claimId of claimIds.sort()) {
        const claim = claimById.get(claimId);
        content.push(`- \`${claimId}\`${claim === undefined ? "" : ` ${claim.text}`}`);
      }
    }
    content.push("");
  }

  if (sources.length === 0) content.push("No sources.");
  return lines(...content);
}

function renderClaims(claims: Claim[], evidenceByClaimId: Map<string, Evidence[]>, sourceById: Map<string, Source>): string[] {
  if (claims.length === 0) return [];

  const content: string[] = [];

  for (const [kind, kindClaims] of groupedClaims(claims)) {
    content.push(`### ${claimKindTitle(kind)}`, "");
    for (const claim of kindClaims) {
      const evidence = evidenceByClaimId.get(claim.id) ?? [];
      const evidenceText = evidence.length === 0 ? "" : ` Evidence: ${renderEvidence(evidence, sourceById)}.`;
      content.push(`- \`${claim.id}\`${claimMetadata(claim)}: ${claim.text}${evidenceText}`);
    }
    content.push("");
  }
  return content;
}

function pushEntitySection<T extends Entity>(
  content: string[],
  title: string,
  currentPath: string,
  ids: string[],
  index: EntityIndex<T>,
): void {
  if (ids.length === 0) return;
  content.push("", `## ${title}`, "", ...renderEntityLinks(currentPath, ids, index));
}

function pushClaimSection(
  content: string[],
  claims: Claim[],
  evidenceByClaimId: Map<string, Evidence[]>,
  sourceById: Map<string, Source>,
): void {
  const renderedClaims = renderClaims(claims, evidenceByClaimId, sourceById);
  if (renderedClaims.length === 0) return;
  content.push("", "## Claims", "", ...renderedClaims);
}

function renderEntityTree<T extends Entity>(currentPath: string, ids: string[], index: EntityIndex<T>, depth = 0): string[] {
  if (ids.length === 0 && depth === 0) return ["- None."];
  const content: string[] = [];
  for (const id of ids) {
    const entity = index.byId.get(id);
    if (entity === undefined) continue;
    const indent = "  ".repeat(depth);
    content.push(`${indent}- ${linkToEntity(currentPath, id, index) ?? entity.name}`);
    content.push(...renderEntityTree(currentPath, index.childrenByParentId.get(id) ?? [], index, depth + 1));
  }
  return content;
}

function renderEntityLinks<T extends Entity>(currentPath: string, ids: string[], index: EntityIndex<T>): string[] {
  return ids
    .map((id) => linkToEntity(currentPath, id, index))
    .filter((link): link is string => link !== undefined)
    .map((link) => `- ${link}`);
}

function linkToEntity<T extends Entity>(currentPath: string, id: string, index: EntityIndex<T>): string | undefined {
  const entity = index.byId.get(id);
  const entityPath = index.pathsById.get(id);
  if (entity === undefined || entityPath === undefined) return undefined;
  const target = relativeFolderLink(currentPath, `${entityPath}/index.md`);
  return `[${entity.name}](${target})`;
}

function relativeFolderLink(fromIndexPath: string, toIndexPath: string): string {
  const fromDirectory = path.dirname(fromIndexPath);
  const toDirectory = path.dirname(toIndexPath);
  const relative = path.relative(fromDirectory, toDirectory);
  return relative.length === 0 ? "./" : `${relative}/`;
}

function buildClaimsBySubjectId(claims: Claim[], edges: Edge[]): Map<string, Claim[]> {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const claimsBySubjectId = new Map<string, Claim[]>();

  for (const edge of edges) {
    if (edge.kind !== "about" || edge.from_type !== "claim") continue;
    const claim = claimById.get(edge.from_id);
    if (claim === undefined) continue;
    appendToMap(claimsBySubjectId, edge.to_id, claim);
  }

  for (const [subjectId, subjectClaims] of claimsBySubjectId) {
    claimsBySubjectId.set(subjectId, sortByClaimKind(subjectClaims));
  }

  return claimsBySubjectId;
}

function groupedClaims(claims: Claim[]): Array<[ClaimKind, Claim[]]> {
  const groups = new Map<ClaimKind, Claim[]>();
  for (const claim of sortByClaimKind(claims)) appendToMap(groups, claim.kind, claim);
  return [...groups.entries()];
}

function claimKindTitle(kind: ClaimKind): string {
  switch (kind) {
    case "decision":
      return "Decisions";
    case "fact":
      return "Facts";
    case "question":
      return "Questions";
    case "requirement":
      return "Requirements";
    case "risk":
      return "Risks";
    case "task":
      return "Tasks";
  }
}

function claimMetadata(claim: Claim): string {
  const metadata = [];
  if (claim.truth !== "code_verified") metadata.push(claim.truth);
  if (claim.intent !== "intended") metadata.push(`${claim.intent} intent`);
  return metadata.length === 0 ? "" : ` (${metadata.join(", ")})`;
}

function renderEvidence(evidence: Evidence[], sourceById: Map<string, Source>): string {
  return evidence
    .map((item) => {
      const source = sourceById.get(item.sourceId);
      return source?.title ?? source?.ref ?? item.sourceId;
    })
    .join("; ");
}

function buildTouchedComponentIdsByFlowId(edges: Edge[]): Map<string, string[]> {
  const touchedComponentIdsByFlowId = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "touches" || edge.from_type !== "flow" || edge.to_type !== "component") continue;
    appendToMap(touchedComponentIdsByFlowId, edge.from_id, edge.to_id);
  }
  for (const [flowId, componentIds] of touchedComponentIdsByFlowId) touchedComponentIdsByFlowId.set(flowId, componentIds.sort());
  return touchedComponentIdsByFlowId;
}

interface Evidence {
  sourceId: string;
  reason?: string;
}

function buildEvidenceByClaimId(edges: Edge[]): Map<string, Evidence[]> {
  const evidenceByClaimId = new Map<string, Evidence[]>();
  for (const edge of edges) {
    if (edge.kind !== "evidenced_by" || edge.from_type !== "claim" || edge.to_type !== "source") continue;
    const reason = typeof edge.metadata?.reason === "string" ? edge.metadata.reason : undefined;
    appendToMap(evidenceByClaimId, edge.from_id, { sourceId: edge.to_id, reason });
  }
  return evidenceByClaimId;
}

function invertMap(input: Map<string, string[]>): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const [fromId, toIds] of input) {
    for (const toId of toIds) appendToMap(output, toId, fromId);
  }
  for (const [id, values] of output) output.set(id, values.sort());
  return output;
}

function appendToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, [value]);
    return;
  }
  values.push(value);
}

function sortMapValues<T extends Entity>(map: Map<string, string[]>, byId: Map<string, T>): void {
  for (const [key, ids] of map) {
    map.set(
      key,
      ids.sort((left, right) => {
        const leftEntity = byId.get(left);
        const rightEntity = byId.get(right);
        return (leftEntity?.name ?? left).localeCompare(rightEntity?.name ?? right);
      }),
    );
  }
}

function sortByName<T extends Entity>(items: T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function sortByTitle(items: Source[]): Source[] {
  return [...items].sort((left, right) => (left.title ?? left.ref).localeCompare(right.title ?? right.ref));
}

function sortByClaimKind(claims: Claim[]): Claim[] {
  return [...claims].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    if (kind !== 0) return kind;
    return left.id.localeCompare(right.id);
  });
}

function segmentForId(id: string, type: EntityType): string {
  const withoutPrefix = id.startsWith(`${type}.`) ? id.slice(type.length + 1) : id;
  const slugged = withoutPrefix.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slugged.length > 0 ? slugged : `${type}-${shortHash(id)}`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function lines(...values: Array<string | undefined>): string {
  return `${values.filter((value): value is string => value !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
