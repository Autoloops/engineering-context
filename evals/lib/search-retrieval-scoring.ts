import { round } from "./common.js";

export type SearchResultType = "claim" | "component" | "flow";

export interface SearchRubric {
  case_id: string;
  benchmark_version: string;
  k: number;
  score: {
    pass_threshold: number;
    weights: {
      precision_at_k: number;
      recall_at_k: number;
      mrr_at_k: number;
      ndcg_at_k: number;
      grade_recall_at_k: number;
    };
    minimums: {
      precision_at_k: number;
      recall_at_k: number;
      mrr_at_k: number;
      ndcg_at_k: number;
      grade_recall_at_k: number;
    };
  };
  queries: SearchQueryCase[];
}

export interface SearchQueryCase {
  id: string;
  query: string;
  highly_relevant: string[];
  relevant: string[];
  weakly_relevant: string[];
}

export interface SearchQueryMetrics {
  precision_at_k: number;
  recall_at_k: number;
  mrr_at_k: number;
  ndcg_at_k: number;
  grade_recall_at_k: number;
}

export interface SearchQueryScore extends SearchQueryMetrics {
  id: string;
  query: string;
  returned_ids: string[];
  expected: {
    highly_relevant: string[];
    relevant: string[];
    weakly_relevant: string[];
  };
  passed: boolean;
}

export interface AggregateSearchScore extends SearchQueryMetrics {
  final_score: number;
  pass_threshold: number;
  passed: boolean;
}

export const allowedSearchResultTypes = new Set<SearchResultType>(["component", "flow", "claim"]);

export function scoreSearchQuery(
  qrels: Map<string, number>,
  returnedIds: string[],
  k: number,
): SearchQueryMetrics {
  const topK = returnedIds.slice(0, k);
  const expectedIds = [...qrels.keys()];
  const seen = new Set<string>();
  const relevantInTopK: string[] = [];
  let retrievedGradeSum = 0;

  for (const id of topK) {
    if (seen.has(id)) continue;
    seen.add(id);
    const grade = qrels.get(id) ?? 0;
    if (grade > 0) {
      relevantInTopK.push(id);
      retrievedGradeSum += grade;
    }
  }

  const firstRelevantIndex = topK.findIndex((id) => (qrels.get(id) ?? 0) > 0);
  const totalGrade = [...qrels.values()].reduce((sum, grade) => sum + grade, 0);

  return {
    precision_at_k: round(relevantInTopK.length / k),
    recall_at_k: round(expectedIds.length === 0 ? 0 : relevantInTopK.length / expectedIds.length),
    mrr_at_k: round(firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1)),
    ndcg_at_k: round(dcg(topK.map((id) => qrels.get(id) ?? 0)) / idealDcg([...qrels.values()], k)),
    grade_recall_at_k: round(totalGrade === 0 ? 0 : retrievedGradeSum / totalGrade),
  };
}

export function scoreSearchRun(
  rubric: SearchRubric,
  queryScores: SearchQueryMetrics[],
): AggregateSearchScore {
  const precision = average(queryScores.map((score) => score.precision_at_k));
  const recall = average(queryScores.map((score) => score.recall_at_k));
  const mrr = average(queryScores.map((score) => score.mrr_at_k));
  const ndcg = average(queryScores.map((score) => score.ndcg_at_k));
  const gradeRecall = average(queryScores.map((score) => score.grade_recall_at_k));
  const weights = rubric.score.weights;
  const finalScore = round(
    precision * weights.precision_at_k +
      recall * weights.recall_at_k +
      mrr * weights.mrr_at_k +
      ndcg * weights.ndcg_at_k +
      gradeRecall * weights.grade_recall_at_k,
  );
  const minimums = rubric.score.minimums;
  const enoughQueriesRan = queryScores.length === rubric.queries.length;
  const passed =
    enoughQueriesRan &&
    finalScore >= rubric.score.pass_threshold &&
    precision >= minimums.precision_at_k &&
    recall >= minimums.recall_at_k &&
    mrr >= minimums.mrr_at_k &&
    ndcg >= minimums.ndcg_at_k &&
    gradeRecall >= minimums.grade_recall_at_k;

  return {
    precision_at_k: precision,
    recall_at_k: recall,
    mrr_at_k: mrr,
    ndcg_at_k: ndcg,
    grade_recall_at_k: gradeRecall,
    final_score: finalScore,
    pass_threshold: rubric.score.pass_threshold,
    passed,
  };
}

