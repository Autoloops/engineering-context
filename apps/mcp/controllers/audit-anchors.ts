import type {
  ClaimAnchorAuditIssue,
  ClaimAnchorAuditResult,
} from "../../../libs/knowledge-graph/code-anchors/types.js";
import type { ToolHandler } from "../middleware/compose.js";
import type { AuditAnchorsOutput, RepoScopedInput } from "../schemas.js";

export const auditAnchors: ToolHandler<RepoScopedInput> = async (input, context) => {
  const installed = context.container.getInstalled(input.repo_root);
  const result = await installed.service.auditCodeAnchors(installed.repo);
  const output = toOutput(result);

  return {
    content: [{ type: "text", text: renderText(output) }],
    structuredContent: output,
  };
};

function toOutput(result: ClaimAnchorAuditResult): AuditAnchorsOutput {
  const missing_anchors = mapIssues(result.missing_anchors);
  const missing_files = mapIssues(result.missing_files);
  const missing_symbols = mapIssues(result.missing_symbols);
  const ambiguous_symbols = mapIssues(result.ambiguous_symbols);
  const unsupported_languages = mapIssues(result.unsupported_languages);

  const issue_count =
    missing_anchors.length +
    missing_files.length +
    missing_symbols.length +
    ambiguous_symbols.length +
    unsupported_languages.length;

  return {
    issue_count,
    missing_anchors,
    missing_files,
    missing_symbols,
    ambiguous_symbols,
    unsupported_languages,
  };
}

function mapIssues(issues: readonly ClaimAnchorAuditIssue[]): AuditAnchorsOutput["missing_files"] {
  return issues.map((issue) => ({
    claim_id: issue.claim_id,
    file: issue.anchor?.file,
    symbol: issue.anchor?.symbol,
  }));
}

function renderText(output: AuditAnchorsOutput): string {
  if (output.issue_count === 0) return "Code anchor audit: no issues.";
  return `Code anchor audit: ${output.issue_count} issue(s) found. See structured output for details.`;
}
