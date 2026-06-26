import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checksumManifest,
  defaultContextBenchDatasetDir,
  defaultWorkbenchDir,
  option,
  parseArgs,
  readJson,
  readTask,
  run,
  taskDirFor,
  writeJson,
  writeBuildReport,
} from "./lib.js";

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const datasetDir = resolve(option(args, "--dataset") ?? defaultContextBenchDatasetDir);
  const task = option(args, "--task") ?? "cli__cli-495";
  const baseTask = option(args, "--base-task") ?? "cli__cli-362";
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const common = ["--workbench", workbenchDir];
  common.push("--dataset", datasetDir);

  const baseTaskDir = taskDirFor({
    task_id: baseTask,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  }, workbenchDir);

  runStage(scriptDir, "prepare-task.js", [...common, "--task", task]);
  const taskDir = taskDirFor(readTask(join(datasetDir, "tasks", task)), workbenchDir);
  const currentTask = readTask(taskDir);
  const previousTask = readTask(baseTaskDir);
  const parentChecksum = readJson<{ package_sha256?: string }>(join(baseTaskDir, "checksums.json")).package_sha256;
  writeJson(join(taskDir, "task.json"), {
    ...currentTask,
    inherits_from_task: previousTask.task_id,
    inherits_from_package_sha256: parentChecksum,
  });
  const sinceCutoff = previousTask.cutoff;

  runStage(scriptDir, "collect-repo-snapshot.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "extract-symbols.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "run-layered-deep-bootstrap-skill.js", [
    "--task-dir", taskDir,
    "--base-task-dir", baseTaskDir,
    "--workbench", workbenchDir,
    "--agent-model", option(args, "--agent-model") ?? "gpt-5.4",
  ]);
  runStage(scriptDir, "apply-proposals.js", [
    "--task-dir", taskDir,
    "--base-task-dir", baseTaskDir,
    "--workbench", workbenchDir,
  ]);

  const collectGithubArgs = [
    "--task-dir", taskDir,
    "--workbench", workbenchDir,
    "--since-cutoff", sinceCutoff,
  ];
  if (args.get("--skip-github-comments") === true) collectGithubArgs.push("--skip-comments");
  copyOption(args, collectGithubArgs, "--github-max-items", "--max-items");
  runStage(scriptDir, "collect-github.js", collectGithubArgs);

  const githubPacketArgs = [
    "--task-dir", taskDir,
    "--workbench", workbenchDir,
    "--since-cutoff", sinceCutoff,
  ];
  copyOption(args, githubPacketArgs, "--github-max-records", "--max-records");
  copyOption(args, githubPacketArgs, "--github-max-chars", "--max-chars");
  copyOption(args, githubPacketArgs, "--github-max-packets", "--max-packets");
  runStage(scriptDir, "prepare-github-packets.js", githubPacketArgs);
  runStage(scriptDir, "run-github-packets-ingest.js", [
    "--task-dir", taskDir,
    "--workbench", workbenchDir,
    "--agent-model", option(args, "--agent-model") ?? "gpt-5.4",
  ]);
  runStage(scriptDir, "apply-proposals.js", [
    "--task-dir", taskDir,
    "--base-task-dir", baseTaskDir,
    "--workbench", workbenchDir,
  ]);
  runStage(scriptDir, "audit-anchors.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "run-retrieval-smoke.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  writeBuildReport(taskDir, [
    `# Incremental Memory Build ${currentTask.task_id}`,
    "",
    `- Parent task: ${previousTask.task_id}`,
    `- Parent cutoff: ${previousTask.cutoff}`,
    `- Current cutoff: ${currentTask.cutoff}`,
    `- GitHub evidence window: ${previousTask.cutoff} < created_at < ${currentTask.cutoff}`,
    `- Workbench: ${workbenchDir}`,
    "- SQLite DB is runtime-only under `runtime/greplica-home/graph.db`.",
    "- Durable state is task metadata, raw evidence, repo snapshot manifests, proposals, parent task reference, and checksums.",
  ]);
  checksumManifest(taskDir);
  console.log(`Built incremental memory package: ${taskDir}`);
}

function runStage(scriptDir: string, script: string, args: string[]): void {
  console.log(`\n== ${script} ==`);
  const output = run([process.execPath, join(scriptDir, script), ...args]);
  if (output.trim().length > 0) console.log(output.trim());
}

function copyOption(args: Map<string, string | true>, target: string[], from: string, to: string): void {
  const value = option(args, from);
  if (value !== undefined) target.push(to, value);
}
