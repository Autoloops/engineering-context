import type { Claim } from "./claim.js";
import type { Edge } from "./edge.js";
import type { GraphReadResult } from "./service.js";
import type { Component, Flow, GraphObjectType, Source } from "./schema.js";

type GraphNodeType = "component" | "flow" | "claim" | "source";

interface ExportNode {
  id: string;
  type: GraphNodeType;
  label: string;
  detail: Record<string, string>;
  search: string;
}

interface ExportEdge {
  id: string;
  kind: Edge["kind"];
  from: string;
  fromType: GraphObjectType;
  to: string;
  toType: GraphObjectType;
  metadata?: Edge["metadata"];
}

interface HtmlGraphData {
  generatedAt: string;
  counts: {
    components: number;
    flows: number;
    claims: number;
    sources: number;
    edges: number;
  };
  nodes: ExportNode[];
  edges: ExportEdge[];
}

export function buildGraphHtmlExport(graph: GraphReadResult): string {
  return renderHtml(graphToHtmlData(graph));
}

function graphToHtmlData(graph: GraphReadResult): HtmlGraphData {
  const nodes: ExportNode[] = [
    ...graph.components.map(componentNode),
    ...graph.flows.map(flowNode),
    ...graph.claims.map(claimNode),
    ...graph.sources.map(sourceNode),
  ];

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      components: graph.components.length,
      flows: graph.flows.length,
      claims: graph.claims.length,
      sources: graph.sources.length,
      edges: graph.edges.length,
    },
    nodes,
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from_id,
      fromType: edge.from_type,
      to: edge.to_id,
      toType: edge.to_type,
      metadata: edge.metadata,
    })),
  };
}

function componentNode(component: Component): ExportNode {
  return node("component", component.id, component.name, {
    ID: component.id,
    Type: "component",
    Name: component.name,
    "Code anchor": component.code_anchor,
  });
}

function flowNode(flow: Flow): ExportNode {
  return node("flow", flow.id, flow.name, {
    ID: flow.id,
    Type: "flow",
    Name: flow.name,
  });
}

function claimNode(claim: Claim): ExportNode {
  return node("claim", claim.id, claim.text, {
    ID: claim.id,
    Type: "claim",
    Kind: claim.kind,
    Truth: claim.truth,
    Intent: claim.intent,
    Text: claim.text,
  });
}

function sourceNode(source: Source): ExportNode {
  const label = source.title ?? source.ref;
  return node("source", source.id, label, {
    ID: source.id,
    Type: "source",
    Kind: source.kind,
    Ref: source.ref,
    Title: source.title,
  });
}

function node(type: GraphNodeType, id: string, label: string, detail: Record<string, string | undefined>): ExportNode {
  const filteredDetail = Object.fromEntries(
    Object.entries(detail).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].length > 0),
  );
  const search = [id, label, ...Object.values(filteredDetail)].join(" ").toLowerCase();
  return { id, type, label, detail: filteredDetail, search };
}

