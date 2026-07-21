import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Claim } from "../claim.js";
import type { Edge } from "../edge.js";
import type { GraphReadResult } from "../service.js";
import type { Component, Flow, Source } from "../schema.js";
import type { ClaimProvenanceRecord } from "../repository.js";

const require = createRequire(import.meta.url);

// Inlined rather than loaded from a CDN so generated graph HTML remains a
// self-contained artifact that renders with no network access. Versions are
// pinned exactly in package.json, so the bundle contents are known at
// publish time; the closing-tag check guards against a future version
// introducing a literal "</script" that would truncate the embedding tag.
// The dist file is resolved relative to the package's main entry (rather
// than via a direct subpath) because chart.js's "exports" map does not
// expose "./dist/chart.umd.js" as an importable subpath.
function readVendorScript(packageName: string, distFileName: string): string {
  const packageDir = dirname(require.resolve(packageName));
  const contents = readFileSync(join(packageDir, distFileName), "utf8");
  if (/<\/script/i.test(contents)) {
    throw new Error(`vendor script ${packageName}/${distFileName} contains a literal "</script" and cannot be inlined safely`);
  }
  return contents;
}

export interface GraphViewComponentRow {
  id: string;
  name: string;
  folder: string;
  anchors: string[];
  flowCount: number;
  claimCount: number;
  subcomponentCount: number;
}

export interface GraphViewFlowRow {
  id: string;
  name: string;
  folder: string;
  touchedComponentFolders: string[];
  claimCount: number;
}

export interface GraphViewClaimRow {
  id: string;
  text: string;
  kind: string;
  session: string;
  source: "code" | "session";
  freshness: "active" | "superseded";
  componentIds: string[];
  flowIds: string[];
  createdAt: string | null;
  memoryCommitId: string | null;
}

export interface GraphViewTimelineEvent {
  memoryCommitId: string | null;
  createdAt: string | null;
  added: number;
  sessionPct: number;
  codePct: number;
}

export interface GraphViewData {
  generatedAt: string;
  counts: {
    components: number;
    flows: number;
    claims: number;
    superseded: number;
  };
  components: GraphViewComponentRow[];
  flows: GraphViewFlowRow[];
  claims: GraphViewClaimRow[];
  supersededClaims: GraphViewClaimRow[];
  claimsTimeline: {
    summary: { total: number; sessionPct: number; codePct: number };
    events: GraphViewTimelineEvent[];
  };
}

export interface BuildGraphViewOptions {
  repoName?: string;
}

const CLAIM_KIND_ORDER = ["fact", "decision", "requirement", "task", "risk", "question"];

const CLAIM_KIND_COLORS: Record<string, string> = {
  fact: "#4e79a7",
  decision: "#59a14f",
  requirement: "#f28e2b",
  task: "#b07aa1",
  risk: "#e15759",
  question: "#76b7b2",
};

export function buildGraphViewData(
  graph: GraphReadResult,
  provenance: ClaimProvenanceRecord[],
  supersededClaims: Claim[],
): GraphViewData {
  const provenanceByClaimId = new Map(provenance.map((row) => [row.claim_id, row]));
  const sourceById = new Map(graph.sources.map((source) => [source.id, source]));
  const topLevelComponents = selectTopLevelComponents(graph.components, graph.edges);
  const components = topLevelComponents.map((component) => ({
    id: component.id,
    name: component.name,
    folder: segmentForComponentId(component.id),
    anchors: parseAnchors(component.code_anchor),
    flowCount: countFlowsForComponent(component.id, graph.edges),
    claimCount: countClaimsForComponent(component.id, graph.edges),
    subcomponentCount: countSubcomponents(component.id, graph.edges),
  }));

  const topLevelFlows = selectTopLevelFlows(graph.flows, graph.edges);
  const flows = topLevelFlows.map((flow) => {
    const touchedComponentIds = touchedComponentIdsForFlow(flow.id, graph.edges);
    return {
      id: flow.id,
      name: flow.name,
      folder: segmentForFlowId(flow.id),
      touchedComponentFolders: touchedComponentIds
        .map((componentId) => segmentForComponentId(componentId))
        .sort((left, right) => left.localeCompare(right)),
      claimCount: countClaimsForFlow(flow.id, graph.edges),
    };
  });

  const toClaimRow = (claim: Claim, freshness: "active" | "superseded"): GraphViewClaimRow => {
    const record = provenanceByClaimId.get(claim.id);
    const session = sessionLabelForClaim(claim.id, graph.edges, sourceById);
    return {
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      session,
      source: isFromSession(session) ? "session" : "code",
      freshness,
      componentIds: componentIdsForClaim(claim.id, graph.edges),
      flowIds: flowIdsForClaim(claim.id, graph.edges),
      createdAt: record?.created_at ?? null,
      memoryCommitId: record?.memory_commit_id ?? null,
    };
  };

  const byCreatedDesc = (left: GraphViewClaimRow, right: GraphViewClaimRow): number => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return rightTime - leftTime;
  };

  const claims = graph.claims.map((claim) => toClaimRow(claim, "active")).sort(byCreatedDesc);
  const superseded = supersededClaims.map((claim) => toClaimRow(claim, "superseded")).sort(byCreatedDesc);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      components: components.length,
      flows: flows.length,
      claims: claims.length,
      superseded: superseded.length,
    },
    components,
    flows,
    claims,
    supersededClaims: superseded,
    claimsTimeline: buildClaimsTimeline(claims),
  };
}

