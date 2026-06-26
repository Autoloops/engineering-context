import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  git,
  gitOptional,
  readJson,
  run,
  runOrThrow,
  timestamp,
  writeJson,
} from "../../lib/common.js";
import {
  expectedFor,
  parseReturnedIds,
  qrelsFor,
  scoreSearchQuery,
  scoreSearchRun,
  type AggregateSearchScore,
  type SearchQueryCase,
  type SearchQueryScore,
  type SearchRubric,
  validateSearchRubric,
} from "../../lib/search-retrieval-scoring.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

const caseId = "search-current-repo-at-8038fe8";
const targetCommit = "8038fe8c82c3cf7c9175c188f503aa0df72d2fa2";

interface RunContext {
  repoRoot: string;
  runDir: string;
  targetRepoDir: string;
  targetRepoUrl: string;
  greplicaHomeDir: string;
  embeddingProvider: "local" | "openai" | undefined;
  embeddingModel: string | undefined;
  embeddingDimensions: number | undefined;
  embeddingBatchSize: number | undefined;
  proposalPath: string;
  rubricPath: string;
  greplicaCommand: string[];
}

interface QueryScore extends SearchQueryScore {
  command: CommandResult;
}

interface EvalResult {
  case_id: string;
  benchmark_version: string;
  target_repo: {
    remote_url: string;
    commit: string;
    branch: string;
  };
  run_dir: string;
  target_repo_dir: string;
  greplica_home_dir: string;
  proposal_path: string;
  rubric_path: string;
  setup_commands: CommandResult[];
  query_scores: QueryScore[];
  score: AggregateSearchScore;
  success: boolean;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const context = prepareRun();
  prepareTargetRepo(context);
  const rubric = readJson<SearchRubric>(context.rubricPath);
  validateSearchRubric(rubric, 34);

  const setupCommands = [
    runInitCommand(context),
    runProductCommand(context, "proposal", "validate", context.proposalPath),
    runProductCommand(context, "proposal", "apply", context.proposalPath),
  ];

  const queryScores = setupCommands.every((command) => command.exit_code === 0)
    ? rubric.queries.map((queryCase) => runQuery(context, rubric, queryCase))
    : [];
  const score = scoreSearchRun(rubric, queryScores);
  const success = setupCommands.every((command) => command.exit_code === 0) && score.passed;

  writeResult(context, rubric, setupCommands, queryScores, score, success);

