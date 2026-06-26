import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { graphContextConfig, type GraphContextConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { applyGraphRanking } from "../../libs/knowledge-graph/graph-context/graph-rank.js";
import {
  rankPacketResults,
  roundRankedSignals,
  selectGraphObjects,
} from "../../libs/knowledge-graph/graph-context/packet-rank.js";
import { rankContextDocuments, roundScore, selectRankedDocuments, type RankedContextDocument, type SemanticScoreEntry } from "../../libs/knowledge-graph/graph-context/rank.js";
import { buildClaimDocuments, buildComponentDocuments, buildFlowDocuments, type ContextDocument } from "../../libs/knowledge-graph/graph-context/documents.js";
import type { ScoreEntry } from "../../libs/knowledge-graph/graph-context/bm25.js";
import type { GraphReadResult } from "../../libs/knowledge-graph/service.js";
import type { Claim } from "../../libs/knowledge-graph/claim.js";
import type { Component, Flow } from "../../libs/knowledge-graph/schema.js";
import type { ClaimContextResult, ComponentContextResult, FlowContextResult, RankedContextDebugResult } from "../../libs/knowledge-graph/graph-context/types.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { SqliteRepository } from "../../libs/storage/sqlite/repository.js";
import {
  qrelsFor,
  scoreSearchQuery,
  scoreSearchRun,
  type AggregateSearchScore,
  type SearchQueryCase,
  type SearchQueryMetrics,
  type SearchRubric,
  validateSearchRubric,
} from "../lib/search-retrieval-scoring.js";
import { findRepoRoot, readJson, round, timestamp, valueAfter, writeJson } from "../lib/common.js";

interface EvalResultFile {
  greplica_home_dir: string;
  rubric_path: string;
  query_scores: Array<{
    id: string;
    command: {
      stdout?: string;
    };
  }>;
}

interface GraphContextDebugOutput {
  debug?: {
    base_ranked_claims?: Array<RankedContextDebugResult<Claim>>;
    base_ranked_components?: Array<RankedContextDebugResult<Component>>;
    base_ranked_flows?: Array<RankedContextDebugResult<Flow>>;
    ranked_claims?: Array<RankedContextDebugResult<Claim>>;
    ranked_components?: Array<RankedContextDebugResult<Component>>;
    ranked_flows?: Array<RankedContextDebugResult<Flow>>;
  };
}

interface TrainingCase {
  query: SearchQueryCase;
  rankedClaims: Array<RankedContextDebugResult<Claim>>;
  rankedComponents: Array<RankedContextDebugResult<Component>>;
  rankedFlows: Array<RankedContextDebugResult<Flow>>;
}

interface TrainingDataset {
  rubric: SearchRubric;
  graph: GraphReadResult;
  cases: TrainingCase[];
}

interface TrainingRunScore extends AggregateSearchScore {
  query_scores: SearchQueryMetrics[];
}

interface CandidateResult {
  id: number;
  config: GraphContextConfig;
  train: TrainingRunScore;
  validation: TrainingRunScore;
  all: TrainingRunScore;
}

interface ParamSpec {
  path: string;
  min: number;
  max: number;
  decimals: number;
}

interface CliOptions {
  fromRun: string;
  generations: number;
  population: number;
  elite: number;
  seed: number;
  outputDir: string;
  objective: "validation" | "all";
}

const searchSpace: ParamSpec[] = [
  { path: "ranking.selectionThreshold", min: 0.55, max: 0.9, decimals: 3 },
  { path: "ranking.packetMinimumScore", min: 0.45, max: 0.75, decimals: 3 },
  { path: "ranking.packetAdditionalDirectScoreFloor", min: 0.2, max: 0.75, decimals: 3 },
  { path: "ranking.weights.semantic", min: 0.6, max: 1.4, decimals: 3 },
  { path: "ranking.weights.bm25", min: 0, max: 0.9, decimals: 3 },
  { path: "ranking.claimSupport.weight", min: 0.5, max: 1.5, decimals: 3 },
  { path: "ranking.claimSupport.countBoost", min: 0, max: 0.08, decimals: 4 },
  { path: "ranking.directObject.weight", min: 0.45, max: 1.15, decimals: 3 },
  { path: "ranking.graphBoost.claimAboutTarget", min: 0, max: 1, decimals: 3 },
  { path: "ranking.graphBoost.containsParentToChild", min: 0, max: 1, decimals: 3 },
  { path: "ranking.graphBoost.containsChildToParent", min: 0, max: 1, decimals: 3 },
  { path: "ranking.graphBoost.touchesComponentToFlow", min: 0, max: 1, decimals: 3 },
  { path: "ranking.coherence.weight", min: 0, max: 0.4, decimals: 3 },
  { path: "ranking.coherence.neighborThreshold", min: 0.45, max: 0.95, decimals: 3 },
  { path: "ranking.coherence.degreePenalty", min: 0, max: 1.5, decimals: 3 },
  { path: "ranking.packetHubPenalty.weight", min: 0, max: 0.4, decimals: 3 },
  { path: "ranking.packetHubPenalty.graphScoreThreshold", min: 0.4, max: 0.95, decimals: 3 },
  { path: "ranking.packetHubPenalty.claimSupportThreshold", min: 0, max: 0.8, decimals: 3 },
  { path: "ranking.packetHubPenalty.bm25Threshold", min: 0, max: 0.6, decimals: 3 },
  { path: "ranking.packetHubPenalty.semanticThreshold", min: 0, max: 0.8, decimals: 3 },
  { path: "ranking.packetHubPenalty.coherenceThreshold", min: 0, max: 0.3, decimals: 3 },
];

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const options = parseOptions();
  const dataset = loadDataset(options.fromRun);
  validateSearchRubric(dataset.rubric);
  mkdirSync(options.outputDir, { recursive: true });

  const rng = mulberry32(options.seed);
  const split = splitCases(dataset.cases);
  const logPath = resolve(options.outputDir, "training-log.jsonl");
  const bestPath = resolve(options.outputDir, "best-config.json");
  const bestAllPath = resolve(options.outputDir, "best-all-config.json");
  const topPath = resolve(options.outputDir, "top-configs.json");

  let nextId = 1;
  let population = initialPopulation(options.population, rng).map((config) => ({ id: nextId++, config }));
  let bestByObjective: CandidateResult | undefined;
  const seen = new Map<string, CandidateResult>();

  console.log(`Training ranking config on ${dataset.cases.length} queries from ${options.fromRun}`);
  console.log(`Algorithm: evolutionary random search; objective=${options.objective}, generations=${options.generations}, population=${options.population}, elite=${options.elite}, seed=${options.seed}`);

  for (let generation = 0; generation < options.generations; generation += 1) {
    const scored = population.map((candidate) => {
      const key = stableConfigKey(candidate.config);
      const existing = seen.get(key);
      if (existing !== undefined) return existing;
      const result = scoreCandidate(candidate.id, candidate.config, dataset, split);
      seen.set(key, result);
      return result;
    }).sort((left, right) => compareCandidateResults(left, right, options.objective));

    const generationBest = scored[0];
    if (generationBest === undefined) throw new Error("Optimizer population is empty.");
    if (bestByObjective === undefined || compareCandidateResults(generationBest, bestByObjective, options.objective) < 0) {
      bestByObjective = generationBest;
    }

    appendJsonLine(logPath, {
      generation,
      objective: options.objective,
      best_candidate_id: generationBest.id,
      best_train_score: generationBest.train.final_score,
      best_validation_score: generationBest.validation.final_score,
      best_all_score: generationBest.all.final_score,
      best_all_precision_at_k: generationBest.all.precision_at_k,
      best_all_recall_at_k: generationBest.all.recall_at_k,
      best_objective_candidate_id: bestByObjective.id,
      best_objective_all_score: bestByObjective.all.final_score,
    });

    console.log(
      `gen ${generation.toString().padStart(2, "0")} train=${generationBest.train.final_score.toFixed(3)} val=${generationBest.validation.final_score.toFixed(3)} all=${generationBest.all.final_score.toFixed(3)} bestObjAll=${bestByObjective.all.final_score.toFixed(3)}`,
    );

    const elites = scored.slice(0, Math.max(1, Math.min(options.elite, scored.length)));
    population = nextGeneration(elites, options.population, rng, nextId);
    nextId += population.length;
  }

  const topByValidation = [...seen.values()].sort(compareValidation).slice(0, 25);
  const topByAll = [...seen.values()].sort(compareAll).slice(0, 25);
  const best = bestByObjective ?? (options.objective === "all" ? topByAll[0] : topByValidation[0]);
  const bestAll = topByAll[0];
  if (best === undefined) throw new Error("Optimizer did not score any configs.");
  if (bestAll === undefined) throw new Error("Optimizer did not score any configs.");

  writeJson(bestPath, {
    selected_by: `${options.objective}_score`,
    candidate_id: best.id,
    train: best.train,
    validation: best.validation,
    all: best.all,
    ranking: best.config.ranking,
  });
  writeJson(bestAllPath, {
    selected_by: "all_query_replay_score",
    candidate_id: bestAll.id,
    train: bestAll.train,
    validation: bestAll.validation,
    all: bestAll.all,
    ranking: bestAll.config.ranking,
  });
  writeJson(topPath, {
    by_validation: topByValidation.map(candidateSummary),
    by_all: topByAll.map(candidateSummary),
  });

  console.log(`Best ${options.objective} candidate: ${best.id}`);
  console.log(`Train: ${best.train.final_score.toFixed(3)}  Validation: ${best.validation.final_score.toFixed(3)}  All: ${best.all.final_score.toFixed(3)}`);
  console.log(`Best all-query candidate: ${bestAll.id}`);
  console.log(`Train: ${bestAll.train.final_score.toFixed(3)}  Validation: ${bestAll.validation.final_score.toFixed(3)}  All: ${bestAll.all.final_score.toFixed(3)}`);
  console.log(`Wrote ${bestPath}`);
  console.log(`Wrote ${bestAllPath}`);
  console.log(`Wrote ${topPath}`);
}

