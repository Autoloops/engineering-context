import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  copyRequiredFile,
  defaultContextBenchDatasetDir,
  defaultWorkbenchDir,
  extractLinkedGithubNumbersFromText,
  option,
  parseArgs,
  readTextIfExists,
  readJson,
  repoSlug,
  taskDirFor,
  type TaskManifest,
  writeJson,
} from "./lib.js";

interface DatasetManifest {
  tasks: Array<{
    task_id: string;
    task_index?: number;
    base_commit: string;
    target_pr_number?: number;
    accepted_for_apples_to_apples?: boolean;
  }>;
}

interface SourceProvenance {
  source_task_run_dir?: string;
  source_task_dir?: string;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = resolve(option(args, "--dataset") ?? defaultContextBenchDatasetDir);
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskId = option(args, "--task") ?? firstTaskId(datasetDir);
  const datasetTaskDir = join(datasetDir, "tasks", taskId);
  if (!existsSync(datasetTaskDir)) throw new Error(`Dataset task does not exist: ${datasetTaskDir}`);

  const sourceTask = readJson<TaskManifest>(join(datasetTaskDir, "task.json"));
  const linkedNumbers = linkedNumbersForDatasetTask(datasetDir, datasetTaskDir, sourceTask);
  const benchmarkExcludedNumbers = benchmarkExcludedGithubNumbers(datasetDir);
  const taskDir = taskDirFor(sourceTask, workbenchDir);
  const existingTask = readOptionalJson<TaskManifest>(join(taskDir, "task.json"));
  const task: TaskManifest = {
    task_id: sourceTask.task_id,
    task_index: sourceTask.task_index,
    instance_id: sourceTask.instance_id,
    repo: sourceTask.repo,
    repo_url: sourceTask.repo_url,
    memory_remote_url: sourceTask.memory_remote_url,
    base_commit: sourceTask.base_commit,
    cutoff: sourceTask.cutoff,
    target_pr_number: sourceTask.target_pr_number,
    task_pr_url: sourceTask.task_pr_url,
    linked_issue_numbers: sourceTask.linked_issue_numbers,
    linked_pr_numbers: sourceTask.linked_pr_numbers,
    linked_numbers_in_problem: linkedNumbers.length > 0 ? linkedNumbers : sourceTask.linked_numbers_in_problem,
    benchmark_excluded_github_numbers: benchmarkExcludedNumbers,
    accepted_for_apples_to_apples: sourceTask.accepted_for_apples_to_apples,
    source_dataset_task_dir: datasetTaskDir,
    source_base_source_tar: join(datasetTaskDir, "repo", "base-source.tar.gz"),
    inherits_from_task: existingTask?.inherits_from_task,
    inherits_from_package_sha256: existingTask?.inherits_from_package_sha256,
  };

  mkdirSync(taskDir, { recursive: true });
  writeJson(join(taskDir, "task.json"), task);
  writeJson(join(taskDir, "cutoff.json"), {
    cutoff: task.cutoff,
    cutoff_is_exclusive: true,
    reason: "Only evidence created before cutoff may be ingested into memory.",
  });
  copyRequiredFile(join(datasetTaskDir, "prompt.md"), join(taskDir, "raw", "contextbench-prompt.md"));
  if (existsSync(join(datasetTaskDir, "provenance.json"))) {
    copyRequiredFile(join(datasetTaskDir, "provenance.json"), join(taskDir, "raw", "source-provenance.json"));
  }

  const taskSetDir = join(workbenchDir, "task-sets");
  mkdirSync(taskSetDir, { recursive: true });
  writeJson(join(taskSetDir, `${repoSlug(task.repo)}-first.json`), {
    name: `${task.repo} first task`,
    tasks: [task.task_id],
  });

  console.log(`Prepared task package: ${taskDir}`);
}

