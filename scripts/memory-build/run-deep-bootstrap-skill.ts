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
  const task = readTask(taskDir);
  const repoManifest = readJson<{ checkout_dir: string }>(join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit, "manifest.json"));
  const checkoutDir = repoManifest.checkout_dir;
  ensureBenchmarkRepoIdentity(checkoutDir, task);
  const runDir = join(taskDir, "runtime", "deep-bootstrap-skill");
  const codexHome = join(runDir, "codex-home");
  const greplicaHome = join(runDir, "greplica-home");
  const transcriptPath = join(runDir, "agent-events.jsonl");
  const finalMessagePath = join(runDir, "agent-final-message.txt");
  const reportPath = join(runDir, "report.json");
  const command = greplicaCommand();

  cleanProposalDir(join(taskDir, "proposals"));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(greplicaHome, { recursive: true });
  seedCodexRuntimeHome(codexHome);

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    GREPLICA_HOME: greplicaHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const setup = installGreplica(command, checkoutDir, env);
  const result = await runCodexAgent({
    cwd: checkoutDir,
    env,
    model: option(args, "--agent-model") ?? "gpt-5.4",
    prompt: deepBootstrapPrompt({
      skill: readFileSync(join(repoRoot, "scripts", "memory-build", "prompts", "deep-bootstrap.md"), "utf8"),
      greplicaCommand: command.join(" "),
      proposalsDir: join(taskDir, "proposals"),
      manifestPath: join(taskDir, "proposals", "manifest.json"),
      repoSnapshotPath: join(taskDir, "evidence", "repo-snapshot.manifest.json"),
      symbolsPath: join(taskDir, "evidence", "symbols.manifest.json"),
      taskId: task.task_id,
    }),
    transcriptPath,
    finalMessagePath,
  });
  if (result.exit_code !== 0) throw new Error(`Deep bootstrap agent failed with exit code ${String(result.exit_code)}.`);

  const manifestPath = join(taskDir, "proposals", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Deep bootstrap did not write manifest: ${manifestPath}`);
  const manifest = readJson<{ apply_order?: string[] }>(manifestPath);
  const applyOrder = manifest.apply_order ?? [];
  if (applyOrder.length === 0) throw new Error(`Deep bootstrap manifest has no proposals: ${manifestPath}`);
  for (const file of applyOrder) {
    const proposalPath = join(taskDir, "proposals", file);
    if (!existsSync(proposalPath)) throw new Error(`Deep bootstrap manifest references missing proposal: ${proposalPath}`);
  }

  const validationHome = join(runDir, "validation-greplica-home");
  mkdirSync(validationHome, { recursive: true });
  const validationEnv = {
    ...process.env,
    GREPLICA_HOME: validationHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const validationSetup = installGreplica(command, checkoutDir, validationEnv);
  const validation = validateAndApplyManifest({
    taskDir,
    checkoutDir,
    env: validationEnv,
    greplicaCommand: command,
  });
  const audit = run([...command, "graph", "audit", "anchors"], checkoutDir, validationEnv);
  const probe = run([...command, "graph", "context", "repository architecture public API parser error handling command behavior tests"], checkoutDir, validationEnv);
  writeFileSync(join(runDir, "probe.md"), probe, "utf8");
  writeJson(reportPath, {
    task_id: task.task_id,
    checkout_dir: checkoutDir,
    setup_stdout: setup,
    generation: result,
    validation_setup_stdout: validationSetup,
    validation_stdout: validation,
    audit_stdout: audit,
    proposal_files: applyOrder,
    probe_stdout_path: join(runDir, "probe.md"),
    generated_at: new Date().toISOString(),
  });
  checksumManifest(taskDir);
  console.log(`Deep bootstrap wrote manifest: ${relative(repoRoot, manifestPath)}`);
  console.log(`Proposal files: ${applyOrder.length}`);
  console.log(`Report: ${relative(repoRoot, reportPath)}`);
}

function deepBootstrapPrompt(input: {
  skill: string;
  greplicaCommand: string;
  proposalsDir: string;
  manifestPath: string;
  repoSnapshotPath: string;
  symbolsPath: string;
  taskId: string;
}): string {
  return `You are creating the first deep code-memory layer for a benchmark task repository checkout.

Use this exact skill as the workflow contract:

<greplica_deep_bootstrap_skill>
${input.skill}
</greplica_deep_bootstrap_skill>

Runtime facts:
- Current working directory is the base checkout for task ${input.taskId}.
- GREPLICA_HOME is already set to an isolated deep-bootstrap directory.
- Use this greplica command exactly: ${input.greplicaCommand}
- Write proposal JSON files under: ${input.proposalsDir}
- Write the proposal manifest exactly here: ${input.manifestPath}
- Repo snapshot manifest: ${input.repoSnapshotPath}
- Symbol manifest: ${input.symbolsPath}

Strict boundaries:
- Use only the current checkout and provided repo/symbol manifests.
- Do not read GitHub packets, task prompts, benchmark expected context, eval output, git history, remote pages, or prior task transcripts.
- This replaces the shallow deterministic bootstrap layer for this task. The manifest should list only the deep-bootstrap proposal files you create.

Output requirements:
- Create 3-6 focused proposal files. Good groups are public API or command surface, parser/validation internals, error/report rendering, configuration/build integration, data/model types, extension/plugin surfaces, and tests only if they clarify behavior.
- Every code_verified claim must have a repo-relative code_anchors array, preferably one stable symbol.
- Proposal validation rejects claims with four or more code_anchors. Three anchors is the hard maximum and should be rare; split broad claims into narrower claims instead.
- Keep claims compact and navigational. Do not create one claim per helper.
- Validate each proposal with the greplica command above.
- Apply each proposal in GREPLICA_HOME before moving to the next one so later proposals can reuse the graph.
- After all proposals, write ${input.manifestPath} with {"apply_order":[...]} in the same order you applied them.
- Stop after the manifest and proposals have been written and validated.`;
}

function cleanProposalDir(proposalsDir: string): void {
  mkdirSync(proposalsDir, { recursive: true });
  for (const entry of readdirSync(proposalsDir)) {
    if (entry === "manifest.json" || entry.endsWith(".proposal.json") || entry.endsWith(".json")) {
      rmSync(join(proposalsDir, entry), { force: true });
    }
  }
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: run-deep-bootstrap-skill --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}