function loadDataset(fromRun: string): TrainingDataset {
  const resultPath = fromRun.endsWith(".json") ? fromRun : resolve(fromRun, "result.json");
  const result = readJson<EvalResultFile>(resultPath);
  const rubric = readJson<SearchRubric>(result.rubric_path);
  const db = openDatabase(resolve(result.greplica_home_dir, "graph.db"));
  const repo = db.prepare("SELECT id FROM repos LIMIT 1").get() as { id: string } | undefined;
  if (repo === undefined) throw new Error(`No repo found in ${result.greplica_home_dir}/graph.db`);
  const graph = new SqliteRepository(db).readGraphView(repo.id);
  const queryById = new Map(rubric.queries.map((query) => [query.id, query]));
  const cases = result.query_scores.map((queryScore) => {
    const query = queryById.get(queryScore.id);
    if (query === undefined) throw new Error(`Rubric is missing query ${queryScore.id}`);
    if (queryScore.command.stdout === undefined) throw new Error(`Query ${queryScore.id} has no debug stdout.`);
    const parsed = JSON.parse(queryScore.command.stdout) as GraphContextDebugOutput;
    return {
      query,
      rankedClaims: parsed.debug?.base_ranked_claims ?? parsed.debug?.ranked_claims ?? [],
      rankedComponents: parsed.debug?.base_ranked_components ?? parsed.debug?.ranked_components ?? [],
      rankedFlows: parsed.debug?.base_ranked_flows ?? parsed.debug?.ranked_flows ?? [],
    };
  });
  return { rubric, graph, cases };
}