export function qrelsFor(queryCase: SearchQueryCase): Map<string, number> {
  const qrels = new Map<string, number>();
  addQrels(qrels, queryCase.weakly_relevant, 1);
  addQrels(qrels, queryCase.relevant, 2);
  addQrels(qrels, queryCase.highly_relevant, 3);
  return qrels;
}

export function expectedFor(queryCase: SearchQueryCase): SearchQueryScore["expected"] {
  return {
    highly_relevant: queryCase.highly_relevant,
    relevant: queryCase.relevant,
    weakly_relevant: queryCase.weakly_relevant,
  };
}

export function parseReturnedIds(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Graph context JSON output must be an object.");
  }

  if (Array.isArray(parsed.ranked_results)) {
    return parseRankedResults(parsed.ranked_results);
  }

  return [
    ...parseTypedResults(parsed.claims, "claim"),
    ...parseTypedResults(parsed.components, "component"),
    ...parseTypedResults(parsed.flows, "flow"),
  ]
    .sort((a, b) => b.score - a.score || resultTypeOrder(a.type) - resultTypeOrder(b.type) || a.id.localeCompare(b.id))
    .map((result) => `${result.type}:${result.id}`);
}

export function validateSearchRubric(rubric: SearchRubric, expectedQueryCount?: number): void {
  if (expectedQueryCount !== undefined && rubric.queries.length !== expectedQueryCount) {
    throw new Error(`Expected exactly ${expectedQueryCount} search queries, found ${rubric.queries.length}.`);
  }
  for (const query of rubric.queries) {
    const ids = [...query.highly_relevant, ...query.relevant, ...query.weakly_relevant];
    if (ids.length === 0) throw new Error(`Query ${query.id} has no expected relevant IDs.`);
    for (const id of ids) {
      const [type] = id.split(":");
      if (!allowedSearchResultTypes.has(type as SearchResultType)) {
        throw new Error(`Query ${query.id} references unsupported result ID ${id}.`);
      }
    }
  }
}

function parseRankedResults(value: unknown[]): string[] {
  return value.map((result) => {
    if (!isRecord(result) || typeof result.type !== "string" || !allowedSearchResultTypes.has(result.type as SearchResultType) || !isRecord(result.object) || typeof result.object.id !== "string") {
      throw new Error("Each ranked result must include type and object.id.");
    }
    return `${result.type}:${result.object.id}`;
  });
}

function parseTypedResults(value: unknown, type: SearchResultType): Array<{ type: SearchResultType; id: string; score: number }> {
  if (!Array.isArray(value)) throw new Error(`Graph context JSON output must include a ${type}s array.`);
  return value.map((result) => {
    if (!isRecord(result) || !isRecord(result.object) || typeof result.object.id !== "string") {
      throw new Error(`Each ${type} result must include object.id.`);
    }
    return {
      type,
      id: result.object.id,
      score: typeof result.score === "number" ? result.score : 0,
    };
  });
}

function resultTypeOrder(type: SearchResultType): number {
  switch (type) {
    case "component":
      return 0;
    case "flow":
      return 1;
    case "claim":
      return 2;
  }
}

function addQrels(qrels: Map<string, number>, ids: string[], grade: number): void {
  for (const id of ids) qrels.set(id, Math.max(qrels.get(id) ?? 0, grade));
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
}

function idealDcg(grades: number[], k: number): number {
  const ideal = dcg([...grades].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 1 : ideal;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