function renderHtml(data: HtmlGraphData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Greplica Graph Export</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #080a0f;
}
button, input, textarea { font: inherit; }
button { color: inherit; }
::selection { background: rgba(91,141,239,0.3); }
.app {
  --left-column: 272px;
  --right-column: 312px;
  --bg: #0a0d13;
  --panel: #0e1219;
  --panel2: #11161f;
  --border: rgba(255,255,255,0.07);
  --border2: rgba(255,255,255,0.11);
  --text: #e9edf4;
  --dim: #98a2b1;
  --faint: #5d6675;
  --edge: rgba(255,255,255,0.16);
  --grid: rgba(255,255,255,0.045);
  --chip: rgba(255,255,255,0.05);
  --graphbg: #080a0f;
  --glowb: 9px;
  width: 100vw;
  height: 100vh;
  display: grid;
  grid-template-columns: var(--left-column) minmax(0, 1fr) var(--right-column);
  grid-template-rows: 56px minmax(0, 1fr);
  grid-template-areas:
    "topbar topbar topbar"
    "sidebar graph details";
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  font-feature-settings: "cv01", "ss01";
  transition:
    grid-template-columns 340ms cubic-bezier(0.4, 0, 0.2, 1),
    background 180ms ease,
    color 180ms ease;
}
.app.theme-light {
  --bg: #f3f5f8;
  --panel: #ffffff;
  --panel2: #fbfcfd;
  --border: rgba(12,18,26,0.09);
  --border2: rgba(12,18,26,0.14);
  --text: #141a22;
  --dim: #5a6573;
  --faint: #8b96a5;
  --edge: rgba(12,18,26,0.18);
  --grid: rgba(12,18,26,0.055);
  --chip: rgba(12,18,26,0.04);
  --graphbg: #eef1f5;
  --glowb: 4px;
}
.app.left-collapsed { --left-column: 0px; }
.app.right-collapsed { --right-column: 0px; }
.topbar {
  grid-area: topbar;
  min-width: 0;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 14.5px;
  letter-spacing: -0.2px;
  white-space: nowrap;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--dim);
  font-size: 13.5px;
}
.breadcrumb strong {
  min-width: 0;
  color: var(--text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-spacer { flex: 1; min-width: 12px; }
.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex: none;
}
.count-chip, .zoom-group, .graph-count {
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--dim);
}
.count-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 7px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.count-chip strong { color: var(--text); font-weight: 500; }
.gtbtn, .top-action, .zoom-group button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--chip);
  color: var(--dim);
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    color 150ms ease,
    transform 150ms ease;
}
.gtbtn {
  width: 32px;
  padding: 0;
}
.top-action {
  gap: 7px;
  padding: 0 11px;
  font-size: 12.5px;
  font-weight: 500;
}
.top-action svg {
  width: 12px;
  height: 12px;
}
.gtbtn:hover, .top-action:hover, .zoom-group button:hover {
  border-color: var(--border2);
  color: var(--text);
}
.top-action.active {
  border-color: rgba(91,141,239,0.5);
  background: rgba(91,141,239,0.14);
  color: #5b8def;
}
.zoom-group {
  display: flex;
  align-items: center;
  height: 32px;
  border-radius: 8px;
  overflow: hidden;
}
.zoom-group button {
  width: 30px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.zoom-group span {
  height: 100%;
  min-width: 54px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
#fit {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0;
}
.sidebar, .details {
  min-width: 0;
  overflow: auto;
  background: var(--panel);
  transition:
    opacity 220ms ease,
    transform 340ms cubic-bezier(0.4, 0, 0.2, 1);
}
.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
}
.details {
  grid-area: details;
  border-left: 1px solid var(--border);
}
.app.left-collapsed .sidebar,
.app.right-collapsed .details {
  opacity: 0;
  pointer-events: none;
  border-width: 0;
  overflow: hidden;
}
.app.left-collapsed .sidebar { transform: translateX(-18px); }
.app.right-collapsed .details { transform: translateX(18px); }
.sidebar-toggle {
  position: fixed;
  top: 76px;
  z-index: 5;
  width: 28px;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  color: var(--text);
  box-shadow: 0 8px 22px rgba(0,0,0,0.2);
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  transition:
    left 340ms cubic-bezier(0.4, 0, 0.2, 1),
    right 340ms cubic-bezier(0.4, 0, 0.2, 1),
    border-color 150ms ease,
    background 150ms ease;
}
.sidebar-toggle:hover {
  border-color: var(--border2);
  background: var(--panel);
}
.sidebar-toggle-left {
  left: var(--left-column);
  border-left: 0;
  border-radius: 0 8px 8px 0;
}
.sidebar-toggle-right {
  right: var(--right-column);
  border-right: 0;
  border-radius: 8px 0 0 8px;
}
.app.left-collapsed .sidebar-toggle-left { left: 0; }
.app.right-collapsed .sidebar-toggle-right { right: 0; }
.panel-pad { padding: 16px; }
.search-shell {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--panel2);
  color: var(--faint);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.search-shell:focus-within {
  border-color: rgba(91,141,239,0.48);
  background: var(--bg);
  box-shadow: 0 0 0 3px rgba(91,141,239,0.12);
}
.search-icon {
  width: 15px;
  height: 15px;
  color: var(--faint);
  flex: none;
}
.search-shell input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1;
}
.search-shell input::placeholder { color: var(--faint); }
.kbd {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 6px;
  color: var(--faint);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.stat-strip {
  display: flex;
  gap: 0;
  padding: 18px 16px;
}
.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}
.stat-value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.5px;
  font-feature-settings: "tnum";
}
.stat-label {
  color: var(--faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.panel-rule {
  height: 1px;
  background: var(--border);
  margin: 0 16px;
}
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 11px;
}
.panel-title {
  color: var(--dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.7px;
}
.panel-note {
  color: var(--faint);
  font-size: 11px;
}
.type-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.type-filter {
  width: 100%;
  height: 36px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.type-filter:hover, .type-filter.active { background: var(--chip); }
.type-filter.inactive { opacity: 0.42; }
.type-filter-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.type-filter-count {
  color: var(--dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.status-bar {
  margin-top: auto;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--faint);
  font-size: 11.5px;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2dba8a;
  box-shadow: 0 0 7px #2dba8a;
}
.graph-wrap {
  grid-area: graph;
  min-width: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  background:
    radial-gradient(circle at 52% 46%, rgba(91,141,239,0.10), transparent 55%),
    radial-gradient(var(--grid) 1px, transparent 1px),
    var(--graphbg);
  background-size: auto, 24px 24px, auto;
}
.graph-wrap:active { cursor: grabbing; }
svg {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  user-select: none;
}
.graph-count {
  position: absolute;
  left: 16px;
  bottom: 14px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 8px 13px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  backdrop-filter: blur(8px);
  font-size: 11px;
}
.legend-line {
  width: 18px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, #5b8def);
}
.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5b8def;
  box-shadow: 0 0 6px #5b8def;
}
.edge {
  fill: none;
  stroke-linecap: round;
  opacity: 0.62;
  transition: opacity 180ms ease, stroke-width 180ms ease;
}
.edge.dimmed { opacity: 0.12; }
.edge.related { opacity: 0.95; stroke-width: 2.4; }
.edge-label {
  display: none;
  fill: var(--dim);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  paint-order: stroke;
  stroke: var(--graphbg);
  stroke-width: 5px;
  stroke-linejoin: round;
}
.edge-label.related { display: block; }
.edge-particle { pointer-events: none; opacity: 0.9; }
.node {
  cursor: grab;
  color: var(--node-color);
  transform-box: fill-box;
  transform-origin: center;
  transition: opacity 180ms ease;
}
.node:active { cursor: grabbing; }
.node.dimmed { opacity: 0.26; }
.node-shape {
  fill: var(--node-fill);
  stroke: currentColor;
  filter: drop-shadow(0 0 var(--glowb) var(--node-glow));
}
.node:hover .node-shape { filter: brightness(1.18) drop-shadow(0 0 var(--glowb) var(--node-glow)); }
.node.selected .node-shape { stroke-width: 2.8; }
.node-pulse {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  pointer-events: none;
}
.node-label {
  fill: var(--text);
  font-size: 15.5px;
  font-weight: 500;
  letter-spacing: -0.2px;
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--graphbg);
  stroke-width: 5px;
  stroke-linejoin: round;
  pointer-events: none;
}
.node.selected .node-label {
  font-size: 17px;
  font-weight: 600;
}
.node-id {
  fill: var(--faint);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--graphbg);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.details-empty {
  padding: 18px;
}
.details-empty h2, .detail-title {
  margin: 0;
  color: var(--text);
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.4px;
  line-height: 1.25;
}
.details-empty p, .detail-desc {
  margin: 13px 0 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.55;
}
.detail-header {
  padding: 18px 18px 0;
}
.detail-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.detail-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border: 1px solid var(--node-fill);
  border-radius: 7px;
  background: var(--node-fill);
  color: var(--node-color);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  text-transform: capitalize;
}
.detail-badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.degree {
  color: var(--faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.detail-title {
  margin-top: 14px;
  overflow-wrap: anywhere;
}
.detail-id {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  color: var(--dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.detail-section {
  padding: 16px 18px;
}
.detail-list {
  display: grid;
  gap: 9px;
}
.detail-row dt {
  margin-bottom: 3px;
  color: var(--faint);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.55px;
}
.detail-row dd {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.relationship-group {
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--panel2);
  overflow: hidden;
}
.relationship-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 0 11px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel2) 82%, var(--bg));
}
.relationship-heading-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.relationship-heading strong {
  color: var(--dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.relationship-count {
  color: var(--faint);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.relationship-list {
  display: grid;
}
.relationship {
  width: 100%;
  min-height: 58px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto 14px;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: background 150ms ease;
}
.relationship:last-child {
  border-bottom: 0;
}
.relationship:hover {
  background: var(--chip);
}
.relationship-main {
  flex: 1;
  min-width: 0;
}
.relationship-name {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relationship-meta {
  margin-top: 3px;
  color: var(--faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relationship-edge {
  max-width: 96px;
  padding: 3px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--node-color) 30%, var(--border));
  background: var(--node-fill);
  color: var(--node-color);
  font-size: 10.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  color: var(--dim);
  font-size: 13px;
  line-height: 1.5;
}
@keyframes node-pop {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes g-pulse {
  0% { transform: scale(1); opacity: 0.5; }
  70% { transform: scale(1.5); opacity: 0; }
  100% { opacity: 0; }
}
@keyframes edge-fade {
  from { opacity: 0; }
  to { opacity: 0.62; }
}
@media (prefers-reduced-motion: no-preference) {
  .node {
    animation: node-pop 500ms cubic-bezier(0.2, 0.9, 0.3, 1) backwards;
    animation-delay: var(--node-delay, 0ms);
  }
  .node-pulse {
    animation: g-pulse 2400ms ease-out infinite;
  }
  .edge {
    animation: edge-fade 420ms ease-out backwards;
    animation-delay: var(--edge-delay, 0ms);
  }
}
@media (prefers-reduced-motion: reduce) {
  .edge-particle { display: none; }
  .app, .sidebar, .details, .sidebar-toggle { transition: none; }
}
@media (max-width: 920px) {
  .app {
    --left-column: 0px;
    --right-column: 0px;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 56px minmax(0, 1fr);
    grid-template-areas:
      "topbar"
      "graph";
  }
  .sidebar, .details { position: fixed; top: 56px; bottom: 0; z-index: 4; width: min(84vw, 320px); }
  .sidebar { left: 0; }
  .details { right: 0; }
  .app:not(.left-collapsed) .sidebar { transform: translateX(0); opacity: 1; pointer-events: auto; }
  .app:not(.right-collapsed) .details { transform: translateX(0); opacity: 1; pointer-events: auto; }
  .app.left-collapsed .sidebar { transform: translateX(-100%); }
  .app.right-collapsed .details { transform: translateX(100%); }
  .app:not(.left-collapsed) .sidebar-toggle-left { left: min(84vw, 320px); }
  .app:not(.right-collapsed) .sidebar-toggle-right { right: min(84vw, 320px); }
  .app.left-collapsed .sidebar-toggle-left { left: 0; }
  .app.right-collapsed .sidebar-toggle-right { right: 0; }
  .breadcrumb, .divider, .top-action span { display: none; }
}
</style>
</head>
<body>
<div class="app theme-dark right-collapsed" id="app">
  <header class="topbar">
    <div class="brand">
      <span>Greplica</span>
    </div>
    <div class="divider"></div>
    <div class="breadcrumb"><span>Graphs</span><span>/</span><strong>Current graph view</strong></div>
    <div class="count-chip"><strong id="top-node-count">0</strong> nodes <span>·</span> <strong id="top-edge-count">0</strong> edges</div>
    <div class="top-spacer"></div>
    <button id="focus-toggle" class="top-action" type="button" title="Toggle focus mode" aria-pressed="false">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <span>Focus</span>
    </button>
    <div class="zoom-group" aria-label="Zoom controls">
      <button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">-</button>
      <span id="zoom-label">100%</span>
      <button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
    </div>
    <button id="fit" class="gtbtn" type="button" title="Fit graph" aria-label="Fit graph">Fit</button>
    <button id="theme-toggle" class="gtbtn" type="button" title="Toggle theme" aria-label="Toggle theme">☾</button>
  </header>

  <aside class="sidebar">
    <div class="panel-pad">
      <div class="search-shell">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="search" type="search" placeholder="Search nodes" autocomplete="off" aria-label="Search nodes">
        <span class="kbd" aria-hidden="true"><span>⌘</span><span>K</span></span>
      </div>
    </div>
    <div class="stat-strip" id="stats"></div>
    <div class="panel-rule"></div>
    <div class="panel-pad">
      <div class="panel-title-row">
        <span class="panel-title">Node Types</span>
        <span class="panel-note" id="active-types">4 active</span>
      </div>
      <div class="type-list" id="filters"></div>
    </div>
    <div class="status-bar">
      <span class="status-dot"></span>
      <span id="layout-status">Force layout · live</span>
    </div>
  </aside>
  <button id="toggle-left" class="sidebar-toggle sidebar-toggle-left" type="button" title="Collapse left sidebar" aria-label="Collapse left sidebar">←</button>

  <main class="graph-wrap">
    <svg id="graph" role="img" aria-label="Greplica graph visualization"></svg>
    <div class="graph-count" id="result-count"></div>
  </main>

  <button id="toggle-right" class="sidebar-toggle sidebar-toggle-right" type="button" title="Show right sidebar" aria-label="Show right sidebar">←</button>
  <aside class="details" id="details"></aside>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script id="graph-data" type="application/json">${escapeJsonForHtml(data)}</script>
<script>
(function () {
  'use strict';

  var data = JSON.parse(document.getElementById('graph-data').textContent);
  var typeOrder = ['component', 'flow', 'claim', 'source'];
  var typeMeta = {
    component: { name: 'Component', color: '#5b8def', fill: 'rgba(91,141,239,0.16)' },
    flow: { name: 'Flow', color: '#2dba8a', fill: 'rgba(45,186,138,0.16)' },
    claim: { name: 'Claim', color: '#e0a33e', fill: 'rgba(224,163,62,0.16)' },
    source: { name: 'Source', color: '#a974f0', fill: 'rgba(169,116,240,0.16)' }
  };
  var nodes = data.nodes.map(function (node) {
    return Object.assign({}, node, { x: 0, y: 0, visible: true, degree: 0 });
  });
  var edges = data.edges.slice();
  var nodeById = new Map(nodes.map(function (node) { return [node.id, node]; }));
  edges.forEach(function (edge) {
    var from = nodeById.get(edge.from);
    var to = nodeById.get(edge.to);
    if (from) from.degree += 1;
    if (to) to.degree += 1;
  });

  var selectedId = null;
  var focusMode = false;
  var visibleTypes = new Set(typeOrder);
  var searchText = '';
  var app = document.getElementById('app');
  var graphWrap = document.querySelector('.graph-wrap');
  var svg = document.getElementById('graph');
  var search = document.getElementById('search');
  var filters = document.getElementById('filters');
  var details = document.getElementById('details');
  var resultCount = document.getElementById('result-count');
  var stats = document.getElementById('stats');
  var activeTypes = document.getElementById('active-types');
  var layoutStatus = document.getElementById('layout-status');
  var topNodeCount = document.getElementById('top-node-count');
  var topEdgeCount = document.getElementById('top-edge-count');
  var zoomLabel = document.getElementById('zoom-label');
  var focusToggle = document.getElementById('focus-toggle');
  var themeToggle = document.getElementById('theme-toggle');
  var layout = { width: 1000, height: 720, minX: 0, minY: 0, maxX: 1000, maxY: 720 };
  var viewBox = { x: 0, y: 0, width: 1000, height: 720 };
  var fitWidth = 1000;
  var panDrag = null;
  var nodeDrag = null;
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canUsePhysics = !reducedMotion && hasD3Force(window.d3);
  var forceSimulation = null;
  var simulationFitApplied = false;

  setTheme(readTheme());
  renderStats();
  renderFilters();
  layoutNodes();
  render({ fit: true });
  wireEvents();
  startSimulation();

  function wireEvents() {
    search.addEventListener('input', function () {
      searchText = search.value.trim().toLowerCase();
      render({ fit: true });
    });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        search.value = '';
        searchText = '';
        render({ fit: true });
      }
    });
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (app.classList.contains('left-collapsed')) {
          app.classList.remove('left-collapsed');
          syncSidebarToggles();
          refitGraphSoon();
        }
        search.focus();
        search.select();
      }
    });
    document.getElementById('fit').addEventListener('click', function () {
      render({ fit: true });
    });
    document.getElementById('zoom-in').addEventListener('click', function () {
      zoomGraph(0.82);
    });
    document.getElementById('zoom-out').addEventListener('click', function () {
      zoomGraph(1.22);
    });
    document.getElementById('toggle-left').addEventListener('click', function () {
      app.classList.toggle('left-collapsed');
      syncSidebarToggles();
      refitGraphSoon();
    });
    document.getElementById('toggle-right').addEventListener('click', function () {
      app.classList.toggle('right-collapsed');
      syncSidebarToggles();
      refitGraphSoon();
    });
    focusToggle.addEventListener('click', function () {
      focusMode = !focusMode;
      syncFocusButton();
      updateSelectionStyles();
    });
    themeToggle.addEventListener('click', function () {
      setTheme(app.classList.contains('theme-dark') ? 'light' : 'dark');
    });
    graphWrap.addEventListener('wheel', function (event) {
      event.preventDefault();
      var delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      if (event.deltaMode === 2) delta *= 100;
      var scale = Math.max(0.55, Math.min(1.8, Math.exp(delta * 0.0026)));
      zoomGraphAt(scale, clientToGraphPoint(event));
    }, { passive: false });
    graphWrap.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || closestTarget(event.target, '.node, button, input')) return;
      panDrag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewBox: Object.assign({}, viewBox)
      };
      capturePointer(graphWrap, event.pointerId);
    });
    graphWrap.addEventListener('pointermove', function (event) {
      if (!panDrag || panDrag.pointerId !== event.pointerId) return;
      var rect = svg.getBoundingClientRect();
      var dx = (event.clientX - panDrag.startClientX) / rect.width * panDrag.startViewBox.width;
      var dy = (event.clientY - panDrag.startClientY) / rect.height * panDrag.startViewBox.height;
      viewBox.x = panDrag.startViewBox.x - dx;
      viewBox.y = panDrag.startViewBox.y - dy;
      applyViewBox();
    });
    graphWrap.addEventListener('pointerup', endPan);
    graphWrap.addEventListener('pointercancel', endPan);
    syncSidebarToggles();
    syncFocusButton();
  }

  function endPan(event) {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    panDrag = null;
    releasePointer(graphWrap, event.pointerId);
  }

  function renderStats() {
    var entries = [
      ['Nodes', nodes.length],
      ['Edges', data.counts.edges],
      ['Types', typeOrder.filter(function (type) { return (data.counts[type + 's'] || 0) > 0; }).length]
    ];
    stats.replaceChildren();
    entries.forEach(function (entry) {
      var item = element('div', 'stat');
      item.append(element('span', 'stat-value', String(entry[1])), element('span', 'stat-label', entry[0]));
      stats.append(item);
    });
  }

  function renderFilters() {
    filters.replaceChildren();
    typeOrder.forEach(function (type) {
      var meta = typeMeta[type];
      var count = nodes.filter(function (node) { return node.type === type; }).length;
      var button = element('button', 'type-filter active');
      button.type = 'button';
      button.setAttribute('data-type-filter', type);
      button.append(typeGlyph(type, 16), element('span', 'type-filter-name', meta.name), element('span', 'type-filter-count', String(count)));
      button.addEventListener('click', function () {
        if (visibleTypes.has(type)) {
          visibleTypes.delete(type);
        } else {
          visibleTypes.add(type);
        }
        syncFilterInputs();
        render({ fit: true });
      });
      filters.append(button);
    });
    syncFilterInputs();
  }

  function layoutNodes() {
    var groups = groupByType(nodes);
    var columns = typeOrder.filter(function (type) {
      return (groups.get(type) || []).length > 0;
    });
    if (columns.length === 0) {
      layout = { width: 1000, height: 720, minX: 0, minY: 0, maxX: 1000, maxY: 720 };
      return;
    }

    var typeGap = 260;
    var laneGap = 170;
    var rowGap = 132;
    var marginX = 280;
    var marginY = 210;
    var maxRows = 1;
    var cursorX = marginX;
    columns.forEach(function (type, columnIndex) {
      var group = groups.get(type) || [];
      var rowsInBlock = Math.max(1, Math.min(group.length, Math.max(4, Math.ceil(group.length / 2))));
      var lanes = Math.max(1, Math.ceil(group.length / rowsInBlock));
      maxRows = Math.max(maxRows, rowsInBlock);
      group.sort(function (left, right) { return left.label.localeCompare(right.label) || left.id.localeCompare(right.id); });
      group.forEach(function (node, rowIndex) {
        var laneIndex = Math.floor(rowIndex / rowsInBlock);
        var slotIndex = rowIndex % rowsInBlock;
        node.x = cursorX + laneIndex * laneGap;
        node.y = marginY + slotIndex * rowGap + (laneIndex % 2) * 24;
        node.homeX = node.x;
        node.homeY = node.y;
      });
      cursorX += lanes * laneGap + (columnIndex === columns.length - 1 ? 0 : typeGap);
    });

    if (!canUsePhysics) relaxLayout(180);
    layout = boundsFor(nodes, Math.max(1000, cursorX + marginX - typeGap), Math.max(720, marginY * 2 + (maxRows - 1) * rowGap));
  }

  function startSimulation() {
    if (!canUsePhysics || nodes.length === 0) {
      layoutStatus.textContent = reducedMotion ? 'Static layout · reduced motion' : 'Static layout · offline';
      return;
    }
    var d3 = window.d3;
    var simulationLinks = edges
      .filter(function (edge) { return nodeById.has(edge.from) && nodeById.has(edge.to); })
      .map(function (edge) {
        return { id: edge.id, kind: edge.kind, source: edge.from, target: edge.to };
      });

    try {
      forceSimulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(simulationLinks)
          .id(function (node) { return node.id; })
          .distance(function (edge) { return edge.kind === 'contains' ? 110 : 150; })
          .strength(0.035))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('collide', d3.forceCollide(function (node) { return nodeRadius(node) + 28; }).strength(0.82))
        .force('x', d3.forceX(function (node) { return node.homeX; }).strength(0.32))
        .force('y', d3.forceY(function (node) { return node.homeY; }).strength(0.34))
        .alpha(0.9)
        .alphaMin(0.015)
        .on('tick', updateGraphGeometry)
        .on('end', function () {
          layout = boundsFor(nodes, layout.width, layout.height);
          layoutStatus.textContent = 'Force layout · settled';
          if (!simulationFitApplied) {
            fitGraph();
            applyViewBox();
            simulationFitApplied = true;
          }
        });
    } catch (error) {
      canUsePhysics = false;
      forceSimulation = null;
      relaxLayout(180);
      layout = boundsFor(nodes, layout.width, layout.height);
      render({ fit: true });
      layoutStatus.textContent = 'Static layout · fallback';
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('Falling back to static graph layout:', error);
      }
    }
  }

  function wakeSimulation(alphaTarget) {
    if (!forceSimulation) return;
    layoutStatus.textContent = 'Force layout · live';
    forceSimulation.alphaTarget(alphaTarget).restart();
  }

  function relaxLayout(iterations) {
    if (nodes.length < 2) return;
    for (var step = 0; step < iterations; step += 1) {
      var alpha = 0.18 * (1 - step / iterations);
      nodes.forEach(function (a, aIndex) {
        for (var bIndex = aIndex + 1; bIndex < nodes.length; bIndex += 1) {
          var b = nodes[bIndex];
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var distance = Math.sqrt(dx * dx + dy * dy) || 1;
          var target = 150;
          if (distance >= target) continue;
          var push = (target - distance) * alpha;
          var nx = dx / distance;
          var ny = dy / distance;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
        }
      });

      edges.forEach(function (edge) {
        var from = nodeById.get(edge.from);
        var to = nodeById.get(edge.to);
        if (!from || !to) return;
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var distance = Math.sqrt(dx * dx + dy * dy) || 1;
        var target = edge.kind === 'contains' ? 210 : 280;
        var pull = (distance - target) * alpha * 0.018;
        var nx = dx / distance;
        var ny = dy / distance;
        from.x += nx * pull;
        from.y += ny * pull;
        to.x -= nx * pull;
        to.y -= ny * pull;
      });

      nodes.forEach(function (node) {
        if (node.homeX === undefined || node.homeY === undefined) return;
        node.x += (node.homeX - node.x) * alpha * 0.26;
        node.y += (node.homeY - node.y) * alpha * 0.26;
      });
    }
  }

  function render(options) {
    options = options || {};
    applyVisibility();
    if (selectedId !== null) {
      var selected = nodeById.get(selectedId);
      if (!selected || !selected.visible) selectedId = null;
    }
    if (options.fit) fitGraph();

    svg.replaceChildren();
    addDefs();
    renderEdges();
    renderNodes();
    applyViewBox();
    renderDetails();
    updateResultCount();
    syncFilterInputs();
    syncFocusButton();
  }

  function applyVisibility() {
    nodes.forEach(function (node) {
      var matchesType = visibleTypes.has(node.type);
      var matchesSearch = searchText.length === 0 || node.search.indexOf(searchText) !== -1;
      node.visible = matchesType && matchesSearch;
    });
  }

  function renderEdges() {
    var layer = svgEl('g');
    svg.append(layer);
    edges.forEach(function (edge, edgeIndex) {
      var from = nodeById.get(edge.from);
      var to = nodeById.get(edge.to);
      if (!from || !to || !from.visible || !to.visible) return;
      var related = isRelatedEdge(edge);
      var dimmed = isDimmedEdge(edge);
      var meta = typeMeta[from.type] || typeMeta.component;
      var path = svgEl('path');
      path.setAttribute('class', 'edge edge-' + edge.kind + (related ? ' related' : '') + (dimmed ? ' dimmed' : ''));
      path.setAttribute('data-edge-index', String(edgeIndex));
      path.setAttribute('marker-end', 'url(#arrow-' + from.type + ')');
      path.setAttribute('stroke', meta.color);
      path.setAttribute('stroke-width', related ? '2.4' : '1.6');
      path.setAttribute('stroke-dasharray', edge.kind === 'evidenced_by' || edge.kind === 'supersedes' ? '2 6' : '0');
      path.style.setProperty('--edge-delay', Math.min(edgeIndex * 18, 520) + 'ms');
      path.setAttribute('d', edgePath(from, to));
      layer.append(path);

      if (!reducedMotion) {
        var particle = svgEl('circle');
        particle.setAttribute('class', 'edge-particle' + (dimmed ? ' dimmed' : ''));
        particle.setAttribute('r', related ? '3' : '2.2');
        particle.setAttribute('fill', meta.color);
        particle.setAttribute('data-edge-particle-index', String(edgeIndex));
        var motion = svgEl('animateMotion');
        motion.setAttribute('dur', Math.max(2.2, edgeLength(from, to) * 0.004).toFixed(2) + 's');
        motion.setAttribute('begin', (edgeIndex * 0.18).toFixed(2) + 's');
        motion.setAttribute('repeatCount', 'indefinite');
        motion.setAttribute('path', edgePath(from, to));
        particle.append(motion);
        layer.append(particle);
      }

      var label = svgEl('text');
      label.setAttribute('class', 'edge-label' + (related ? ' related' : ''));
      label.setAttribute('data-edge-label-index', String(edgeIndex));
      label.setAttribute('x', String((from.x + to.x) / 2));
      label.setAttribute('y', String((from.y + to.y) / 2 - 6));
      label.textContent = edge.kind;
      layer.append(label);
    });
  }

  function renderNodes() {
    var layer = svgEl('g');
    svg.append(layer);
    nodes.forEach(function (node) {
      if (!node.visible) return;
      var meta = typeMeta[node.type] || typeMeta.component;
      var size = nodeRadius(node);
      var group = svgEl('g');
      group.setAttribute('class', nodeClass(node));
      group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
      group.setAttribute('data-node-id', node.id);
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', node.type + ' ' + node.id);
      group.style.setProperty('--node-delay', Math.min(layer.childElementCount * 36, 720) + 'ms');
      group.style.setProperty('--node-color', meta.color);
      group.style.setProperty('--node-fill', meta.fill);
      group.style.setProperty('--node-glow', meta.color);
      group.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.stopPropagation();
        selectedId = node.id;
        focusMode = true;
        revealDetailsPanel();
        updateSelectionStyles();
        renderDetails();
        syncFocusButton();
        var point = clientToGraphPoint(event);
        if (forceSimulation) {
          node.fx = point.x;
          node.fy = point.y;
          wakeSimulation(0.3);
        }
        nodeDrag = {
          pointerId: event.pointerId,
          node: node,
          startX: point.x,
          startY: point.y,
          originalX: node.x,
          originalY: node.y
        };
        capturePointer(group, event.pointerId);
      });
      group.addEventListener('pointermove', function (event) {
        if (!nodeDrag || nodeDrag.pointerId !== event.pointerId || nodeDrag.node.id !== node.id) return;
        var point = clientToGraphPoint(event);
        if (forceSimulation) {
          node.fx = point.x;
          node.fy = point.y;
          node.x = point.x;
          node.y = point.y;
          wakeSimulation(0.3);
        } else {
          node.x = nodeDrag.originalX + point.x - nodeDrag.startX;
          node.y = nodeDrag.originalY + point.y - nodeDrag.startY;
        }
        updateGraphGeometry();
      });
      group.addEventListener('pointerup', function (event) {
        endNodeDrag(event, group);
      });
      group.addEventListener('pointercancel', function (event) {
        endNodeDrag(event, group);
      });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectedId = node.id;
          focusMode = true;
          revealDetailsPanel();
          render();
        }
      });

      if (node.id === selectedId) {
        var pulse = svgEl('circle');
        pulse.setAttribute('class', 'node-pulse');
        pulse.setAttribute('r', String(size + 6));
        group.append(pulse);
      }
      group.append(nodeShape(node, size));
      var label = svgEl('text');
      label.setAttribute('class', 'node-label');
      label.setAttribute('y', String(size + 19));
      label.textContent = shortText(node.label, node.id === selectedId ? 34 : 26);
      group.append(label);
      var id = svgEl('text');
      id.setAttribute('class', 'node-id');
      id.setAttribute('y', String(size + 34));
      id.textContent = shortText(node.id, 30);
      group.append(id);
      layer.append(group);
    });
  }

  function endNodeDrag(event, group) {
    if (!nodeDrag || nodeDrag.pointerId !== event.pointerId) return;
    if (forceSimulation) {
      nodeDrag.node.fx = null;
      nodeDrag.node.fy = null;
      forceSimulation.alphaTarget(0);
    }
    nodeDrag = null;
    releasePointer(group, event.pointerId);
  }

  function updateGraphGeometry() {
    nodes.forEach(function (node) {
      if (!node.visible) return;
      var group = nodeElement(node.id);
      if (group) group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
    });
    edges.forEach(function (edge, edgeIndex) {
      var from = nodeById.get(edge.from);
      var to = nodeById.get(edge.to);
      if (!from || !to) return;
      var pathValue = edgePath(from, to);
      var path = svg.querySelector('[data-edge-index="' + edgeIndex + '"]');
      if (path) path.setAttribute('d', pathValue);
      var motion = svg.querySelector('[data-edge-particle-index="' + edgeIndex + '"] animateMotion');
      if (motion) motion.setAttribute('path', pathValue);
      var label = svg.querySelector('[data-edge-label-index="' + edgeIndex + '"]');
      if (label) {
        label.setAttribute('x', String((from.x + to.x) / 2));
        label.setAttribute('y', String((from.y + to.y) / 2 - 6));
      }
    });
  }

  function updateSelectionStyles() {
    nodes.forEach(function (node) {
      var group = nodeElement(node.id);
      if (group) group.setAttribute('class', nodeClass(node));
    });
    edges.forEach(function (edge, edgeIndex) {
      var from = nodeById.get(edge.from);
      var related = isRelatedEdge(edge);
      var dimmed = isDimmedEdge(edge);
      var path = svg.querySelector('[data-edge-index="' + edgeIndex + '"]');
      if (path && from) {
        path.setAttribute('class', 'edge edge-' + edge.kind + (related ? ' related' : '') + (dimmed ? ' dimmed' : ''));
        path.setAttribute('stroke-width', related ? '2.4' : '1.6');
      }
      var particle = svg.querySelector('[data-edge-particle-index="' + edgeIndex + '"]');
      if (particle) particle.setAttribute('class', 'edge-particle' + (dimmed ? ' dimmed' : ''));
      var label = svg.querySelector('[data-edge-label-index="' + edgeIndex + '"]');
      if (label) label.setAttribute('class', 'edge-label' + (related ? ' related' : ''));
    });
  }

  function renderDetails() {
    details.replaceChildren();
    var node = selectedId === null ? null : nodeById.get(selectedId);
    if (!node) {
      var empty = element('section', 'details-empty');
      empty.append(element('h2', '', 'No node selected'), element('p', '', 'Select a visible node to inspect its fields and immediate relationships.'));
      details.append(empty);
      return;
    }

    var meta = typeMeta[node.type] || typeMeta.component;
    var header = element('section', 'detail-header');
    header.style.setProperty('--node-color', meta.color);
    header.style.setProperty('--node-fill', meta.fill);
    var top = element('div', 'detail-row-top');
    var badge = element('span', 'detail-badge');
    badge.append(element('span', 'detail-badge-dot'), document.createTextNode(meta.name));
    top.append(badge, element('span', 'degree', 'deg ' + node.degree));
    header.append(top, element('h2', 'detail-title', node.label), element('div', 'detail-id', node.id), element('p', 'detail-desc', detailDescription(node)));
    details.append(header);

    var info = element('section', 'detail-section');
    var dl = element('dl', 'detail-list');
    Object.entries(node.detail).forEach(function (entry) {
      var row = element('div', 'detail-row');
      row.append(element('dt', '', entry[0]), element('dd', '', entry[1]));
      dl.append(row);
    });
    info.append(dl);
    details.append(info);

    var relationPanel = element('section', 'detail-section');
    var titleRow = element('div', 'panel-title-row');
    var relationships = immediateRelationships(node.id);
    titleRow.append(element('span', 'panel-title', 'Relationships'), element('span', 'panel-note', String(relationships.length)));
    relationPanel.append(titleRow);
    var outgoing = relationships.filter(function (relationship) { return relationship.direction === 'outgoing'; });
    var incoming = relationships.filter(function (relationship) { return relationship.direction === 'incoming'; });
    if (relationships.length === 0) {
      relationPanel.append(element('p', 'empty', 'No immediate relationships.'));
    } else {
      if (outgoing.length) relationPanel.append(relationshipGroup('→', 'Outgoing', outgoing, meta.color));
      if (incoming.length) relationPanel.append(relationshipGroup('←', 'Incoming', incoming, 'var(--dim)'));
    }
    details.append(relationPanel);
  }

  function relationshipGroup(arrow, label, relationships, color) {
    var group = element('div', 'relationship-group');
    var heading = element('div', 'relationship-heading');
    var headingLabel = element('span', 'relationship-heading-label');
    var arrowNode = element('span', '', arrow);
    arrowNode.style.color = color;
    headingLabel.append(arrowNode, element('strong', '', label));
    heading.append(headingLabel, element('span', 'relationship-count', String(relationships.length)));
    var list = element('div', 'relationship-list');
    relationships.forEach(function (relationship) {
      list.append(relationshipButton(relationship));
    });
    group.append(heading, list);
    return group;
  }

  function relationshipButton(relationship) {
    var other = relationship.other;
    var otherMeta = other ? typeMeta[other.type] : typeMeta.component;
    var button = element('button', 'relationship');
    button.type = 'button';
    button.append(typeGlyph(other ? other.type : 'component', 15));
    var main = element('div', 'relationship-main');
    main.append(
      element('div', 'relationship-name', other ? other.label : relationship.otherId),
      element('div', 'relationship-meta', (other ? typeMeta[other.type].name : 'Node') + ' · ' + relationship.edge.id)
    );
    var edgeKind = element('span', 'relationship-edge', relationship.edge.kind);
    var chevron = svgIcon('M9 6l6 6-6 6');
    chevron.style.color = 'var(--faint)';
    button.append(main, edgeKind, chevron);
    button.style.setProperty('--node-color', otherMeta.color);
    button.style.setProperty('--node-fill', otherMeta.fill);
    button.addEventListener('click', function () {
      if (!other) return;
      selectedId = other.id;
      focusMode = true;
      if (!visibleTypes.has(other.type)) visibleTypes.add(other.type);
      search.value = '';
      searchText = '';
      syncFilterInputs();
      revealDetailsPanel();
      render({ fit: true });
    });
    return button;
  }

  function immediateRelationships(nodeId) {
    return edges
      .filter(function (edge) { return edge.from === nodeId || edge.to === nodeId; })
      .map(function (edge) {
        var outgoing = edge.from === nodeId;
        var otherId = outgoing ? edge.to : edge.from;
        return { edge: edge, direction: outgoing ? 'outgoing' : 'incoming', otherId: otherId, other: nodeById.get(otherId) };
      })
      .sort(function (left, right) {
        return left.direction.localeCompare(right.direction) || left.edge.kind.localeCompare(right.edge.kind) || left.otherId.localeCompare(right.otherId);
      });
  }

  function updateResultCount() {
    var visibleNodes = nodes.filter(function (node) { return node.visible; }).length;
    var visibleEdges = edges.filter(function (edge) {
      var from = nodeById.get(edge.from);
      var to = nodeById.get(edge.to);
      return from && to && from.visible && to.visible;
    }).length;
    resultCount.replaceChildren();
    resultCount.append(
      legendItem('line', 'relationship'),
      legendItem('dot', 'flow direction'),
      document.createTextNode(visibleNodes + ' nodes · ' + visibleEdges + ' edges')
    );
    topNodeCount.textContent = String(visibleNodes);
    topEdgeCount.textContent = String(visibleEdges);
    activeTypes.textContent = visibleTypes.size + ' active';
  }

  function addDefs() {
    var defs = svgEl('defs');
    typeOrder.forEach(function (type) {
      var marker = svgEl('marker');
      marker.setAttribute('id', 'arrow-' + type);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      var arrow = svgEl('path');
      arrow.setAttribute('d', 'M0 0L10 5L0 10z');
      arrow.setAttribute('fill', typeMeta[type].color);
      marker.append(arrow);
      defs.append(marker);
    });
    svg.append(defs);
  }

  function nodeClass(node) {
    var classes = ['node', node.type];
    if (node.id === selectedId) classes.push('selected');
    if (isDimmedNode(node.id)) classes.push('dimmed');
    return classes.join(' ');
  }

  function isDimmedNode(nodeId) {
    return focusMode && selectedId !== null && nodeId !== selectedId && !isImmediateNeighbor(nodeId);
  }

  function isDimmedEdge(edge) {
    return focusMode && selectedId !== null && edge.from !== selectedId && edge.to !== selectedId;
  }

  function isRelatedEdge(edge) {
    return selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
  }

  function isImmediateNeighbor(nodeId) {
    return edges.some(function (edge) {
      return (edge.from === selectedId && edge.to === nodeId) || (edge.to === selectedId && edge.from === nodeId);
    });
  }

  function zoomGraph(scale) {
    zoomGraphAt(scale, { x: viewBox.x + viewBox.width / 2, y: viewBox.y + viewBox.height / 2 });
  }

  function zoomGraphAt(scale, center) {
    var nextWidth = viewBox.width * scale;
    var nextHeight = viewBox.height * scale;
    var xRatio = (center.x - viewBox.x) / viewBox.width;
    var yRatio = (center.y - viewBox.y) / viewBox.height;
    viewBox.x = center.x - nextWidth * xRatio;
    viewBox.y = center.y - nextHeight * yRatio;
    viewBox.width = nextWidth;
    viewBox.height = nextHeight;
    applyViewBox();
  }

  function fitGraph() {
    var visible = nodes.filter(function (node) { return node.visible; });
    if (visible.length === 0) {
      viewBox = { x: 0, y: 0, width: 1000, height: 720 };
      fitWidth = viewBox.width;
      return;
    }
    var bounds = boundsFor(visible, layout.width, layout.height);
    viewBox = { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
    fitWidth = viewBox.width;
  }

  function applyViewBox() {
    svg.setAttribute('viewBox', [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(' '));
    var zoom = fitWidth > 0 ? Math.round(fitWidth / viewBox.width * 100) : 100;
    zoomLabel.textContent = zoom + '%';
  }

  function refitGraphSoon() {
    requestAnimationFrame(function () {
      fitGraph();
      applyViewBox();
    });
  }

  function syncSidebarToggles() {
    var left = document.getElementById('toggle-left');
    var right = document.getElementById('toggle-right');
    var leftCollapsed = app.classList.contains('left-collapsed');
    var rightCollapsed = app.classList.contains('right-collapsed');
    left.textContent = leftCollapsed ? '→' : '←';
    right.textContent = rightCollapsed ? '←' : '→';
    left.title = leftCollapsed ? 'Show left sidebar' : 'Collapse left sidebar';
    right.title = rightCollapsed ? 'Show right sidebar' : 'Collapse right sidebar';
    left.setAttribute('aria-label', left.title);
    right.setAttribute('aria-label', right.title);
    left.setAttribute('aria-pressed', String(leftCollapsed));
    right.setAttribute('aria-pressed', String(rightCollapsed));
  }

  function syncFocusButton() {
    focusToggle.classList.toggle('active', focusMode);
    focusToggle.setAttribute('aria-pressed', String(focusMode));
  }

  function revealDetailsPanel() {
    if (!app.classList.contains('right-collapsed')) return;
    app.classList.remove('right-collapsed');
    syncSidebarToggles();
    refitGraphSoon();
  }

  function syncFilterInputs() {
    Array.from(filters.querySelectorAll('[data-type-filter]')).forEach(function (button) {
      var type = button.getAttribute('data-type-filter');
      var active = visibleTypes.has(type);
      button.classList.toggle('active', active);
      button.classList.toggle('inactive', !active);
      button.setAttribute('aria-pressed', String(active));
    });
    activeTypes.textContent = visibleTypes.size + ' active';
  }

  function edgePath(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var distance = Math.sqrt(dx * dx + dy * dy) || 1;
    var offsetFrom = nodeRadius(from) + 7;
    var offsetTo = nodeRadius(to) + 11;
    var sx = from.x + dx / distance * offsetFrom;
    var sy = from.y + dy / distance * offsetFrom;
    var tx = to.x - dx / distance * offsetTo;
    var ty = to.y - dy / distance * offsetTo;
    var curve = Math.min(70, distance * 0.16);
    var cx = (sx + tx) / 2 - dy / distance * curve;
    var cy = (sy + ty) / 2 + dx / distance * curve;
    return 'M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' Q ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + tx.toFixed(1) + ' ' + ty.toFixed(1);
  }

  function edgeLength(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }

  function nodeShape(node, size) {
    if (node.type === 'flow') {
      var rect = svgEl('rect');
      rect.setAttribute('class', 'node-shape');
      rect.setAttribute('x', String(-size));
      rect.setAttribute('y', String(-size * 0.78));
      rect.setAttribute('width', String(size * 2));
      rect.setAttribute('height', String(size * 1.56));
      rect.setAttribute('rx', '6');
      rect.setAttribute('stroke-width', node.id === selectedId ? '2.8' : '2');
      return rect;
    }
    if (node.type === 'claim') {
      var diamond = svgEl('rect');
      diamond.setAttribute('class', 'node-shape');
      diamond.setAttribute('x', String(-size * 0.78));
      diamond.setAttribute('y', String(-size * 0.78));
      diamond.setAttribute('width', String(size * 1.56));
      diamond.setAttribute('height', String(size * 1.56));
      diamond.setAttribute('rx', '2.5');
      diamond.setAttribute('transform', 'rotate(45)');
      diamond.setAttribute('stroke-width', node.id === selectedId ? '2.8' : '2');
      return diamond;
    }
    if (node.type === 'source') {
      var polygon = svgEl('polygon');
      polygon.setAttribute('class', 'node-shape');
      polygon.setAttribute('points', hexPoints(size * 1.05));
      polygon.setAttribute('stroke-width', node.id === selectedId ? '2.8' : '2');
      return polygon;
    }
    var circle = svgEl('circle');
    circle.setAttribute('class', 'node-shape');
    circle.setAttribute('r', String(size));
    circle.setAttribute('stroke-width', node.id === selectedId ? '2.8' : '2');
    return circle;
  }

  function nodeRadius(node) {
    return Math.min(35, 19 + (node.degree || 0) * 2.8);
  }

  function typeGlyph(type, size) {
    var meta = typeMeta[type] || typeMeta.component;
    var icon = svgEl('svg');
    icon.setAttribute('width', String(size));
    icon.setAttribute('height', String(size));
    icon.setAttribute('viewBox', '-9 -9 18 18');
    icon.style.flex = 'none';
    var shape;
    if (type === 'flow') {
      shape = svgEl('rect');
      shape.setAttribute('x', '-6.5');
      shape.setAttribute('y', '-5');
      shape.setAttribute('width', '13');
      shape.setAttribute('height', '10');
      shape.setAttribute('rx', '2.5');
    } else if (type === 'claim') {
      shape = svgEl('rect');
      shape.setAttribute('x', '-5');
      shape.setAttribute('y', '-5');
      shape.setAttribute('width', '10');
      shape.setAttribute('height', '10');
      shape.setAttribute('rx', '1.5');
      shape.setAttribute('transform', 'rotate(45)');
    } else if (type === 'source') {
      shape = svgEl('polygon');
      shape.setAttribute('points', hexPoints(6.5));
    } else {
      shape = svgEl('circle');
      shape.setAttribute('r', '6.5');
    }
    shape.setAttribute('fill', meta.fill);
    shape.setAttribute('stroke', meta.color);
    shape.setAttribute('stroke-width', '1.6');
    icon.append(shape);
    return icon;
  }

  function eyeIcon() {
    var icon = svgEl('svg');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.style.flex = 'none';
    var eye = svgEl('path');
    eye.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z');
    eye.setAttribute('fill', 'none');
    eye.setAttribute('stroke', 'var(--faint)');
    eye.setAttribute('stroke-width', '1.8');
    var dot = svgEl('circle');
    dot.setAttribute('cx', '12');
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '2.6');
    dot.setAttribute('fill', 'var(--faint)');
    icon.append(eye, dot);
    return icon;
  }

  function svgIcon(pathData) {
    var icon = svgEl('svg');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.style.flex = 'none';
    var path = svgEl('path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.append(path);
    return icon;
  }

  function legendItem(kind, text) {
    var span = element('span', '');
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    span.style.gap = '6px';
    var marker = element('span', kind === 'line' ? 'legend-line' : 'legend-dot');
    span.append(marker, document.createTextNode(text));
    return span;
  }

  function detailDescription(node) {
    return node.detail.Text || node.detail.Name || node.detail.Title || node.detail.Ref || node.label;
  }

  function clientToGraphPoint(event) {
    var rect = svg.getBoundingClientRect();
    return {
      x: viewBox.x + (event.clientX - rect.left) / rect.width * viewBox.width,
      y: viewBox.y + (event.clientY - rect.top) / rect.height * viewBox.height
    };
  }

  function hasD3Force(d3) {
    return !!d3
      && typeof d3.forceSimulation === 'function'
      && typeof d3.forceLink === 'function'
      && typeof d3.forceManyBody === 'function'
      && typeof d3.forceCollide === 'function'
      && typeof d3.forceX === 'function'
      && typeof d3.forceY === 'function';
  }

  function closestTarget(target, selector) {
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest(selector);
  }

  function capturePointer(element, pointerId) {
    if (!element || typeof element.setPointerCapture !== 'function') return;
    try {
      element.setPointerCapture(pointerId);
    } catch {}
  }

  function releasePointer(element, pointerId) {
    if (!element || typeof element.releasePointerCapture !== 'function') return;
    try {
      if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    } catch {}
  }

  function nodeElement(nodeId) {
    return Array.from(svg.querySelectorAll('[data-node-id]')).find(function (element) {
      return element.getAttribute('data-node-id') === nodeId;
    });
  }

  function groupByType(items) {
    var grouped = new Map();
    items.forEach(function (item) {
      var group = grouped.get(item.type) || [];
      group.push(item);
      grouped.set(item.type, group);
    });
    return grouped;
  }

  function boundsFor(items, fallbackWidth, fallbackHeight) {
    if (items.length === 0) {
      return { width: fallbackWidth, height: fallbackHeight, minX: 0, minY: 0, maxX: fallbackWidth, maxY: fallbackHeight };
    }
    var minX = Math.min.apply(null, items.map(function (node) { return node.x; })) - 150;
    var minY = Math.min.apply(null, items.map(function (node) { return node.y; })) - 130;
    var maxX = Math.max.apply(null, items.map(function (node) { return node.x; })) + 150;
    var maxY = Math.max.apply(null, items.map(function (node) { return node.y; })) + 130;
    return { width: Math.max(fallbackWidth, maxX - minX), height: Math.max(fallbackHeight, maxY - minY), minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function hexPoints(radius) {
    var points = [];
    for (var index = 0; index < 6; index += 1) {
      var angle = Math.PI / 180 * (60 * index - 30);
      points.push((radius * Math.cos(angle)).toFixed(1) + ',' + (radius * Math.sin(angle)).toFixed(1));
    }
    return points.join(' ');
  }

  function shortText(value, limit) {
    if (value.length <= limit) return value;
    return value.slice(0, limit - 1) + '...';
  }

  function readTheme() {
    try {
      return window.localStorage.getItem('greplica-graph-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function setTheme(theme) {
    app.classList.toggle('theme-dark', theme !== 'light');
    app.classList.toggle('theme-light', theme === 'light');
    themeToggle.textContent = theme === 'light' ? '☀' : '☾';
    themeToggle.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    try {
      window.localStorage.setItem('greplica-graph-theme', theme);
    } catch {}
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }
}());
</script>
</body>
</html>
`;
}

function escapeJsonForHtml(data: HtmlGraphData): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
