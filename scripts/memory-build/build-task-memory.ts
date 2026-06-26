import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checksumManifest,
  defaultContextBenchDatasetDir,
  defaultWorkbenchDir,
  option,
  parseArgs,
  readTask,
  run,
  taskDirFor,
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
  const task = option(args, "--task") ?? "cli__cli-362";
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const common = ["--workbench", workbenchDir, "--dataset", datasetDir];
  const skipGithubComments = args.get("--skip-github-comments") === true;

  runStage(scriptDir, "prepare-task.js", [...common, "--task", task]);
  const taskDir = taskDirFor(readTask(join(datasetDir, "tasks", task)), workbenchDir);
  const collectGithubArgs = ["--task-dir", taskDir, "--workbench", workbenchDir];
  runStage(scriptDir, "collect-repo-snapshot.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "extract-symbols.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  if (skipGithubComments) collectGithubArgs.push("--skip-comments");
  copyOption(args, collectGithubArgs, "--github-max-items", "--max-items");
  const githubPacketArgs = ["--task-dir", taskDir, "--workbench", workbenchDir];
  copyOption(args, githubPacketArgs, "--github-max-records", "--max-records");
  copyOption(args, githubPacketArgs, "--github-max-chars", "--max-chars");
  copyOption(args, githubPacketArgs, "--github-max-packets", "--max-packets");
  runStage(scriptDir, "collect-github.js", collectGithubArgs);
  runStage(scriptDir, "run-deep-bootstrap-skill.js", [
    "--task-dir", taskDir,
    "--workbench", workbenchDir,
    "--agent-model", option(args, "--agent-model") ?? "gpt-5.4",
  ]);
  runStage(scriptDir, "prepare-github-packets.js", githubPacketArgs);
  runStage(scriptDir, "apply-proposals.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "run-github-packets-ingest.js", [
    "--task-dir", taskDir,
    "--workbench", workbenchDir,
    "--agent-model", option(args, "--agent-model") ?? "gpt-5.4",
  ]);
  runStage(scriptDir, "apply-proposals.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "audit-anchors.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  runStage(scriptDir, "run-retrieval-smoke.js", ["--task-dir", taskDir, "--workbench", workbenchDir]);
  writeBuildReport(taskDir, [
    `# Memory Build ${task}`,
    "",
    `- Workbench: ${workbenchDir}`,
    "- SQLite DB is runtime-only under `runtime/greplica-home/graph.db`.",
    "- Durable state is task metadata, raw evidence, repo snapshot manifests, proposals, and checksums.",
  ]);
  checksumManifest(taskDir);
  console.log(`Built memory package: ${taskDir}`);
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
