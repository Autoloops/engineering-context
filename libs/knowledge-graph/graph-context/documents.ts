import type { Claim } from "../claim.js";
import type { GraphReadResult } from "../service.js";
import type { Component, Flow } from "../schema.js";

export type ContextDocumentType = "claim" | "component" | "flow";

export type ContextDocumentObject = Claim | Component | Flow;

export interface ContextDocument {
  key: string;
  type: ContextDocumentType;
  id: string;
  text: string;
  object: ContextDocumentObject;
  about: Array<{ type: "component" | "flow"; id: string }>;
}

export function buildClaimDocuments(graph: GraphReadResult): ContextDocument[] {
  const components = new Map(graph.components.map((component) => [component.id, component]));
  const flows = new Map(graph.flows.map((flow) => [flow.id, flow]));
  const aboutByClaim = new Map<string, Array<{ type: "component" | "flow"; id: string }>>();

  for (const edge of graph.edges) {
    if (edge.kind !== "about" || edge.from_type !== "claim") continue;
    if (edge.to_type !== "component" && edge.to_type !== "flow") continue;
    const existing = aboutByClaim.get(edge.from_id) ?? [];
    existing.push({ type: edge.to_type, id: edge.to_id });
    aboutByClaim.set(edge.from_id, existing);
  }

  return graph.claims.map((claim) => ({
    key: contextDocumentKey("claim", claim.id),
    type: "claim",
    id: claim.id,
    object: claim,
    about: aboutByClaim.get(claim.id) ?? [],
    text: claimText(claim, aboutByClaim.get(claim.id) ?? [], components, flows),
  }));
}

export function buildComponentDocuments(graph: GraphReadResult): ContextDocument[] {
  return graph.components.map((component) => ({
    key: contextDocumentKey("component", component.id),
    type: "component",
    id: component.id,
    object: component,
    about: [],
    text: [
      `component id: ${component.id}`,
      `component name: ${component.name}`,
      component.code_anchor ? `component code anchor: ${component.code_anchor}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

export function buildFlowDocuments(graph: GraphReadResult): ContextDocument[] {
  return graph.flows.map((flow) => ({
    key: contextDocumentKey("flow", flow.id),
    type: "flow",
    id: flow.id,
    object: flow,
    about: [],
    text: [
      `flow id: ${flow.id}`,
      `flow name: ${flow.name}`,
    ].join("\n"),
  }));
}

export function contextDocumentKey(type: ContextDocumentType, id: string): string {
  return `${type}:${id}`;
}

function claimText(
  claim: Claim,
  about: Array<{ type: "component" | "flow"; id: string }>,
  components: Map<string, Component>,
  flows: Map<string, Flow>,
): string {
  return [
    `Claim: ${claim.text}`,
    "",
    ...about.flatMap((target) => {
      if (target.type === "component") {
        const component = components.get(target.id);
        if (!component) return [];
        return [
          "This claim is about component:",
          `- Name: ${component.name}`,
          component.code_anchor ? `- File anchor: ${component.code_anchor}` : "",
          "",
        ];
      }
      const flow = flows.get(target.id);
      if (!flow) return [];
      return [
        "This claim is about flow:",
        `- Name: ${flow.name}`,
        "",
      ];
    }),
    ...relevantFileText(claim),
    ...relatedTermText(claim),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function relatedTermText(claim: Claim): string[] {
  const terms = relatedTerms(claim);
  return terms.length === 0 ? [] : ["", `Related terms: ${terms.join(", ")}`];
}

function relevantFileText(claim: Claim): string[] {
  const anchors = claim.code_anchors ?? [];
  if (anchors.length === 0) return [];
  return [
    "Relevant files:",
    ...anchors.map((anchor) => {
      const symbol = anchor.symbol === undefined ? "" : `, symbol ${anchor.symbol}`;
      return `- ${anchor.file}${symbol}`;
    }),
  ];
}

function relatedTerms(claim: Claim): string[] {
  const terms = new Set<string>();
  for (const token of claim.text.split(/[^A-Za-z0-9_./-]+/)) {
    const normalized = cleanRelatedTerm(token);
    if (normalized.length < 3) continue;
    if (relatedTermStopwords.has(normalized.toLowerCase())) continue;
    terms.add(normalized);
  }
  for (const anchor of claim.code_anchors ?? []) {
    if (anchor.symbol !== undefined) terms.add(anchor.symbol);
    terms.add(anchor.file);
  }
  return [...terms].slice(0, 20);
}

function cleanRelatedTerm(token: string): string {
  const trimmed = token.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) return trimmed;
  return trimmed.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "");
}

const relatedTermStopwords = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "into",
  "that",
  "the",
  "then",
  "this",
  "when",
  "with",
]);