function benchmarkExcludedGithubNumbers(datasetDir: string): number[] {
  const manifest = readJson<DatasetManifest>(join(datasetDir, "manifest.json"));
  const numbers = new Set<number>();
  for (const task of manifest.tasks) {
    if (typeof task.target_pr_number === "number") numbers.add(task.target_pr_number);
    const taskDir = join(datasetDir, "tasks", task.task_id);
    const taskJson = readOptionalJson<TaskManifest>(join(taskDir, "task.json"));
    for (const value of [
      taskJson?.target_pr_number,
      taskJson?.target_issue_number,
      ...(taskJson?.target_issue_numbers ?? []),
      ...(taskJson?.linked_issue_numbers ?? []),
      ...(taskJson?.linked_pr_numbers ?? []),
      ...(taskJson?.linked_numbers_in_problem ?? []),
    ]) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) numbers.add(value);
    }
    for (const prompt of contextBenchRunPromptTexts(datasetDir, task.task_id)) {
      for (const value of extractLinkedGithubNumbersFromText(prompt)) numbers.add(value);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function linkedNumbersForDatasetTask(datasetDir: string, datasetTaskDir: string, sourceTask: TaskManifest): number[] {
  const explicit = [
    ...(sourceTask.linked_issue_numbers ?? []),
    ...(sourceTask.linked_pr_numbers ?? []),
    ...(sourceTask.linked_numbers_in_problem ?? []),
  ];
  const texts = [
    readTextIfExists(join(datasetTaskDir, "prompt.md")),
  ];
  const provenance = readOptionalJson<SourceProvenance>(join(datasetTaskDir, "provenance.json"));
  if (provenance?.source_task_run_dir !== undefined) {
    texts.push(readTextIfExists(join(provenance.source_task_run_dir, "final-context-request-prompt.txt")));
  }
  if (provenance?.source_task_dir !== undefined) {
    texts.push(readTextIfExists(join(provenance.source_task_dir, "prompt.md")));
  }
  texts.push(...contextBenchRunPromptTexts(datasetDir, sourceTask.task_id));
  const discovered = texts.flatMap((text) => text === undefined ? [] : extractLinkedGithubNumbersFromText(text));
  const targetNumbers = new Set([
    sourceTask.target_pr_number,
    sourceTask.target_issue_number,
    ...(sourceTask.target_issue_numbers ?? []),
  ].filter((value): value is number => typeof value === "number"));
  return [...new Set([...explicit, ...discovered])]
    .filter((value) => Number.isInteger(value) && value > 0 && !targetNumbers.has(value))
    .sort((left, right) => left - right);
}

function contextBenchRunPromptTexts(datasetDir: string, taskId: string): string[] {
  const runsRoot = join(dirname(dirname(datasetDir)), "runs", "contextbench-task");
  if (!existsSync(runsRoot)) return [];
  const prompts: string[] = [];
  for (const runName of safeReadDir(runsRoot)) {
    const runDir = join(runsRoot, runName);
    if (!statSync(runDir).isDirectory()) continue;
    for (const arm of safeReadDir(runDir)) {
      const taskRoot = join(runDir, arm, "tasks", taskId, "contextbench-runs");
      if (!existsSync(taskRoot) || !statSync(taskRoot).isDirectory()) continue;
      for (const taskRun of safeReadDir(taskRoot)) {
        const prompt = readTextIfExists(join(taskRoot, taskRun, "final-context-request-prompt.txt"));
        if (prompt !== undefined) prompts.push(prompt);
      }
    }
  }
  return prompts;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function readOptionalJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return readJson<T>(path);
}

function firstTaskId(datasetDir: string): string {
  const manifest = readJson<DatasetManifest>(join(datasetDir, "manifest.json"));
  const first = manifest.tasks.find((task) => task.accepted_for_apples_to_apples !== false) ?? manifest.tasks[0];
  if (first === undefined) throw new Error(`No tasks in dataset manifest: ${datasetDir}`);
  return first.task_id;
}
