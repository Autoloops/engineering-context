import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCodexAgent } from "../../libs/agent-runner/codex.js";
import {
  greplicaCommand,
  installGreplica,
  seedCodexRuntimeHome,
  validateAndApplyManifest,
} from "./agent-utils.js";
import {
  checksumManifest,
  defaultWorkbenchDir,
  ensureBenchmarkRepoIdentity,
  option,
  parseArgs,
  proposalLineageTaskDirs,
  readJson,
  readTask,
  repoRawDirFor,
  repoRoot,
  run,
  taskDirFor,
  writeJson,
} from "./lib.js";

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const baseTaskDir = resolve(requiredParentTaskDir(args, workbenchDir));
  const task = readTask(taskDir);
  const baseTask = readTask(baseTaskDir);
  const repoManifest = readJson<{ checkout_dir: string }>(join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit, "manifest.json"));
  const checkoutDir = repoManifest.checkout_dir;
  const parentManifestPath = join(baseTaskDir, "proposals", "manifest.json");
  if (!existsSync(parentManifestPath)) throw new Error(`Parent proposal manifest missing: ${parentManifestPath}`);

  const runDir = join(taskDir, "runtime", "layered-deep-bootstrap-skill");
  const codexHome = join(runDir, "codex-home");
  const greplicaHome = join(runDir, "greplica-home");
  const transcriptPath = join(runDir, "agent-events.jsonl");
  const finalMessagePath = join(runDir, "agent-final-message.txt");
  const reportPath = join(runDir, "report.json");
  const command = greplicaCommand();

  cleanLayeredProposalFiles(join(taskDir, "proposals"));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(greplicaHome, { recursive: true });
  seedCodexRuntimeHome(codexHome);
  ensureBenchmarkRepoIdentity(checkoutDir, task);

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    GREPLICA_HOME: greplicaHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const setup = installGreplica(command, checkoutDir, env);
  const parentTaskDirs = proposalLineageTaskDirs(baseTaskDir, workbenchDir);
  const parentApply = parentTaskDirs.flatMap((lineageTaskDir) => validateAndApplyManifest({
    taskDir: lineageTaskDir,
    checkoutDir,
    env,
    greplicaCommand: command,
  }));
  const result = await runCodexAgent({
    cwd: checkoutDir,
    env,
    model: option(args, "--agent-model") ?? "gpt-5.4",
    prompt: layeredBootstrapPrompt({
      skill: readFileSync(join(repoRoot, "scripts", "memory-build", "prompts", "layered-deep-bootstrap.md"), "utf8"),
      greplicaCommand: command.join(" "),
      proposalsDir: join(taskDir, "proposals"),
      manifestPath: join(taskDir, "proposals", "manifest.json"),
      repoSnapshotPath: join(taskDir, "evidence", "repo-snapshot.manifest.json"),
      symbolsPath: join(taskDir, "evidence", "symbols.manifest.json"),
      taskId: task.task_id,
      baseTaskId: baseTask.task_id,
      previousCutoff: baseTask.cutoff,
      cutoff: task.cutoff,
    }),
    transcriptPath,
    finalMessagePath,
  });
  if (result.exit_code !== 0) throw new Error(`Layered deep bootstrap agent failed with exit code ${String(result.exit_code)}.`);

  const manifestPath = join(taskDir, "proposals", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Layered bootstrap did not write manifest: ${manifestPath}`);
  const manifest = readJson<{ apply_order?: string[] }>(manifestPath);
  const applyOrder = manifest.apply_order ?? [];
  if (applyOrder.length === 0) throw new Error(`Layered bootstrap manifest has no proposals: ${manifestPath}`);
  for (const file of applyOrder) {
    const proposalPath = join(taskDir, "proposals", file);
    if (!existsSync(proposalPath)) throw new Error(`Layered bootstrap manifest references missing proposal: ${proposalPath}`);
  }

  const validationHome = join(runDir, "validation-greplica-home");
  mkdirSync(validationHome, { recursive: true });
  const validationEnv = {
    ...process.env,
    GREPLICA_HOME: validationHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const validationSetup = installGreplica(command, checkoutDir, validationEnv);
  const validationParentApply = parentTaskDirs.flatMap((lineageTaskDir) => validateAndApplyManifest({
    taskDir: lineageTaskDir,
    checkoutDir,
    env: validationEnv,
    greplicaCommand: command,
  }));
  const validation = validateAndApplyManifest({
    taskDir,
    checkoutDir,
    env: validationEnv,
    greplicaCommand: command,
  });
  const audit = run([...command, "graph", "audit", "anchors"], checkoutDir, validationEnv);
  const probe = run([...command, "graph", "context", "pull request commands issue commands table rendering api queries"], checkoutDir, validationEnv);
  writeFileSync(join(runDir, "probe.md"), probe, "utf8");
  writeJson(reportPath, {
    task_id: task.task_id,
    base_task_id: baseTask.task_id,
    parent_manifest_path: parentManifestPath,
    checkout_dir: checkoutDir,
    setup_stdout: setup,
    parent_apply_stdout: parentApply,
    generation: result,
    validation_setup_stdout: validationSetup,
    validation_parent_apply_stdout: validationParentApply,
    validation_stdout: validation,
    audit_stdout: audit,
    proposal_files: applyOrder,
    probe_stdout_path: join(runDir, "probe.md"),
    generated_at: new Date().toISOString(),
  });
  checksumManifest(taskDir);
  console.log(`Layered bootstrap wrote manifest: ${relative(repoRoot, manifestPath)}`);
  console.log(`Proposal files: ${applyOrder.length}`);
  console.log(`Report: ${relative(repoRoot, reportPath)}`);
}

function layeredBootstrapPrompt(input: {
  skill: string;
  greplicaCommand: string;
  proposalsDir: string;
  manifestPath: string;
  repoSnapshotPath: string;
  symbolsPath: string;
  taskId: string;
  baseTaskId: string;
  previousCutoff: string;
  cutoff: string;
}): string {
  return `You are refreshing an existing Greplica code-memory graph for the next benchmark task checkout.

Use this exact skill as the workflow contract:

<greplica_layered_deep_bootstrap_skill>
${input.skill}
</greplica_layered_deep_bootstrap_skill>

Runtime facts:
- Current working directory is the base checkout for task ${input.taskId}.
- GREPLICA_HOME has already been materialized by applying previous task ${input.baseTaskId}'s proposal manifest into this checkout.
- Previous cutoff: ${input.previousCutoff}
- Current cutoff: ${input.cutoff}
- Use this greplica command exactly: ${input.greplicaCommand}
- Write layered refresh proposal JSON files under: ${input.proposalsDir}
- Write the proposal manifest exactly here: ${input.manifestPath}
- Repo snapshot manifest: ${input.repoSnapshotPath}
- Symbol manifest: ${input.symbolsPath}

Strict boundaries:
- Use only the current checkout, existing Greplica graph, and provided repo/symbol manifests.
- Do not read GitHub packets, task prompts, benchmark expected context, eval output, prior task-solving transcripts, git history, remote pages, or future records.
- This is not a fresh bootstrap. Build on existing graph IDs and supersede stale claims instead of duplicating the old memory layer.

Output requirements:
- Create focused proposal files named like 010-layered-<module>.proposal.json.
- Write ${input.manifestPath} with {"apply_order":[...]} listing only the layered proposal files you create.
- Every new code_verified claim must have repo-relative code_anchors, preferably one stable symbol.
- Proposal validation rejects claims with four or more code_anchors. Three anchors is the hard maximum and should be rare.
- Validate each proposal with the greplica command above.
- Apply each proposal in GREPLICA_HOME before moving to the next one so later proposals can reuse the graph.
- Stop after the manifest and proposals have been written and validated.`;
}

function cleanLayeredProposalFiles(proposalsDir: string): void {
  mkdirSync(proposalsDir, { recursive: true });
  for (const entry of readdirSync(proposalsDir)) {
    if (entry === "manifest.json" || entry.startsWith("010-layered-")) {
      rmSync(join(proposalsDir, entry), { force: true });
    }
  }
}

function requiredParentTaskDir(args: Map<string, string | true>, workbenchDir: string): string {
  const baseTaskDir = option(args, "--base-task-dir");
  if (baseTaskDir !== undefined) return baseTaskDir;
  const baseTask = option(args, "--base-task");
  if (baseTask === undefined) throw new Error("Usage: run-layered-deep-bootstrap-skill --task <task-id> --base-task <parent-task-id>");
  return taskDirFor({
    task_id: baseTask,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  }, workbenchDir);
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: run-layered-deep-bootstrap-skill --task-dir <dir> --base-task-dir <dir>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}