export function buildGraphViewHtml(
  graph: GraphReadResult,
  provenance: ClaimProvenanceRecord[],
  supersededClaims: Claim[],
  options: BuildGraphViewOptions = {},
): string {
  const data = buildGraphViewData(graph, provenance, supersededClaims);
  return buildGraphViewHtmlFromData(data, options);
}

export function buildGraphViewHtmlFromData(
  data: GraphViewData,
  options: BuildGraphViewOptions = {},
): string {
  const title = options.repoName ? `Greplica graph view — ${options.repoName}` : "Greplica graph view";
  return renderHtml(data, title);
}

function selectTopLevelComponents(components: Component[], edges: Edge[]): Component[] {
  const componentIds = new Set(components.map((component) => component.id));
  const childIds = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "contains" || edge.from_type !== "component" || edge.to_type !== "component") continue;
    if (!componentIds.has(edge.from_id) || !componentIds.has(edge.to_id)) continue;
    childIds.add(edge.to_id);
  }
  return sortByName(components.filter((component) => !childIds.has(component.id)));
}

function selectTopLevelFlows(flows: Flow[], edges: Edge[]): Flow[] {
  const flowIds = new Set(flows.map((flow) => flow.id));
  const childIds = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "contains" || edge.from_type !== "flow" || edge.to_type !== "flow") continue;
    if (!flowIds.has(edge.from_id) || !flowIds.has(edge.to_id)) continue;
    childIds.add(edge.to_id);
  }
  return sortByName(flows.filter((flow) => !childIds.has(flow.id)));
}

function countFlowsForComponent(componentId: string, edges: Edge[]): number {
  return edges.filter((edge) => edge.kind === "touches" && edge.to_type === "component" && edge.to_id === componentId).length;
}

function countClaimsForComponent(componentId: string, edges: Edge[]): number {
  return edges.filter((edge) => edge.kind === "about" && edge.to_type === "component" && edge.to_id === componentId).length;
}

function countSubcomponents(componentId: string, edges: Edge[]): number {
  return edges.filter(
    (edge) =>
      edge.kind === "contains" &&
      edge.from_type === "component" &&
      edge.to_type === "component" &&
      edge.from_id === componentId,
  ).length;
}

function countClaimsForFlow(flowId: string, edges: Edge[]): number {
  return edges.filter((edge) => edge.kind === "about" && edge.to_type === "flow" && edge.to_id === flowId).length;
}

function touchedComponentIdsForFlow(flowId: string, edges: Edge[]): string[] {
  return edges
    .filter((edge) => edge.kind === "touches" && edge.from_type === "flow" && edge.from_id === flowId && edge.to_type === "component")
    .map((edge) => edge.to_id)
    .sort();
}

function flowIdsForClaim(claimId: string, edges: Edge[]): string[] {
  return edges
    .filter((edge) => edge.kind === "about" && edge.from_type === "claim" && edge.from_id === claimId && edge.to_type === "flow")
    .map((edge) => edge.to_id);
}

function componentIdsForClaim(claimId: string, edges: Edge[]): string[] {
  return edges
    .filter((edge) => edge.kind === "about" && edge.from_type === "claim" && edge.from_id === claimId && edge.to_type === "component")
    .map((edge) => edge.to_id);
}

