import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, relative, resolve } from "node:path";
import { CodeAnchorResolver } from "../../libs/knowledge-graph/code-anchors/resolver.js";
import type { ClaimCodeAnchor } from "../../libs/knowledge-graph/claim.js";
import type { ResolvedCodeAnchor } from "../../libs/knowledge-graph/code-anchors/types.js";

export type AnchorQualitySeverity = "error" | "warning";

export interface AnchorQualityIssue {
  claim_id: string;
  code?: string;
  severity: AnchorQualitySeverity;
  anchor?: ClaimCodeAnchor;
  message: string;
}

export interface ProposalAnchorQualityResult {
  checked_claim_count: number;
  anchor_count: number;
  issue_count: number;
  error_count: number;
  warning_count: number;
  passed: boolean;
  issues: AnchorQualityIssue[];
}

interface ProposalClaim {
  id: string;
  truth?: unknown;
  code_anchors?: unknown;
}

const maxUsefulAnchorsPerClaim = 2;
const maxUsefulSymbolLines = 150;
const maxUsefulFileOnlyLines = 80;
const maxUsefulNonCodeFileOnlyLines = 250;

const codeExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".kt",
  ".kts",
  ".dart",
  ".scala",
  ".lua",
  ".m",
  ".mm",
  ".sh",
  ".bash",
]);

export async function evaluateProposalAnchorQuality(
  proposal: unknown,
  repoRoot: string,
): Promise<ProposalAnchorQualityResult> {
  const resolver = new CodeAnchorResolver();
  const issues: AnchorQualityIssue[] = [];
  let checkedClaimCount = 0;
  let anchorCount = 0;

  for (const claim of proposalClaims(proposal)) {
    if (claim.truth !== "code_verified") continue;
    checkedClaimCount += 1;

    const anchors = claimAnchors(claim);
    anchorCount += anchors.length;

    if (anchors.length === 0) {
      issues.push({
        claim_id: claim.id,
        code: "missing_code_anchors",
        severity: "error",
        message: "Code-verified claims need at least one code anchor.",
      });
      continue;
    }

    if (anchors.length > maxUsefulAnchorsPerClaim) {
      issues.push({
        claim_id: claim.id,
        code: "too_many_code_anchors",
        severity: "error",
        message: `Claim has ${anchors.length} code anchors; prefer one representative symbol, or two only for an explicit cross-boundary claim.`,
      });
    }

    for (const anchor of anchors) {
      await evaluateAnchor(repoRoot, resolver, claim.id, anchor, issues);
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;

  return {
    checked_claim_count: checkedClaimCount,
    anchor_count: anchorCount,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    passed: errorCount === 0,
    issues,
  };
}

async function evaluateAnchor(
  repoRoot: string,
  resolver: CodeAnchorResolver,
  claimId: string,
  anchor: ClaimCodeAnchor,
  issues: AnchorQualityIssue[],
): Promise<void> {
  const filePath = resolve(repoRoot, anchor.file);
  if (!isRepoRelative(repoRoot, filePath) || !existsSync(filePath)) {
    issues.push({
      claim_id: claimId,
      code: "missing_anchor_file",
      severity: "error",
      anchor,
      message: "Anchor file does not exist inside the target repo.",
    });
    return;
  }

  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    issues.push({
      claim_id: claimId,
      code: "directory_anchor",
      severity: "error",
      anchor,
      message: "Anchor points at a directory; use a file, and a symbol when the file is code.",
    });
    return;
  }

  const resolved = await resolver.resolve(repoRoot, anchor);
  if (resolved.status !== "resolved" && resolved.status !== "file_only") {
    issues.push({
      claim_id: claimId,
      code: `unresolved_${resolved.status}`,
      severity: "error",
      anchor,
      message: anchorStatusMessage(resolved),
    });
    return;
  }

  const extension = extname(anchor.file).toLowerCase();
  const lineCount = countLines(filePath);
  if (resolved.status === "file_only") {
    if (codeExtensions.has(extension) && lineCount > maxUsefulFileOnlyLines) {
      issues.push({
        claim_id: claimId,
        code: "file_only_code_anchor",
        severity: "error",
        anchor,
        message: `File-only code anchor spans ${lineCount} lines; choose a stable function, class, type, or method symbol.`,
      });
      return;
    }

    if (!codeExtensions.has(extension) && lineCount > maxUsefulNonCodeFileOnlyLines) {
      issues.push({
        claim_id: claimId,
        code: "large_file_only_anchor",
        severity: "warning",
        anchor,
        message: `File-only non-code anchor spans ${lineCount} lines; use a narrower artifact if one exists.`,
      });
    }

    return;
  }

  const symbolLines = (resolved.end_line ?? resolved.start_line ?? 0) - (resolved.start_line ?? 0) + 1;
  if (symbolLines > maxUsefulSymbolLines) {
    issues.push({
      claim_id: claimId,
      code: "broad_symbol_anchor",
      severity: "warning",
      anchor,
      message: `Symbol anchor spans ${symbolLines} lines; prefer a smaller stable symbol when one captures the claim.`,
    });
  }
}

function anchorStatusMessage(anchor: ResolvedCodeAnchor): string {
  switch (anchor.status) {
    case "missing_file":
      return "Anchor file does not exist inside the target repo.";
    case "missing_symbol":
      return "Anchor symbol was not found in the target file.";
    case "ambiguous_symbol":
      return "Anchor symbol matches multiple declarations; use the fully qualified symbol path.";
    case "unsupported_language":
      return "Anchor language cannot currently be parsed; use a file-only anchor only for non-code artifacts.";
    case "resolved":
    case "file_only":
      return "Anchor resolved.";
  }
}

function proposalClaims(proposal: unknown): ProposalClaim[] {
  if (!isRecord(proposal) || !isRecord(proposal.creates) || !Array.isArray(proposal.creates.claims)) {
    return [];
  }

  return proposal.creates.claims.flatMap((claim) => {
    if (!isRecord(claim) || typeof claim.id !== "string") return [];
    return [{
      id: claim.id,
      truth: claim.truth,
      code_anchors: claim.code_anchors,
    }];
  });
}

function claimAnchors(claim: ProposalClaim): ClaimCodeAnchor[] {
  if (!Array.isArray(claim.code_anchors)) return [];
  return claim.code_anchors.flatMap((anchor) => {
    if (!isRecord(anchor) || typeof anchor.file !== "string") return [];
    return [{
      file: anchor.file,
      symbol: typeof anchor.symbol === "string" ? anchor.symbol : undefined,
    }];
  });
}

function countLines(filePath: string): number {
  const text = readFileSync(filePath, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function isRepoRelative(repoRoot: string, filePath: string): boolean {
  const relativePath = normalize(relative(repoRoot, filePath));
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