function scoreCandidate(
  id: number,
  config: GraphContextConfig,
  dataset: TrainingDataset,
  split: { train: Set<string>; validation: Set<string> },
): CandidateResult {
  return {
    id,
    config,
    train: replayDataset(dataset, config, split.train),
    validation: replayDataset(dataset, config, split.validation),
    all: replayDataset(dataset, config),
  };
}

function replayDataset(
  dataset: TrainingDataset,
  config: GraphContextConfig,
  queryIds?: Set<string>,
): TrainingRunScore {
  const queryScores = dataset.cases
    .filter((trainingCase) => queryIds === undefined || queryIds.has(trainingCase.query.id))
    .map((trainingCase) => {
      const returnedIds = replayQuery(dataset.graph, trainingCase, config);
      return scoreSearchQuery(qrelsFor(trainingCase.query), returnedIds, dataset.rubric.k);
    });
  return {
    ...scoreSearchRun(
      { ...dataset.rubric, queries: dataset.rubric.queries.filter((query) => queryIds === undefined || queryIds.has(query.id)) },
      queryScores,
    ),
    query_scores: queryScores,
  };
}

function replayQuery(graph: GraphReadResult, trainingCase: TrainingCase, config: GraphContextConfig): string[] {
  const claimDocuments = filterDocuments(buildClaimDocuments(graph), trainingCase.rankedClaims, "claim");
  const componentDocuments = filterDocuments(buildComponentDocuments(graph), trainingCase.rankedComponents, "component");
  const flowDocuments = filterDocuments(buildFlowDocuments(graph), trainingCase.rankedFlows, "flow");

  const ranked = applyGraphRanking(
    {
      claims: rankContextDocuments(
        claimDocuments,
        semanticScores(trainingCase.rankedClaims, "claim"),
        bm25Scores(trainingCase.rankedClaims, "claim"),
        config,
      ),
      components: rankContextDocuments(
        componentDocuments,
        semanticScores(trainingCase.rankedComponents, "component"),
        bm25Scores(trainingCase.rankedComponents, "component"),
        config,
      ),
      flows: rankContextDocuments(
        flowDocuments,
        semanticScores(trainingCase.rankedFlows, "flow"),
        bm25Scores(trainingCase.rankedFlows, "flow"),
        config,
      ),
    },
    graph,
    config,
  );

  const selectedClaims = toClaimResults(ranked.claims, config);
  const selectedComponents = selectGraphObjects(ranked.components, selectedClaims, "component", config) as ComponentContextResult[];
  const selectedFlows = selectGraphObjects(ranked.flows, selectedClaims, "flow", config) as FlowContextResult[];
  return rankPacketResults(selectedClaims, selectedComponents, selectedFlows, graph, config)
    .map((result) => `${result.type}:${result.object.id}`);
}

