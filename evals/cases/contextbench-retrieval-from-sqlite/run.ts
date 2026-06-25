import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RunnerName = "greplica" | "baseline";
type MemoryProfile = "pre-task" | "pre-github";

interface CliOptions {
  runner: RunnerName;
  memoryProfile: MemoryProfile;
  model: string;
  timeoutSeconds: number;
  dockerStartTimeoutSeconds: number;
  executionEnv: "docker" | "host";
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  limit?: number;
  tasks?: string[];
  datasetDir: string;
  workbenchRoot: string;
  memoryTaskRoot: string;
  runRoot: string;
}

interface DatasetManifest {
  name: string;
  version: number;
  created_at: string;
  source_run_dir: string;
  task_count: number;
  tasks: Array<{
    task_id: string;
    task_index: number;
    status: string;
    base_commit: string;
    target_pr_number: number;
    accepted_for_apples_to_apples: boolean;
  }>;
  runners: RunnerName[];
  memory_profiles: MemoryProfile[];
}

interface ContextBenchTaskResult {
  task_id: string;
  runner: RunnerName;
  memory_profile: MemoryProfile | "empty";
  status: "scored" | "runner_failed" | "missing_result" | "score_missing" | "invalid_eval";
  success: boolean;
  command: {
    command: string[];
    cwd: string;
    exit_code: number | null;
    signal: string | null;
    elapsed_seconds: number;
    stdout_log: string;
    stderr_log: string;
  };
  contextbench_run_dir?: string;
  score?: unknown;
  generation?: unknown;
  trajectory_policy?: unknown;
  final_context_present?: boolean;
  valid_for_eval?: boolean;
  leak_audit?: unknown;
  boundary_audit?: unknown;
}

const repoRoot = findRepoRoot(import.meta.url);
const defaultWorkbenchRoot = resolve(repoRoot, "memory-workbench");
const defaultDatasetDir = resolve(defaultWorkbenchRoot, "datasets/contextbench-cli-cli-retrieval-v1");
const defaultContextBenchRunRoot = resolve(defaultWorkbenchRoot, "runs/contextbench-task");
const defaultMemoryTaskRoot = resolve(defaultWorkbenchRoot, "repos/cli-cli/tasks");

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  runContextBenchBenchmark(options);
}

