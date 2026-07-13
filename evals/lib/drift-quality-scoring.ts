import { round } from "./common.js";

// Analytic scoring for the anchor-drift-quality eval. Each seeded claim is a
// "case" graded on several 0-1 dimensions with partial credit, then combined
// with a difficulty weight so the final score spreads instead of being pass/fail.
// Structural dimensions (detection, restraint, anchor_accuracy) are computed
// deterministically from the agent's proposal; the semantic dimensions
// (correctness, completeness, preservation) come from the LLM judge.

export type DriftDimension =
  | "detection"
  | "correctness"
  | "completeness"
  | "preservation"
  | "anchor_accuracy"
  | "restraint";

export type CaseAction = "supersede" | "retire" | "leave";
export type CaseDifficulty = "easy" | "medium" | "hard" | "trap";

export interface QualityCase {
  id: string;
  category: string;
  difficulty: CaseDifficulty;
  action: CaseAction;
  expected?: string;
  expected_anchor_symbol?: string;
  dimensions: DriftDimension[];
}

export interface QualityRubric {
  case_id: string;
  base_commit: string;
  score: {
    pass_threshold: number;
    dimension_weights: Record<DriftDimension, number>;
    difficulty_weights: Record<CaseDifficulty, number>;
  };
  patch_summary: string;
  cases: QualityCase[];
}

// Per drift case the judge scores the three semantic dimensions in [0, 1].
export interface JudgeCaseScore {
  case_id: string;
  correctness: number;
  completeness: number;
  preservation: number;
  reason: string;
}

export interface QualityJudgeOutput {
  cases: JudgeCaseScore[];
}

export interface CaseScore {
  id: string;
  category: string;
  difficulty: CaseDifficulty;
  weight: number;
  superseded: boolean;
  dimensions: Partial<Record<DriftDimension, number>>;
  score: number;
}

export interface QualityScore {
  final_score: number;
  pass_threshold: number;
  passed: boolean;
  cases: CaseScore[];
  by_category: Record<string, number>;
  by_difficulty: Record<string, number>;
}

export interface ReplacementClaim {
  id: string;
  text: string;
  code_anchors: Array<{ file: string; symbol?: string }>;
}

/** Claims in the proposal that supersede `oldClaimId`, via compact field or edge. */
export function replacementClaimsFor(proposal: unknown, oldClaimId: string): ReplacementClaim[] {
  const creates = proposalCreates(proposal);
  if (creates === undefined) return [];

  const supersededByEdge = new Set(
    proposalEdges(creates)
      .filter((edge) => edge.kind === "supersedes" && edgeTo(edge) === oldClaimId)
      .map((edge) => edgeFrom(edge)),
  );

  return proposalClaimObjects(creates).filter(
    (claim) => stringArray(claim.supersedes).includes(oldClaimId) || supersededByEdge.has(claim.id),
  );
}

export function isSuperseded(proposal: unknown, oldClaimId: string): boolean {
  return replacementClaimsFor(proposal, oldClaimId).length > 0;
}

function anchorAccuracy(replacements: ReplacementClaim[], expectedSymbol: string): number {
  const matched = replacements.some((claim) => claim.code_anchors.some((anchor) => anchor.symbol === expectedSymbol));
  return matched ? 1 : 0;
}

export function scoreQuality(rubric: QualityRubric, proposal: unknown, judge: QualityJudgeOutput): QualityScore {
  const judgeById = new Map(judge.cases.map((entry) => [entry.case_id, entry]));
  const dimensionWeights = rubric.score.dimension_weights;

  const cases: CaseScore[] = rubric.cases.map((rubricCase) => {
    const superseded = isSuperseded(proposal, rubricCase.id);
    const replacements = replacementClaimsFor(proposal, rubricCase.id);
    const judged = judgeById.get(rubricCase.id);
    const dimensions: Partial<Record<DriftDimension, number>> = {};

    for (const dimension of rubricCase.dimensions) {
      dimensions[dimension] = scoreDimension(dimension, rubricCase, superseded, replacements, judged);
    }

    return {
      id: rubricCase.id,
      category: rubricCase.category,
      difficulty: rubricCase.difficulty,
      weight: rubric.score.difficulty_weights[rubricCase.difficulty],
      superseded,
      dimensions,
      score: weightedAverage(dimensions, dimensionWeights),
    };
  });

  const totalWeight = cases.reduce((sum, entry) => sum + entry.weight, 0);
  const finalScore = totalWeight === 0 ? 0 : (cases.reduce((sum, entry) => sum + entry.weight * entry.score, 0) / totalWeight) * 100;

  return {
    final_score: round(finalScore, 2),
    pass_threshold: rubric.score.pass_threshold,
    passed: finalScore >= rubric.score.pass_threshold,
    cases,
    by_category: groupedAverage(cases, (entry) => entry.category),
    by_difficulty: groupedAverage(cases, (entry) => entry.difficulty),
  };
}