function toClaimResults(ranked: RankedContextDocument[], config: GraphContextConfig): ClaimContextResult[] {
  return selectRankedDocuments(ranked, config, { minimumSelected: config.ranking.minimumSelectedClaims })
    .sort((left, right) => right.score - left.score || left.document.key.localeCompare(right.document.key))
    .map((document, index) => {
      const claim = document.document.object as Claim;
      return {
        rank: index + 1,
        score: roundScore(document.score),
        signals: roundRankedSignals(document),
        object: claim,
        about: document.document.about,
        evidence: [],
        code_anchors: [],
      };
    });
}

function filterDocuments<TObject extends { id: string }>(
  documents: ContextDocument[],
  ranked: Array<RankedContextDebugResult<TObject>>,
  type: "claim" | "component" | "flow",
): ContextDocument[] {
  const ids = new Set(ranked.map((row) => `${type}:${row.object.id}`));
  return documents.filter((document) => ids.has(document.key));
}

function semanticScores<TObject extends { id: string }>(
  ranked: Array<RankedContextDebugResult<TObject>>,
  type: "claim" | "component" | "flow",
): SemanticScoreEntry[] {
  return ranked.map((row) => ({
    id: `${type}:${row.object.id}`,
    score: row.signals.semantic_score,
    raw_score: row.signals.semantic_raw_score,
    rank: row.signals.semantic_rank ?? 0,
  }));
}

function bm25Scores<TObject extends { id: string }>(
  ranked: Array<RankedContextDebugResult<TObject>>,
  type: "claim" | "component" | "flow",
): ScoreEntry[] {
  return ranked.map((row) => ({
    id: `${type}:${row.object.id}`,
    score: row.signals.bm25_score,
    raw_score: row.signals.bm25_raw_score,
    rank: row.signals.bm25_rank ?? 0,
  }));
}

function initialPopulation(size: number, rng: () => number): GraphContextConfig[] {
  const configs = [cloneConfig(graphContextConfig)];
  while (configs.length < size) configs.push(randomConfig(rng));
  return configs;
}

function randomConfig(rng: () => number): GraphContextConfig {
  const config = cloneConfig(graphContextConfig);
  for (const spec of searchSpace) setParam(config, spec, spec.min + rng() * (spec.max - spec.min));
  return config;
}

function nextGeneration(
  elites: CandidateResult[],
  populationSize: number,
  rng: () => number,
  nextId: number,
): Array<{ id: number; config: GraphContextConfig }> {
  const next: Array<{ id: number; config: GraphContextConfig }> = elites.map((elite, index) => ({
    id: nextId + index,
    config: cloneConfig(elite.config),
  }));
  while (next.length < populationSize) {
    const parent = elites[Math.floor(rng() * elites.length)];
    const config = parent === undefined ? randomConfig(rng) : mutateConfig(parent.config, rng);
    next.push({ id: nextId + next.length, config });
  }
  return next;
}

function mutateConfig(parent: GraphContextConfig, rng: () => number): GraphContextConfig {
  const config = cloneConfig(parent);
  for (const spec of searchSpace) {
    if (rng() > 0.35) continue;
    const current = getParam(config, spec.path);
    const range = spec.max - spec.min;
    const noise = (rng() + rng() + rng() - 1.5) / 1.5;
    setParam(config, spec, current + noise * range * 0.12);
  }
  if (rng() < 0.15) {
    const spec = searchSpace[Math.floor(rng() * searchSpace.length)];
    if (spec !== undefined) setParam(config, spec, spec.min + rng() * (spec.max - spec.min));
  }
  return config;
}