function parseAnchors(codeAnchor: string | null | undefined): string[] {
  if (codeAnchor === undefined || codeAnchor === null || codeAnchor.trim().length === 0) return [];
  return codeAnchor
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function segmentForFlowId(id: string): string {
  const withoutPrefix = id.startsWith("flow.") ? id.slice("flow.".length) : id;
  const slugged = withoutPrefix
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slugged.length > 0 ? slugged : `flow-${id.slice(0, 8)}`;
}

function segmentForComponentId(id: string): string {
  const withoutPrefix = id.startsWith("component.") ? id.slice("component.".length) : id;
  const slugged = withoutPrefix
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slugged.length > 0 ? slugged : `component-${id.slice(0, 8)}`;
}

function sessionLabelForClaim(claimId: string, edges: Edge[], sourceById: Map<string, Source>): string {
  const evidenceEdges = edges.filter(
    (edge) => edge.kind === "evidenced_by" && edge.from_type === "claim" && edge.from_id === claimId && edge.to_type === "source",
  );
  if (evidenceEdges.length === 0) return "from code";

  const labels = evidenceEdges
    .map((edge) => {
      const source = sourceById.get(edge.to_id);
      if (!source) return undefined;
      return source.title?.trim() || source.ref?.trim();
    })
    .filter((label): label is string => label !== undefined && label.length > 0);

  return labels.length > 0 ? labels.join("; ") : "from code";
}

function isFromSession(session: string): boolean {
  return session !== "from code";
}

function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

function buildClaimsTimeline(claims: GraphViewClaimRow[]): GraphViewData["claimsTimeline"] {
  const batches = new Map<string, { memoryCommitId: string | null; createdAt: string | null; claims: GraphViewClaimRow[] }>();
  for (const claim of claims) {
    const key = claim.memoryCommitId ?? claim.createdAt ?? "unknown";
    if (!batches.has(key)) {
      batches.set(key, {
        memoryCommitId: claim.memoryCommitId,
        createdAt: claim.createdAt,
        claims: [],
      });
    }
    batches.get(key)?.claims.push(claim);
  }

  const sorted = [...batches.values()].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftTime - rightTime;
  });

  const events = sorted.map((batch) => {
    const added = batch.claims.length;
    const sessionCount = batch.claims.filter((claim) => isFromSession(claim.session)).length;
    const codeCount = added - sessionCount;
    return {
      memoryCommitId: batch.memoryCommitId,
      createdAt: batch.createdAt,
      added,
      sessionPct: percent(sessionCount, added),
      codePct: percent(codeCount, added),
    };
  });

  const total = claims.length;
  const totalSession = claims.filter((claim) => isFromSession(claim.session)).length;
  const totalCode = total - totalSession;

  return {
    summary: {
      total,
      sessionPct: percent(totalSession, total),
      codePct: percent(totalCode, total),
    },
    events: [...events].reverse(),
  };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// JSON.stringify does not escape "/", so a payload containing the literal
// substring "</script>" would close the embedding <script> tag early and let
// the remaining text be parsed as HTML. Escaping "<" keeps the JSON valid
// (JSON.parse and reading the tag's textContent are unaffected) while making
// it impossible for the payload to terminate the tag.
function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function kindColor(kind: string): string {
  return CLAIM_KIND_COLORS[kind] ?? "#cdd2da";
}

function renderClaimRow(claim: GraphViewClaimRow): string {
  const badge = `<span class="kind-badge" style="background:${kindColor(claim.kind)}">${escapeHtml(claim.kind)}</span>`;
  return `          <tr data-id="${escapeHtml(claim.id)}" data-kind="${escapeHtml(claim.kind)}" data-source="${escapeHtml(claim.source)}" data-freshness="${escapeHtml(claim.freshness)}" data-memory-commit-id="${escapeHtml(claim.memoryCommitId ?? "")}"><td class="claim-text">${escapeHtml(claim.text)}<div class="claim-id"><code>${escapeHtml(claim.id)}</code></div></td><td class="session">${escapeHtml(claim.session)}</td><td class="kind-cell">${badge}</td><td class="created">${escapeHtml(formatDateTime(claim.createdAt))}</td></tr>`;
}