// A semantic dimension only earns credit when the claim was actually superseded:
// a correct replacement cannot exist for a claim the agent never touched.
function scoreDimension(
  dimension: DriftDimension,
  rubricCase: QualityCase,
  superseded: boolean,
  replacements: ReplacementClaim[],
  judged: JudgeCaseScore | undefined,
): number {
  switch (dimension) {
    case "detection":
      return superseded ? 1 : 0;
    case "restraint":
      return superseded ? 0 : 1;
    case "anchor_accuracy":
      return superseded && rubricCase.expected_anchor_symbol !== undefined
        ? anchorAccuracy(replacements, rubricCase.expected_anchor_symbol)
        : 0;
    case "correctness":
      return superseded ? clamp01(judged?.correctness) : 0;
    case "completeness":
      return superseded ? clamp01(judged?.completeness) : 0;
    case "preservation":
      return superseded ? clamp01(judged?.preservation) : 0;
  }
}

function weightedAverage(
  dimensions: Partial<Record<DriftDimension, number>>,
  weights: Record<DriftDimension, number>,
): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [dimension, value] of Object.entries(dimensions) as Array<[DriftDimension, number]>) {
    const weight = weights[dimension];
    weightedSum += weight * value;
    weightTotal += weight;
  }
  return weightTotal === 0 ? 0 : round(weightedSum / weightTotal, 4);
}

function groupedAverage(cases: CaseScore[], key: (entry: CaseScore) => string): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const entry of cases) {
    const bucket = buckets.get(key(entry)) ?? [];
    bucket.push(entry.score);
    buckets.set(key(entry), bucket);
  }
  const result: Record<string, number> = {};
  for (const [name, scores] of buckets) {
    result[name] = round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 3);
  }
  return result;
}

// Judge input: only the drift cases (supersede/retire) need semantic grading;
// each carries the original claim, the expected repair, and the agent's actual
// replacement claims so the judge can compare against ground truth.
export interface JudgeCaseInput {
  case_id: string;
  category: string;
  original_claim: string;
  expected_repair: string;
  agent_replacements: ReplacementClaim[];
}

export function buildJudgeCases(rubric: QualityRubric, seedClaims: Map<string, string>, proposal: unknown): JudgeCaseInput[] {
  return rubric.cases
    .filter((rubricCase) => rubricCase.action !== "leave")
    .map((rubricCase) => ({
      case_id: rubricCase.id,
      category: rubricCase.category,
      original_claim: seedClaims.get(rubricCase.id) ?? "",
      expected_repair: rubricCase.expected ?? "",
      agent_replacements: replacementClaimsFor(proposal, rubricCase.id),
    }));
}

export function judgeOutputSchema(): Record<string, unknown> {
  const caseItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      case_id: { type: "string" },
      correctness: { type: "number" },
      completeness: { type: "number" },
      preservation: { type: "number" },
      reason: { type: "string" },
    },
    required: ["case_id", "correctness", "completeness", "preservation", "reason"],
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: { cases: { type: "array", items: caseItem } },
    required: ["cases"],
  };
}

interface ProposalClaimObject {
  id: string;
  text: string;
  supersedes?: unknown;
  code_anchors: Array<{ file: string; symbol?: string }>;
}

interface ProposalEdge {
  kind?: unknown;
  from?: unknown;
  from_id?: unknown;
  to?: unknown;
  to_id?: unknown;
}

function proposalCreates(proposal: unknown): Record<string, unknown> | undefined {
  if (!isRecord(proposal) || !isRecord(proposal.creates)) return undefined;
  return proposal.creates;
}

function proposalClaimObjects(creates: Record<string, unknown>): ProposalClaimObject[] {
  if (!Array.isArray(creates.claims)) return [];
  return creates.claims.flatMap((claim) => {
    if (!isRecord(claim) || typeof claim.id !== "string") return [];
    return [{
      id: claim.id,
      text: typeof claim.text === "string" ? claim.text : "",
      supersedes: claim.supersedes,
      code_anchors: parseAnchors(claim.code_anchors),
    }];
  });
}

function parseAnchors(value: unknown): Array<{ file: string; symbol?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((anchor) => {
    if (!isRecord(anchor) || typeof anchor.file !== "string") return [];
    return [{ file: anchor.file, symbol: typeof anchor.symbol === "string" ? anchor.symbol : undefined }];
  });
}

function proposalEdges(creates: Record<string, unknown>): ProposalEdge[] {
  if (!Array.isArray(creates.edges)) return [];
  return creates.edges.flatMap((edge) => (isRecord(edge) ? [{ kind: edge.kind, from: edge.from, from_id: edge.from_id, to: edge.to, to_id: edge.to_id }] : []));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function edgeFrom(edge: ProposalEdge): string {
  return typeof edge.from === "string" ? edge.from : typeof edge.from_id === "string" ? edge.from_id : "";
}

function edgeTo(edge: ProposalEdge): string {
  return typeof edge.to === "string" ? edge.to : typeof edge.to_id === "string" ? edge.to_id : "";
}

function clamp01(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