function splitCases(cases: TrainingCase[]): { train: Set<string>; validation: Set<string> } {
  const train = new Set<string>();
  const validation = new Set<string>();
  cases.forEach((trainingCase, index) => {
    if (index % 5 === 0) validation.add(trainingCase.query.id);
    else train.add(trainingCase.query.id);
  });
  return { train, validation };
}

function compareCandidateResults(left: CandidateResult, right: CandidateResult, objective: CliOptions["objective"]): number {
  return objective === "all" ? compareAll(left, right) : compareValidation(left, right);
}

function compareValidation(left: CandidateResult, right: CandidateResult): number {
  return (
    right.validation.final_score - left.validation.final_score ||
    right.all.final_score - left.all.final_score ||
    right.validation.precision_at_k - left.validation.precision_at_k ||
    left.id - right.id
  );
}

function compareAll(left: CandidateResult, right: CandidateResult): number {
  return (
    right.all.final_score - left.all.final_score ||
    right.validation.final_score - left.validation.final_score ||
    right.all.precision_at_k - left.all.precision_at_k ||
    left.id - right.id
  );
}

function candidateSummary(candidate: CandidateResult) {
  return {
    candidate_id: candidate.id,
    train_final_score: candidate.train.final_score,
    validation_final_score: candidate.validation.final_score,
    all_final_score: candidate.all.final_score,
    all_precision_at_k: candidate.all.precision_at_k,
    all_recall_at_k: candidate.all.recall_at_k,
    ranking: candidate.config.ranking,
  };
}

function cloneConfig(config: GraphContextConfig): GraphContextConfig {
  return JSON.parse(JSON.stringify(config)) as GraphContextConfig;
}

function getParam(config: GraphContextConfig, path: string): number {
  let value: unknown = config;
  for (const part of path.split(".")) {
    if (!isRecord(value)) throw new Error(`Invalid config path ${path}`);
    value = value[part];
  }
  if (typeof value !== "number") throw new Error(`Config path ${path} is not numeric.`);
  return value;
}

function setParam(config: GraphContextConfig, spec: ParamSpec, value: number): void {
  const parts = spec.path.split(".");
  let target: unknown = config;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(target)) throw new Error(`Invalid config path ${spec.path}`);
    target = target[part];
  }
  if (!isRecord(target)) throw new Error(`Invalid config path ${spec.path}`);
  const key = parts[parts.length - 1];
  if (key === undefined) throw new Error(`Invalid config path ${spec.path}`);
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  target[key] = round(clamped, spec.decimals);
}

function stableConfigKey(config: GraphContextConfig): string {
  return JSON.stringify(config.ranking);
}

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  const repoRoot = findRepoRoot(import.meta.url);
  const fromRun = valueAfter(args, "--from-run") ?? latestSearchRun(repoRoot);
  const outputDir = valueAfter(args, "--out") ?? resolve(repoRoot, ".context/ranking-training/runs", timestamp());
  return {
    fromRun,
    generations: positiveInteger(valueAfter(args, "--generations"), 20, "--generations"),
    population: positiveInteger(valueAfter(args, "--population"), 80, "--population"),
    elite: positiveInteger(valueAfter(args, "--elite"), 12, "--elite"),
    seed: positiveInteger(valueAfter(args, "--seed"), 1, "--seed"),
    outputDir,
    objective: parseObjective(valueAfter(args, "--objective")),
  };
}

function parseObjective(value: string | undefined): CliOptions["objective"] {
  if (value === undefined) return "validation";
  if (value === "validation" || value === "all") return value;
  throw new Error("--objective must be validation or all.");
}

function latestSearchRun(repoRoot: string): string {
  const evalRuns = resolve(repoRoot, "eval-runs");
  if (!existsSync(evalRuns)) throw new Error("No eval-runs directory found. Pass --from-run.");
  const candidates = readdirSync(evalRuns)
    .map((entry) => resolve(evalRuns, entry, "search-current-repo-at-8038fe8"))
    .filter((dir) => existsSync(resolve(dir, "result.json")))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (latest === undefined) throw new Error("No search-current-repo eval run found. Pass --from-run.");
  return latest;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