function renderHtml(data: GraphViewData, title: string): string {
  const componentRows = data.components
    .map((component) => {
      const anchors =
        component.anchors.length > 0
          ? component.anchors.map((anchor) => `<code>${escapeHtml(anchor)}</code>`).join("<br>")
          : '<span class="muted">—</span>';
      const claimsCell =
        component.claimCount > 0
          ? `<a class="component-claims-link" href="#claims?component=${encodeURIComponent(component.id)}">${component.claimCount}</a>`
          : `${component.claimCount}`;
      return `          <tr data-id="${escapeHtml(component.id)}"><td>${escapeHtml(component.folder)}</td><td class="component-description">${escapeHtml(component.name)}</td><td class="anchors">${anchors}</td><td class="count">${component.flowCount}</td><td class="count">${claimsCell}</td><td class="count">${component.subcomponentCount}</td></tr>`;
    })
    .join("\n");

  const flowRows = data.flows
    .map((flow) => {
      const touchedComponents =
        flow.touchedComponentFolders.length > 0
          ? flow.touchedComponentFolders.map((folder) => `<code>${escapeHtml(folder)}</code>`).join("<br>")
          : '<span class="muted">—</span>';
      const claimsCell =
        flow.claimCount > 0
          ? `<a class="flow-claims-link" href="#claims?flow=${encodeURIComponent(flow.id)}">${flow.claimCount}</a>`
          : `${flow.claimCount}`;
      return `          <tr data-id="${escapeHtml(flow.id)}"><td>${escapeHtml(flow.folder)}</td><td class="flow-description">${escapeHtml(flow.name)}</td><td class="anchors">${touchedComponents}</td><td class="count">${claimsCell}</td></tr>`;
    })
    .join("\n");

  const claimRows = [...data.claims, ...data.supersededClaims].map(renderClaimRow).join("\n");

  const timeline = data.claimsTimeline;
  const timelineEvents = timeline.events
    .map((event) => {
      const inner = `<div class="tl-date">${escapeHtml(formatDateTime(event.createdAt))}</div>
              <div class="tl-stat">${event.added} claim${event.added === 1 ? "" : "s"} added · ${event.sessionPct}% session / ${event.codePct}% code</div>`;
      const body = event.memoryCommitId
        ? `<a class="tl-link" href="#claims?commit=${encodeURIComponent(event.memoryCommitId)}"><div class="tl-content">${inner}</div></a>`
        : `<div class="tl-content tl-content-static">${inner}</div>`;
      return `          <li class="tl-item">
            <span class="tl-dot" aria-hidden="true"></span>
            ${body}
          </li>`;
    })
    .join("\n");

  const defaultClaimsMeta = `${data.claims.length} active claims · session from evidenced_by source, otherwise from code`;
  const graphDataJson = jsonForScriptTag(data);
  const chartJsSource = readVendorScript("chart.js", "chart.umd.js");
  const chartDataLabelsSource = readVendorScript("chartjs-plugin-datalabels", "chartjs-plugin-datalabels.min.js");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --panel: #ffffff;
      --text: #1a1d26;
      --muted: #5c6573;
      --line: #d8dde6;
      --accent: #2f6fed;
      --accent-soft: #e8f0ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
    }
    nav {
      background: var(--panel);
      border-right: 1px solid var(--line);
      padding: 1.5rem 1rem;
    }
    nav h1 {
      font-size: 0.95rem;
      margin: 0 0 1rem;
      color: var(--muted);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    nav a {
      display: block;
      padding: 0.55rem 0.75rem;
      border-radius: 8px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.95rem;
    }
    nav a:hover { background: var(--bg); }
    nav a.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }
    nav a.nav-nested {
      padding-left: 1.65rem;
      font-size: 0.9rem;
      color: var(--muted);
    }
    nav a.nav-nested:hover {
      color: var(--text);
    }
    nav a.nav-nested.active {
      color: var(--accent);
    }
    main { padding: 2rem; }
    .view { display: none; }
    .view.active { display: block; }
    .view h2 {
      margin: 0 0 0.35rem;
      font-size: 1.5rem;
    }
    .view .meta {
      color: var(--muted);
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    table {
      width: 100%;
      max-width: 1200px;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
    }
    table.claims-table { max-width: 1400px; }
    table.flows-table { max-width: 1200px; }
    th, td {
      text-align: left;
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--line);
    }
    th {
      background: #f8f9fb;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: #fafbfc; }
    td.component-description { min-width: 220px; }
    td.flow-description { min-width: 220px; }
    table.flows-table td.flow-description {
      min-width: 280px;
      max-width: 460px;
      width: 38%;
    }
    table.flows-table td.anchors {
      min-width: 180px;
      width: 24%;
    }
    table.flows-table td.anchors code {
      white-space: nowrap;
      word-break: normal;
    }
    td.anchors {
      font-size: 0.82rem;
      line-height: 1.45;
      min-width: 200px;
    }
    td.anchors code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #3a4250;
      word-break: break-all;
    }
    td.count {
      text-align: center;
      font-variant-numeric: tabular-nums;
      color: var(--muted);
      width: 6rem;
    }
    th.count { text-align: center; width: 6rem; }
    a.component-claims-link {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      transition: color 0.15s;
    }
    a.component-claims-link:hover {
      color: var(--accent);
    }
    a.flow-claims-link {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      transition: color 0.15s;
    }
    a.flow-claims-link:hover {
      color: var(--accent);
    }
    td.claim-text { min-width: 320px; }
    td.claim-text .claim-id {
      margin-top: 0.35rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
    td.claim-text .claim-id code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    td.session { min-width: 180px; font-size: 0.9rem; }
    td.kind-cell { white-space: nowrap; }
    .kind-badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
      color: #fff;
      text-transform: capitalize;
    }
    td.created {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .muted { color: var(--muted); }
    .claims-search-wrap {
      max-width: 1400px;
      margin-top: 1.1rem;
      margin-bottom: 1rem;
    }
    .claims-search {
      width: 100%;
      max-width: 420px;
      padding: 0.6rem 0.85rem;
      font-size: 0.95rem;
      font-family: inherit;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
    }
    .claims-search:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .claims-meta .filter-clear {
      margin-left: 0.5rem;
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .claims-meta .filter-clear:hover { text-decoration: underline; }
    tr.claim-row-hidden { display: none; }
    /* Timeline */
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      position: relative;
      max-width: 640px;
    }
    .timeline::before {
      content: "";
      position: absolute;
      left: 7px;
      top: 6px;
      bottom: 6px;
      width: 2px;
      background: var(--line);
    }
    .tl-item {
      position: relative;
      padding: 0 0 2.25rem 2rem;
    }
    .tl-item:last-child { padding-bottom: 0; }
    .tl-dot {
      position: absolute;
      left: 0;
      top: 1rem;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--panel);
      border: 3px solid var(--accent);
      z-index: 1;
    }
    .tl-link {
      display: block;
      color: inherit;
      text-decoration: none;
    }
    .tl-content {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 0.9rem 1.1rem;
    }
    .tl-link:hover .tl-content,
    .tl-link:focus-visible .tl-content {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
    .tl-content-static {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 0.9rem 1.1rem;
    }
    .tl-date {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 0.1rem;
    }
    .tl-stat { font-size: 0.95rem; }
    /* Overview dashboard */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 2rem;
      width: 100%;
      max-width: 1280px;
      align-items: stretch;
    }
    .overview-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1.25rem 1.5rem 1rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
    }
    .overview-card h3 {
      margin: 0 0 1rem;
      font-size: 1.05rem;
      font-weight: 600;
      align-self: flex-start;
      width: 100%;
    }
    .overview-chart-wrap {
      position: relative;
      width: 260px;
      height: 260px;
      flex-shrink: 0;
    }
    .overview-chart-wrap canvas {
      display: block;
      width: 260px !important;
      height: 260px !important;
    }
    .overview-legend {
      list-style: none;
      margin: 1.5rem 0 0;
      padding: 0;
      width: 100%;
      max-width: 360px;
      min-height: 4.5rem;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      column-gap: 0.75rem;
      row-gap: 0.45rem;
      align-content: flex-start;
    }
    .overview-legend li {
      margin: 0;
      min-width: 0;
      flex: 0 0 calc(33.333% - 0.5rem);
      max-width: calc(33.333% - 0.5rem);
      display: flex;
      justify-content: center;
    }
    .overview-legend a {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: #5c6370;
      text-decoration: none;
      font-size: 15px;
      padding: 0.1rem 0.15rem;
      border-radius: 6px;
      white-space: nowrap;
      max-width: 100%;
    }
    .overview-legend a:hover { background: var(--bg); }
    .overview-legend .legend-swatch {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .overview-legend .legend-count {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    @media (max-width: 720px) {
      .layout { grid-template-columns: 1fr; }
      nav { border-right: none; border-bottom: 1px solid var(--line); }
      .overview-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <h1>Views</h1>
      <a href="#components" data-view="components">Components</a>
      <a href="#flows" data-view="flows">Flows</a>
      <a href="#claims" data-view="claims">Claims</a>
      <a href="#claims-timeline" data-view="claims-timeline" class="nav-nested">Claims - Timeline</a>
      <a href="#claims-overview" data-view="claims-overview" class="nav-nested">Claims - Overview</a>
    </nav>
    <main>
      <section id="view-components" class="view" data-view="components">
        <h2>Components</h2>
        <p class="meta">${data.components.length} top-level components · click to see claims</p>
        <table>
          <thead>
            <tr><th>Name</th><th>Description</th><th>Code Anchors</th><th class="count">Flows</th><th class="count">Claims</th><th class="count">Subcomponents</th></tr>
          </thead>
          <tbody>
${componentRows}
          </tbody>
        </table>
      </section>
      <section id="view-flows" class="view" data-view="flows">
        <h2>Flows</h2>
        <p class="meta">${data.flows.length} top-level flows · click to see claims</p>
        <table class="flows-table">
          <thead>
            <tr><th>Name</th><th>Description</th><th>Touched Components</th><th class="count">Claims</th></tr>
          </thead>
          <tbody>
${flowRows}
          </tbody>
        </table>
      </section>
      <section id="view-claims" class="view" data-view="claims">
        <h2>Claims</h2>
        <div class="claims-search-wrap">
          <input type="search" id="claims-search" class="claims-search" placeholder="Search by keyword" autocomplete="off" spellcheck="false">
        </div>
        <p class="meta claims-meta" id="claims-meta">${escapeHtml(defaultClaimsMeta)}</p>
        <table class="claims-table" id="claims-table">
          <thead>
            <tr><th>Claim</th><th>Session</th><th>Type</th><th>Created</th></tr>
          </thead>
          <tbody>
${claimRows}
          </tbody>
        </table>
      </section>
      <section id="view-claims-timeline" class="view" data-view="claims-timeline">
        <h2>Claims - Timeline</h2>
        <p class="meta">${data.counts.claims} Claims · ${timeline.events.length} memory commits · newest first · click to see claims</p>
        <ol class="timeline">
${timelineEvents}
        </ol>
      </section>
      <section id="view-claims-overview" class="view" data-view="claims-overview">
        <h2>Claims - Overview</h2>
        <p class="meta">Summary of ${data.counts.claims} active claims · click to see claims</p>
        <div class="overview-grid">
          <div class="overview-card">
            <h3>By Type</h3>
            <div class="overview-chart-wrap">
              <canvas id="chart-type" role="img" aria-label="Claims by type"></canvas>
            </div>
            <ul class="overview-legend" id="legend-type"></ul>
          </div>
          <div class="overview-card">
            <h3>By Source</h3>
            <div class="overview-chart-wrap">
              <canvas id="chart-source" role="img" aria-label="Claims by source"></canvas>
            </div>
            <ul class="overview-legend" id="legend-source"></ul>
          </div>
          <div class="overview-card">
            <h3>By Freshness</h3>
            <div class="overview-chart-wrap">
              <canvas id="chart-freshness" role="img" aria-label="Claims by freshness"></canvas>
            </div>
            <ul class="overview-legend" id="legend-freshness"></ul>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script id="graph-data" type="application/json">${graphDataJson}</script>
  <script>${chartJsSource}</script>
  <script>${chartDataLabelsSource}</script>
  <script>
    if (window.Chart && window.ChartDataLabels) {
      Chart.register(ChartDataLabels);
    }
    const graphData = JSON.parse(document.getElementById("graph-data").textContent);
    const links = document.querySelectorAll("nav a[data-view]");
    const views = document.querySelectorAll(".view[data-view]");
    const claimRows = document.querySelectorAll("#claims-table tbody tr[data-id]");
    const claimsMeta = document.getElementById("claims-meta");
    const claimsSearchInput = document.getElementById("claims-search");
    const defaultClaimsMeta = ${JSON.stringify(defaultClaimsMeta)};

    const CLAIM_KIND_ORDER = ${JSON.stringify(CLAIM_KIND_ORDER)};
    const CLAIM_KIND_COLORS = ${JSON.stringify(CLAIM_KIND_COLORS)};
    const SOURCE_COLORS = { code: "#4e79a7", session: "#f28e2b" };
    const FRESHNESS_COLORS = { active: "#59a14f", superseded: "#bab0ac" };

    const allClaims = graphData.claims.concat(graphData.supersededClaims);
    const claimTextById = new Map(allClaims.map((claim) => [claim.id, claim.text]));
    const componentIdsByClaim = new Map(graphData.claims.map((claim) => [claim.id, claim.componentIds || []]));
    const flowIdsByClaim = new Map(graphData.claims.map((claim) => [claim.id, claim.flowIds || []]));
    const componentNameById = new Map(graphData.components.map((component) => [component.id, component.name]));
    const flowNameById = new Map(graphData.flows.map((flow) => [flow.id, flow.name]));

    let activeFilter = null;

    function escapeHtmlClient(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function capitalizeLabel(value) {
      const text = String(value);
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    const overviewCharts = {};

    function resizeOverviewCharts() {
      requestAnimationFrame(() => {
        for (const chart of Object.values(overviewCharts)) chart.resize();
      });
    }

    function navigateToClaims(href) {
      if (claimsSearchInput) claimsSearchInput.value = "";
      history.replaceState(null, "", href);
      viewFromHash();
    }

    function setOverviewChartHighlight(canvasId, index) {
      const chart = overviewCharts[canvasId];
      if (!chart) return;
      if (index === null) {
        chart.setActiveElements([]);
        chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      } else {
        const active = [{ datasetIndex: 0, index }];
        chart.setActiveElements(active);
        const arc = chart.getDatasetMeta(0).data[index];
        const position = arc && typeof arc.x === "number" && typeof arc.y === "number"
          ? { x: arc.x, y: arc.y }
          : { x: chart.width / 2, y: chart.height / 2 };
        chart.tooltip.setActiveElements(active, position);
      }
      chart.update("none");
    }

    function wireOverviewLegendHover(legendId, canvasId) {
      const legend = document.getElementById(legendId);
      if (!legend || legend.dataset.hoverWired === "1") return;
      legend.dataset.hoverWired = "1";
      legend.dataset.canvasId = canvasId;
      legend.addEventListener("mouseover", (event) => {
        const link = event.target.closest("a.legend-link");
        if (!link || !legend.contains(link)) return;
        const item = link.closest("li");
        if (!item) return;
        const index = [...legend.querySelectorAll("li")].indexOf(item);
        if (index >= 0) setOverviewChartHighlight(legend.dataset.canvasId, index);
      });
      legend.addEventListener("mouseleave", () => {
        setOverviewChartHighlight(legend.dataset.canvasId, null);
      });
    }

    function renderOverviewLegend(legendId, slices) {
      const legend = document.getElementById(legendId);
      if (!legend) return;
      const drawn = slices.filter((slice) => slice.count > 0);
      if (drawn.length === 0) {
        legend.innerHTML = "";
        return;
      }
      legend.innerHTML = drawn
        .map(
          (slice) =>
            '<li><a href="' + slice.href + '" class="legend-link">' +
              '<span class="legend-swatch" style="background:' + slice.color + '"></span>' +
              '<span class="legend-label">' + escapeHtmlClient(capitalizeLabel(slice.label)) + "</span>" +
              '<span class="legend-count">' + slice.count + "</span>" +
            "</a></li>"
        )
        .join("");
    }

    function renderOverviewChart(canvasId, legendId, slices) {
      const drawn = slices.filter((slice) => slice.count > 0);
      const total = drawn.reduce((sum, slice) => sum + slice.count, 0);

      renderOverviewLegend(legendId, slices);

      const canvas = document.getElementById(canvasId);
      if (!canvas || typeof Chart === "undefined") return;

      if (!overviewCharts[canvasId]) {
        if (total === 0) return;

        canvas.width = 260;
        canvas.height = 260;

        overviewCharts[canvasId] = new Chart(canvas, {
        type: "pie",
        data: {
          labels: drawn.map((slice) => slice.label),
          datasets: [{
            data: drawn.map((slice) => slice.count),
            backgroundColor: drawn.map((slice) => slice.color),
            borderWidth: 0,
            hoverOffset: 0,
          }],
        },
        options: {
          responsive: false,
          animation: false,
          animations: {
            colors: false,
            numbers: false,
          },
          transitions: {
            active: { animation: { duration: 0 } },
          },
          onClick: (_event, elements) => {
            if (elements.length > 0) navigateToClaims(drawn[elements[0].index].href);
          },
          plugins: {
            legend: { display: false },
            datalabels: {
              color: "#fff",
              font: { weight: "600", size: 13 },
              formatter: (value, context) => {
                const data = context.chart.data.datasets[0].data;
                const sum = data.reduce((a, b) => a + b, 0);
                const pct = Math.round((value / sum) * 100);
                return pct >= 8 ? pct + "%" : "";
              },
            },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const sum = context.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = Math.round((context.parsed / sum) * 100);
                  return " " + context.parsed + " (" + pct + "%)";
                },
              },
            },
          },
        },
      });
      }

      wireOverviewLegendHover(legendId, canvasId);
    }

    function renderOverview() {
      const typeCounts = Object.fromEntries(CLAIM_KIND_ORDER.map((kind) => [kind, 0]));
      for (const claim of graphData.claims) {
        if (typeCounts[claim.kind] === undefined) typeCounts[claim.kind] = 0;
        typeCounts[claim.kind] += 1;
      }
      const typeSlices = Object.keys(typeCounts)
        .filter((kind) => typeCounts[kind] > 0)
        .map((kind) => ({
          label: kind,
          count: typeCounts[kind],
          color: CLAIM_KIND_COLORS[kind] || "#cdd2da",
          href: "#claims?kind=" + encodeURIComponent(kind),
        }));
      renderOverviewChart("chart-type", "legend-type", typeSlices);

      let codeCount = 0;
      let sessionCount = 0;
      for (const claim of graphData.claims) {
        if (claim.source === "session") sessionCount += 1;
        else codeCount += 1;
      }
      renderOverviewChart("chart-source", "legend-source", [
        { label: "from code", count: codeCount, color: SOURCE_COLORS.code, href: "#claims?source=code" },
        { label: "from session", count: sessionCount, color: SOURCE_COLORS.session, href: "#claims?source=session" },
      ]);

      renderOverviewChart("chart-freshness", "legend-freshness", [
        { label: "active", count: graphData.counts.claims, color: FRESHNESS_COLORS.active, href: "#claims?freshness=active" },
        { label: "superseded", count: graphData.counts.superseded, color: FRESHNESS_COLORS.superseded, href: "#claims?freshness=superseded" },
      ]);
    }

    function parseHash() {
      const raw = location.hash.replace(/^#/, "") || "components";
      const question = raw.indexOf("?");
      const viewId = question === -1 ? raw : raw.slice(0, question);
      const params = new URLSearchParams(question === -1 ? "" : raw.slice(question + 1));
      return { viewId: viewId || "components", params };
    }

    function filterFromParams(params) {
      for (const type of ["component", "flow", "kind", "source", "freshness", "commit"]) {
        const value = params.get(type);
        if (value) return { type, value };
      }
      return null;
    }

    function formatDateTimeClient(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function describeFilter(filter) {
      switch (filter.type) {
        case "component":
          return "about " + (componentNameById.get(filter.value) || filter.value);
        case "flow":
          return "about " + (flowNameById.get(filter.value) || filter.value);
        case "kind":
          return "of type " + filter.value;
        case "source":
          return filter.value === "session" ? "from session" : "from code";
        case "freshness":
          return filter.value === "superseded" ? "superseded" : "active";
        case "commit": {
          const event = graphData.claimsTimeline.events.find((item) => item.memoryCommitId === filter.value);
          if (event && event.createdAt) return "from commit on " + formatDateTimeClient(event.createdAt);
          return "from selected commit";
        }
        default:
          return "";
      }
    }

    function rowMatchesFilter(row, filter) {
      const freshness = row.dataset.freshness;
      if (!filter) return freshness === "active";
      if (filter.type === "freshness") return freshness === filter.value;
      if (freshness !== "active") return false;
      if (filter.type === "kind") return row.dataset.kind === filter.value;
      if (filter.type === "source") return row.dataset.source === filter.value;
      if (filter.type === "commit") return row.dataset.memoryCommitId === filter.value;
      if (filter.type === "component") {
        return (componentIdsByClaim.get(row.dataset.id) || []).includes(filter.value);
      }
      if (filter.type === "flow") {
        return (flowIdsByClaim.get(row.dataset.id) || []).includes(filter.value);
      }
      return true;
    }

    function applyClaims() {
      const query = (claimsSearchInput && claimsSearchInput.value ? claimsSearchInput.value : "").trim().toLowerCase();
      const filter = activeFilter;
      let visible = 0;
      for (const row of claimRows) {
        const id = row.dataset.id || "";
        const matchesFilter = rowMatchesFilter(row, filter);
        const text = (claimTextById.get(id) || "").toLowerCase();
        const matchesSearch = !query || id.toLowerCase().includes(query) || text.includes(query);
        const vis = matchesFilter && matchesSearch;
        row.classList.toggle("claim-row-hidden", !vis);
        if (vis) visible += 1;
      }
      if (!claimsMeta) return;

      if (!filter && !query) {
        claimsMeta.textContent = defaultClaimsMeta;
        return;
      }

      const base =
        filter && filter.type === "freshness" && filter.value === "superseded"
          ? graphData.counts.superseded
          : filter && filter.type === "commit"
            ? (graphData.claimsTimeline.events.find((item) => item.memoryCommitId === filter.value)?.added ?? graphData.counts.claims)
            : graphData.counts.claims;
      let meta = visible + " of " + base + " claims";
      if (filter) meta += " " + describeFilter(filter);
      if (query) meta += ' matching "' + escapeHtmlClient(query) + '"';
      meta += ' · <a class="filter-clear" href="#claims">Clear filter</a>';
      claimsMeta.innerHTML = meta;
    }

    function showView(viewId, filter) {
      for (const link of links) {
        link.classList.toggle("active", link.dataset.view === viewId);
      }
      for (const view of views) view.classList.toggle("active", view.dataset.view === viewId);
      if (viewId === "claims") {
        activeFilter = filter || null;
        applyClaims();
      }
      if (viewId === "claims-overview") {
        renderOverview();
        resizeOverviewCharts();
      }
    }

    function viewFromHash() {
      const { viewId, params } = parseHash();
      const resolvedView = [...views].some((view) => view.dataset.view === viewId) ? viewId : "components";
      showView(resolvedView, resolvedView === "claims" ? filterFromParams(params) : null);
    }

    for (const link of links) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        history.replaceState(null, "", "#" + link.dataset.view);
        viewFromHash();
      });
    }

    document.addEventListener("click", (event) => {
      const filterClear = event.target.closest("a.filter-clear");
      if (filterClear) {
        event.preventDefault();
        if (claimsSearchInput) claimsSearchInput.value = "";
        history.replaceState(null, "", "#claims");
        viewFromHash();
        return;
      }
      const filterLink = event.target.closest("a.legend-link, a.component-claims-link, a.flow-claims-link, a.tl-link");
      if (filterLink && filterLink.getAttribute("href") && filterLink.getAttribute("href").startsWith("#")) {
        event.preventDefault();
        if (claimsSearchInput) claimsSearchInput.value = "";
        history.replaceState(null, "", filterLink.getAttribute("href"));
        viewFromHash();
      }
    });

    if (claimsSearchInput) claimsSearchInput.addEventListener("input", applyClaims);

    const overviewNavLink = document.querySelector('nav a[data-view="claims-overview"]');
    if (overviewNavLink) {
      overviewNavLink.addEventListener("mouseenter", () => renderOverview(), { once: true });
    }

    window.addEventListener("hashchange", viewFromHash);
    viewFromHash();
  </script>
</body>
</html>
`;
}