  console.log(success ? "Search eval passed." : "Search eval failed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Score: ${score.final_score.toFixed(2)} / 100`);
  console.log(
    `P@${rubric.k}: ${score.precision_at_k.toFixed(3)}  R@${rubric.k}: ${score.recall_at_k.toFixed(3)}  MRR@${rubric.k}: ${score.mrr_at_k.toFixed(3)}  nDCG@${rubric.k}: ${score.ndcg_at_k.toFixed(3)}  GradeRecall@${rubric.k}: ${score.grade_recall_at_k.toFixed(3)}`,
  );
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  const targetRepoDir = resolve(runDir, "target-repo");
  const targetRepoUrl = process.env.GREPLICA_EVAL_TARGET_REPO_URL ?? repoRoot;
  const greplicaHomeDir = resolve(runDir, "greplica-home");
  const embeddingProvider = parseEmbeddingProvider(process.env.GREPLICA_EVAL_EMBEDDING_PROVIDER);
  const embeddingModel = parseOptionalString(process.env.GREPLICA_EVAL_EMBEDDING_MODEL, "GREPLICA_EVAL_EMBEDDING_MODEL");
  const embeddingDimensions = parseOptionalPositiveInteger(process.env.GREPLICA_EVAL_EMBEDDING_DIMENSIONS, "GREPLICA_EVAL_EMBEDDING_DIMENSIONS");
  const embeddingBatchSize = parseOptionalPositiveInteger(process.env.GREPLICA_EVAL_EMBEDDING_BATCH_SIZE, "GREPLICA_EVAL_EMBEDDING_BATCH_SIZE");

  mkdirSync(runDir, { recursive: true });
  mkdirSync(greplicaHomeDir, { recursive: true });

  return {
    repoRoot,
    runDir,
    targetRepoDir,
    targetRepoUrl,
    greplicaHomeDir,
    embeddingProvider,
    embeddingModel,
    embeddingDimensions,
    embeddingBatchSize,
    proposalPath: resolve(repoRoot, "evals/cases/search-current-repo-at-8038fe8/proposal.json"),
    rubricPath: resolve(repoRoot, "evals/cases/search-current-repo-at-8038fe8/rubric.json"),
    greplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

function parseEmbeddingProvider(value: string | undefined): "local" | "openai" | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (value === "local" || value === "openai") return value;
  throw new Error("GREPLICA_EVAL_EMBEDDING_PROVIDER must be local or openai.");
}

function parseOptionalString(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return trimmed;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function prepareTargetRepo(context: RunContext): void {
  runOrThrow(["git", "clone", context.targetRepoUrl, context.targetRepoDir], context.repoRoot);
  runOrThrow(["git", "checkout", targetCommit], context.targetRepoDir);
}

function runQuery(context: RunContext, rubric: SearchRubric, queryCase: SearchQueryCase): QueryScore {
  const command = runProductCommand(context, "graph", "context", queryCase.query, "--debug");
  const returnedIds = command.exit_code === 0 ? parseReturnedIds(command.stdout ?? "") : [];
  const qrels = qrelsFor(queryCase);
  const metrics = scoreSearchQuery(qrels, returnedIds, rubric.k);

  return {
    id: queryCase.id,
    query: queryCase.query,
    returned_ids: returnedIds,
    expected: expectedFor(queryCase),
    command,
    ...metrics,
    passed: command.exit_code === 0 && metrics.recall_at_k > 0 && metrics.mrr_at_k > 0,
  };
}

function writeResult(
  context: RunContext,
  rubric: SearchRubric,
  setupCommands: CommandResult[],
  queryScores: QueryScore[],
  score: AggregateSearchScore,
  success: boolean,
): void {
  const result: EvalResult = {
    case_id: rubric.case_id,
    benchmark_version: rubric.benchmark_version,
    target_repo: {
      remote_url: context.targetRepoUrl,
      commit: git(context.targetRepoDir, ["rev-parse", "HEAD"]),
      branch: gitOptional(context.targetRepoDir, ["branch", "--show-current"]) ?? "",
    },
    run_dir: context.runDir,
    target_repo_dir: context.targetRepoDir,
    greplica_home_dir: context.greplicaHomeDir,
    proposal_path: context.proposalPath,
    rubric_path: context.rubricPath,
    setup_commands: setupCommands,
    query_scores: queryScores,
    score,
    success,
  };

  writeJson(resolve(context.runDir, "result.json"), result);
}

function runProductCommand(context: RunContext, ...args: string[]): CommandResult {
  return run([...context.greplicaCommand, ...args], context.targetRepoDir, {
    ...process.env,
    GREPLICA_HOME: context.greplicaHomeDir,
  });
}

function runInitCommand(context: RunContext): CommandResult {
  const result = runProductCommand(
    context,
    "install",
    "--platform",
    "codex",
    "--embedding",
    context.embeddingProvider ?? "local",
  );
  if (result.exit_code === 0) writeEvalEmbeddingOverride(context);
  return result;
}

function writeEvalEmbeddingOverride(context: RunContext): void {
  if (
    context.embeddingModel === undefined &&
    context.embeddingDimensions === undefined &&
    context.embeddingBatchSize === undefined
  ) {
    return;
  }

  const configPath = resolve(context.greplicaHomeDir, "config.json");
  const config = readJson<Record<string, unknown>>(configPath);
  const embedding = isRecord(config.embedding) ? config.embedding : {};

  writeJson(configPath, {
    ...config,
    embedding: {
      ...embedding,
      ...(context.embeddingModel === undefined ? {} : { model: context.embeddingModel }),
      ...(context.embeddingDimensions === undefined ? {} : { dimensions: context.embeddingDimensions }),
      ...(context.embeddingBatchSize === undefined ? {} : { batchSize: context.embeddingBatchSize }),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
