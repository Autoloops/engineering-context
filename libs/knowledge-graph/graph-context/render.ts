import type {
  GraphContextResult,
  RankedGraphContextResult,
} from "./types.js";
import type { ManagedObjectProvenance } from "../../managed/protocol.js";

export function renderGraphContextMarkdown(result: GraphContextResult): string {
  const rankedComponents = result.ranked_results.filter((item) => item.type === "component");
  const rankedFlows = result.ranked_results.filter((item) => item.type === "flow");
  const rankedClaims = result.ranked_results.filter((item) => item.type === "claim");
  const componentsById = new Map(result.components.map((component) => [component.object.id, component.object.name]));
  const flowsById = new Map(result.flows.map((flow) => [flow.object.id, flow.object.name]));
  const content = [
    "# Graph Context",
    "",
    "## Best Claims",
    "",
    ...renderRankedClaims(rankedClaims, componentsById, flowsById),
    "",
    "## Related Components",
    "",
    ...renderRankedComponents(rankedComponents),
    "",
    "## Related Flows",
    "",
    ...renderRankedFlows(rankedFlows),
  ];

  return lines(...content);
}

function renderRankedComponents(
  components: Array<Extract<RankedGraphContextResult, { type: "component" }>>,
): string[] {
  if (components.length === 0) return ["- None."];
  return components.map((component, index) => {
    const relation = component.context_relation === "additional" ? " additional" : "";
    const anchor = component.object.code_anchor === undefined ? "" : ` Anchor: \`${component.object.code_anchor}\`.`;
    const claims = component.matched_claim_ids.length === 0 ? "" : ` Supporting claims: ${component.matched_claim_ids.map((id) => `\`${id}\``).join(", ")}.`;
    return `- ${index + 1}. ${component.object.name}${relation}. ID: \`${component.object.id}\`.${anchor}${claims}${provenanceLabel(component.object)}`;
  });
}

function renderRankedFlows(
  flows: Array<Extract<RankedGraphContextResult, { type: "flow" }>>,
): string[] {
  if (flows.length === 0) return ["- None."];
  return flows.map((flow, index) => {
    const relation = flow.context_relation === "additional" ? " additional" : "";
    const claims = flow.matched_claim_ids.length === 0 ? "" : ` Supporting claims: ${flow.matched_claim_ids.map((id) => `\`${id}\``).join(", ")}.`;
    return `- ${index + 1}. ${flow.object.name}${relation}. ID: \`${flow.object.id}\`.${claims}${provenanceLabel(flow.object)}`;
  });
}

function renderRankedClaims(
  claims: Array<Extract<RankedGraphContextResult, { type: "claim" }>>,
  componentsById: Map<string, string>,
  flowsById: Map<string, string>,
): string[] {
  if (claims.length === 0) return ["- None."];
  return claims.flatMap((claim, index) => {
    const anchors = claim.code_anchors.length === 0 ? "" : ` Anchor: ${claim.code_anchors.map(anchorLabel).join("; ")}.`;
    const about = aboutLabel(claim.about, componentsById, flowsById);
    return [
      `### ${index + 1}. ${claim.object.id}`,
      "",
      claim.object.text,
      "",
      `${anchors}${about}${provenanceLabel(claim.object)}`.trim(),
      "",
    ];
  });
}

function provenanceLabel(object: object): string {
  const provenance = (object as { provenance?: ManagedObjectProvenance }).provenance;
  if (provenance === undefined) return "";
  const currentLogin = provenance.author_github_login;
  const historicalLogin = provenance.author_github_login_snapshot;
  const values = [
    provenance.scope_kind,
    `version ${provenance.version_id}`,
    currentLogin === undefined ? undefined : `@${currentLogin}`,
    historicalLogin === undefined || historicalLogin === currentLogin ? undefined : `formerly @${historicalLogin}`,
    provenance.proposal_id === undefined ? undefined : `proposal ${provenance.proposal_id}`,
    provenance.memory_commit_id === undefined ? undefined : `commit ${provenance.memory_commit_id}`,
    ...(provenance.session_refs ?? []).map((session) => `session ${session.id}`),
    provenance.agent_platform === undefined ? undefined : `agent ${provenance.agent_platform}`,
    provenance.branch === undefined ? undefined : `branch ${provenance.branch}`,
    provenance.git_head === undefined ? undefined : `git ${provenance.git_head}`,
    provenance.code_pr_number === undefined ? undefined : `code PR #${provenance.code_pr_number}`,
    provenance.memory_pr_id === undefined ? undefined : `Memory PR ${provenance.memory_pr_id}`,
    provenance.commit_role,
    provenance.memory_commit_state,
    provenance.promotion_id === undefined ? undefined : `promotion ${provenance.promotion_id}`,
    provenance.quarantine_reason === undefined ? undefined : `quarantine ${provenance.quarantine_reason}`,
  ].filter((value): value is string => value !== undefined);
  return ` Provenance: ${values.join("; ")}.`;
}

function anchorLabel(anchor: Extract<RankedGraphContextResult, { type: "claim" }>["code_anchors"][number]): string {
  const base = anchor.symbol === undefined ? anchor.file : `${anchor.file}#${anchor.symbol}`;
  if (anchor.status === "resolved" && anchor.start_line !== undefined) {
    const suffix = anchor.end_line !== undefined && anchor.end_line !== anchor.start_line
      ? `${anchor.start_line}-${anchor.end_line}`
      : `${anchor.start_line}`;
    return `\`${anchor.file}:${suffix}${anchor.symbol === undefined ? "" : `#${anchor.symbol}`}\``;
  }
  if (anchor.status === "file_only") return `\`${anchor.file}\``;
  return `\`${base}\` (${anchor.status.replace(/_/g, " ")})`;
}

function aboutLabel(
  about: Extract<RankedGraphContextResult, { type: "claim" }>["about"],
  componentsById: Map<string, string>,
  flowsById: Map<string, string>,
): string {
  if (about.length === 0) return "";
  const labels = about.map((target) => {
    if (target.type === "component") return `component ${componentsById.get(target.id) ?? target.id}`;
    return `flow ${flowsById.get(target.id) ?? target.id}`;
  });
  return ` About: ${labels.join("; ")}.`;
}

function lines(...values: string[]): string {
  return `${values.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