function runContextBenchBenchmark(options: CliOptions): void {
  if (!existsSync(options.datasetDir)) throw new Error(`Dataset does not exist: ${options.datasetDir}`);
  const manifest = readJson<DatasetManifest>(join(options.datasetDir, "manifest.json"));
  const selectedTasks = selectDatasetTasks(options, manifest);
  const runDir = join(options.runRoot, timestamp(), options.runner);
  mkdirSync(runDir, { recursive: true });

  const results: ContextBenchTaskResult[] = [];
  for (const task of selectedTasks) {
    const result = runContextBenchTask(options, runDir, task.task_id);
    results.push(result);
    writeFileSync(join(runDir, "task-results.jsonl"), `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "a" });
  }

  const aggregate = aggregateContextBenchResults(options, runDir, results);
  writeJson(join(runDir, "contextbench-official-aggregate.json"), aggregate.contextbench_official);
  writeJson(join(runDir, "run-manifest.json"), {
    dataset_dir: options.datasetDir,
    runner: options.runner,
    memory_profile: options.runner === "greplica" ? options.memoryProfile : "empty",
    model: options.model,
    timeout_seconds: options.timeoutSeconds,
    execution_env: options.executionEnv,
    codex_sandbox: options.codexSandbox,
    tasks: selectedTasks.map((task) => task.task_id),
  });
  writeJson(join(runDir, "aggregate.json"), aggregate);

  console.log(`Run directory: ${runDir}`);
  console.log(`Tasks: ${results.length}`);
  console.log(`Success rate: ${(aggregate.success_rate * 100).toFixed(1)}%`);
  console.log(`Official final file coverage: ${aggregate.avg_final_file_coverage.toFixed(4)}`);
  console.log(`Official final file precision: ${aggregate.avg_final_file_precision.toFixed(4)}`);
  console.log(`Avg total tokens: ${aggregate.avg_total_tokens.toFixed(0)}`);
}

function runContextBenchTask(options: CliOptions, runDir: string, taskId: string): ContextBenchTaskResult {
  const taskRunDir = join(runDir, "tasks", taskId);
  const envDir = join(taskRunDir, "env");
  const greplicaHomeDir = join(envDir, "greplica-home");
  const outputDir = join(taskRunDir, "outputs");
  const contextbenchRunsDir = join(taskRunDir, "contextbench-runs");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(contextbenchRunsDir, { recursive: true });

  if (options.runner === "greplica") {
    copyRequiredDir(memoryHomeForTask(options, taskId), greplicaHomeDir);
  }

  const command = [
    "python3",
    resolve(repoRoot, "scripts/contextbench/run_contextbench_codex_smoke.py"),
    "--task",
    taskId,
    "--model",
    options.model,
    "--timeout",
    String(options.timeoutSeconds),
    "--run-root",
    contextbenchRunsDir,
    "--execution-env",
    options.executionEnv,
    "--docker-start-timeout",
    String(options.dockerStartTimeoutSeconds),
    "--codex-sandbox",
    options.codexSandbox,
  ];
  if (options.runner === "greplica") {
    command.push("--allow-greplica", "--greplica-home", greplicaHomeDir);
  }

  const stdoutLog = join(outputDir, "contextbench-stdout.log");
  const stderrLog = join(outputDir, "contextbench-stderr.log");
  const tmpDir = join(outputDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const commandResult = runCommandToFiles(command, repoRoot, {
    ...process.env,
    CONTEXTBENCH_MEMORY_WORKBENCH: options.workbenchRoot,
    CONTEXTBENCH_ROOT: resolve(options.workbenchRoot, "contextbench-inspect"),
    CONTEXTBENCH_GOLD_PARQUET: resolve(options.workbenchRoot, "contextbench-inspect/data/full.parquet"),
    CONTEXTBENCH_PYDEPS: resolve(options.workbenchRoot, "pydeps"),
    GREPLICA_BUNDLE_ROOT: resolve(options.workbenchRoot, "bundles/greplica-linux-bundle"),
    CODEX_BUNDLE_ROOT: resolve(options.workbenchRoot, "bundles/codex-linux-bundle"),
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    CONTEXTBENCH_AGENT_CONTROL_ROOT: join(outputDir, "agent-controls"),
    PYTHONPATH: [
      resolve(repoRoot, "scripts/contextbench"),
      resolve(options.workbenchRoot, "pydeps"),
      process.env.PYTHONPATH ?? "",
    ].join(":"),
  }, stdoutLog, stderrLog);

  const contextbenchRunDir = newestDirectory(contextbenchRunsDir);
  const resultPath = contextbenchRunDir === undefined ? undefined : join(contextbenchRunDir, "result.json");
  const result = resultPath !== undefined && existsSync(resultPath) ? readJson<Record<string, unknown>>(resultPath) : undefined;
  const score = firstContextBenchScore(result);
  const validForEval = result?.valid_for_eval !== false;
  const status: ContextBenchTaskResult["status"] =
    commandResult.exit_code !== 0 ? "runner_failed" :
    result === undefined ? "missing_result" :
    score === undefined ? "score_missing" :
    !validForEval ? "invalid_eval" :
    "scored";

  const output: ContextBenchTaskResult = {
    task_id: taskId,
    runner: options.runner,
    memory_profile: options.runner === "greplica" ? options.memoryProfile : "empty",
    status,
    success: status === "scored",
    command: commandResult,
    contextbench_run_dir: contextbenchRunDir,
    score,
    generation: result?.generation,
    trajectory_policy: result?.trajectory_policy,
    final_context_present: isRecord(result?.trajectory_policy) && result.trajectory_policy.final_context_present === true,
    valid_for_eval: result?.valid_for_eval === undefined ? undefined : result.valid_for_eval === true,
    leak_audit: result?.leak_audit,
    boundary_audit: result?.boundary_audit,
  };
  writeJson(join(outputDir, "result.json"), output);
  return output;
}

function aggregateContextBenchResults(options: CliOptions, runDir: string, results: ContextBenchTaskResult[]) {
  const scoredResults = results.filter((result) => result.success);
  const official = contextBenchOfficialAggregate(options, runDir, results, scoredResults);
  const officialAggregate = official.aggregate;
  return {
    run_dir: runDir,
    runner: options.runner,
    memory_profile: options.runner === "greplica" ? options.memoryProfile : "empty",
    task_count: results.length,
    success_count: scoredResults.length,
    success_rate: average(results.map((result) => result.success ? 1 : 0)),
    avg_elapsed_seconds: average(scoredResults.map((result) => result.command.elapsed_seconds)),
    avg_total_tokens: average(scoredResults.map((result) => numericPath(result.generation, ["total_tokens"]))),
    avg_input_tokens: average(scoredResults.map((result) => numericPath(result.generation, ["input_tokens"]))),
    avg_cached_input_tokens: average(scoredResults.map((result) => numericPath(result.generation, ["cached_input_tokens"]))),
    avg_output_tokens: average(scoredResults.map((result) => numericPath(result.generation, ["output_tokens"]))),
    avg_reasoning_output_tokens: average(scoredResults.map((result) => numericPath(result.generation, ["reasoning_output_tokens"]))),
    avg_tool_calls: average(scoredResults.map((result) => numericPath(result.generation, ["tool_calls"]))),
    avg_final_file_coverage: numericPath(officialAggregate, ["final_file", "coverage"]),
    avg_final_file_precision: numericPath(officialAggregate, ["final_file", "precision"]),
    avg_final_span_coverage: numericPath(officialAggregate, ["final_span", "coverage"]),
    avg_final_span_precision: numericPath(officialAggregate, ["final_span", "precision"]),
    avg_final_line_coverage: numericPath(officialAggregate, ["final_line", "coverage"]),
    avg_final_line_precision: numericPath(officialAggregate, ["final_line", "precision"]),
    avg_trajectory_file_auc: numericPath(officialAggregate, ["traj_auc_file"]),
    avg_trajectory_span_auc: numericPath(officialAggregate, ["traj_auc_span"]),
    avg_trajectory_line_auc: numericPath(officialAggregate, ["traj_auc_line"]),
    avg_editloc_recall: numericPath(officialAggregate, ["editloc", "recall"]),
    avg_editloc_precision: numericPath(officialAggregate, ["editloc", "precision"]),
    contextbench_official: official,
    tasks: results.map((result) => ({
      task_id: result.task_id,
      status: result.status,
      valid_for_eval: result.valid_for_eval,
      elapsed_seconds: result.command.elapsed_seconds,
      total_tokens: numericPath(result.generation, ["total_tokens"]),
      input_tokens: numericPath(result.generation, ["input_tokens"]),
      cached_input_tokens: numericPath(result.generation, ["cached_input_tokens"]),
      output_tokens: numericPath(result.generation, ["output_tokens"]),
      reasoning_output_tokens: numericPath(result.generation, ["reasoning_output_tokens"]),
      tool_calls: numericPath(result.generation, ["tool_calls"]),
      final_file_coverage: numericPath(result.score, ["final", "file", "coverage"]),
      final_file_precision: numericPath(result.score, ["final", "file", "precision"]),
      final_span_coverage: numericPath(result.score, ["final", "span", "coverage"]),
      final_span_precision: numericPath(result.score, ["final", "span", "precision"]),
      final_line_coverage: numericPath(result.score, ["final", "line", "coverage"]),
      final_line_precision: numericPath(result.score, ["final", "line", "precision"]),
      trajectory_file_auc: numericPath(result.score, ["trajectory", "auc_coverage", "file"]),
      trajectory_span_auc: numericPath(result.score, ["trajectory", "auc_coverage", "span"]),
      trajectory_line_auc: numericPath(result.score, ["trajectory", "auc_coverage", "line"]),
      editloc_recall: numericPath(result.score, ["editloc", "recall"]),
      editloc_precision: numericPath(result.score, ["editloc", "precision"]),
      contextbench_run_dir: result.contextbench_run_dir,
    })),
  };
}

function contextBenchOfficialAggregate(
  options: CliOptions,
  runDir: string,
  results: ContextBenchTaskResult[],
  scoredResults: ContextBenchTaskResult[],
) {
  const scoreRows = scoredResults.map((result) => result.score);
  const resultsJsonlPath = join(runDir, "contextbench-results.jsonl");
  writeJsonl(resultsJsonlPath, scoreRows);

  const inspectRoot = resolve(options.workbenchRoot, "contextbench-inspect");
  const pydeps = resolve(options.workbenchRoot, "pydeps");
  const script = [
    "import json, sys",
    "from contextbench.evaluate import aggregate_results",
    "rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]",
    "print(json.dumps(aggregate_results(rows)))",
  ].join("\n");
  const aggregateResult = spawnSync("python3", ["-c", script, resultsJsonlPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: [inspectRoot, pydeps, process.env.PYTHONPATH ?? ""].join(":"),
    },
    encoding: "utf8",
  });
  if (aggregateResult.status !== 0) {
    throw new Error([
      "ContextBench official aggregation failed.",
      aggregateResult.stderr?.toString().trim(),
      aggregateResult.stdout?.toString().trim(),
    ].filter(Boolean).join("\n"));
  }

  const aggregate = JSON.parse(aggregateResult.stdout) as Record<string, unknown>;
  return {
    aggregate,
    aggregation_source: "contextbench.evaluate.aggregate_results",
    costs_on_scored_rows: {
      elapsed_seconds: sum(scoredResults.map((result) => result.command.elapsed_seconds)),
      input_tokens: sum(scoredResults.map((result) => numericPath(result.generation, ["input_tokens"]))),
      cached_input_tokens: sum(scoredResults.map((result) => numericPath(result.generation, ["cached_input_tokens"]))),
      output_tokens: sum(scoredResults.map((result) => numericPath(result.generation, ["output_tokens"]))),
      reasoning_output_tokens: sum(scoredResults.map((result) => numericPath(result.generation, ["reasoning_output_tokens"]))),
      tool_calls: sum(scoredResults.map((result) => numericPath(result.generation, ["tool_calls"]))),
      total_tokens: sum(scoredResults.map((result) => numericPath(result.generation, ["total_tokens"]))),
    },
    run_dir: runDir,
    scored_count: scoredResults.length,
    scored_instance_ids: scoredResults.map((result) => stringPath(result.score, ["instance_id"])).filter(Boolean),
    status_counts: statusCounts(results),
    status_rows_count: results.length,
    generated_at: Date.now() / 1000,
  };
}

function selectDatasetTasks(options: CliOptions, manifest: DatasetManifest): DatasetManifest["tasks"] {
  const accepted = manifest.tasks.filter((task) => task.accepted_for_apples_to_apples);
  const byTask = new Map(manifest.tasks.map((task) => [task.task_id, task]));
  const selected = options.tasks === undefined ? accepted : options.tasks.map((taskId) => {
    const task = byTask.get(taskId);
    if (task === undefined) throw new Error(`Task ${taskId} was not found in dataset.`);
    return task;
  });
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    runner: parseRunner(valueAfter(argv, "--runner") ?? "greplica"),
    memoryProfile: parseMemoryProfile(valueAfter(argv, "--memory-profile") ?? "pre-task"),
    model: valueAfter(argv, "--model") ?? "gpt-5.4",
    timeoutSeconds: parseOptionalPositiveInteger(valueAfter(argv, "--timeout"), "--timeout") ?? 1200,
    dockerStartTimeoutSeconds: parseOptionalPositiveInteger(valueAfter(argv, "--docker-start-timeout"), "--docker-start-timeout") ?? 1800,
    executionEnv: parseExecutionEnv(valueAfter(argv, "--execution-env") ?? "docker"),
    codexSandbox: parseCodexSandbox(valueAfter(argv, "--codex-sandbox") ?? "danger-full-access"),
    limit: parseOptionalPositiveInteger(valueAfter(argv, "--limit"), "--limit"),
    tasks: parseTaskSelection(argv),
    workbenchRoot: resolve(valueAfter(argv, "--workbench-root") ?? defaultWorkbenchRoot),
    datasetDir: resolve(valueAfter(argv, "--dataset") ?? defaultDatasetDir),
    memoryTaskRoot: resolve(valueAfter(argv, "--memory-task-root") ?? defaultMemoryTaskRoot),
    runRoot: resolve(valueAfter(argv, "--run-root") ?? defaultContextBenchRunRoot),
  };
  return options;
}

function memoryHomeForTask(options: CliOptions, taskId: string): string {
  return join(options.memoryTaskRoot, taskId, "runtime", "greplica-home");
}

function parseRunner(value: string): RunnerName {
  if (value === "greplica" || value === "baseline") return value;
  throw new Error("--runner must be greplica or baseline");
}

function parseMemoryProfile(value: string): MemoryProfile {
  if (value === "pre-task" || value === "pre-github") return value;
  throw new Error("--memory-profile must be pre-task or pre-github");
}

function parseExecutionEnv(value: string): "docker" | "host" {
  if (value === "docker" || value === "host") return value;
  throw new Error("--execution-env must be docker or host");
}

function parseCodexSandbox(value: string): "read-only" | "workspace-write" | "danger-full-access" {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new Error("--codex-sandbox must be read-only, workspace-write, or danger-full-access");
}

function parseTasks(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.split(",").map((task) => task.trim()).filter(Boolean);
}

function parseTaskSelection(argv: string[]): string[] | undefined {
  const tasks = parseTasks(valueAfter(argv, "--tasks"));
  const task = valueAfter(argv, "--task");
  if (tasks !== undefined && task !== undefined) throw new Error("Use either --task or --tasks, not both.");
  if (task === undefined) return tasks;
  const trimmed = task.trim();
  if (trimmed.length === 0) throw new Error("--task must not be empty.");
  return [trimmed];
}

function parseOptionalPositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function runCommandToFiles(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdoutLog: string,
  stderrLog: string,
): ContextBenchTaskResult["command"] {
  const started = Date.now();
  mkdirSync(dirname(stdoutLog), { recursive: true });
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
  });
  writeFileSync(stdoutLog, result.stdout?.toString() ?? "", "utf8");
  writeFileSync(stderrLog, result.stderr?.toString() ?? "", "utf8");
  return {
    command,
    cwd,
    exit_code: result.status,
    signal: result.signal,
    elapsed_seconds: round((Date.now() - started) / 1000),
    stdout_log: stdoutLog,
    stderr_log: stderrLog,
  };
}

function copyRequiredDir(from: string, to: string): void {
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`Missing directory: ${from}`);
  cpSync(from, to, { recursive: true });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path: string, values: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""), "utf8");
}

function newestDirectory(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const directories = readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return directories[0];
}

function firstContextBenchScore(result: Record<string, unknown> | undefined): unknown {
  const rows = result?.contextbench_rows;
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return undefined;
}

function numericPath(value: unknown, path: string[]): number {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return 0;
    current = current[key];
  }
  return typeof current === "number" ? current : 0;
}

function stringPath(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current : "";
}

function statusCounts(results: ContextBenchTaskResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sum(values: number[]): number {
  return round(values.reduce((total, value) => total + value, 0));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRepoRoot(importMetaUrl: string): string {
  const dir = dirname(fileURLToPath(importMetaUrl));
  const distMarker = `${process.platform === "win32" ? "\\" : "/"}dist${process.platform === "win32" ? "\\" : "/"}`;
  const distIndex = dir.indexOf(distMarker);
  if (distIndex !== -1) return dir.slice(0, distIndex);
  return resolve(dir, "../../..");
}
