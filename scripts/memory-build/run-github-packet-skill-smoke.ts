import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCodexAgent } from "../../libs/agent-runner/codex.js";
import {
  greplicaCommand as defaultGreplicaCommand,
  installGreplica,
  seedCodexRuntimeHome,
  validateAndApplyManifest,
} from "./agent-utils.js";
import {
  defaultWorkbenchDir,
  option,
  parseArgs,
  readJson,
  readTask,
  excludedGithubNumbers,
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
  const packetArg = option(args, "--packet") ?? defaultPacketFromManifest(taskDir);
  const originalPacketPath = resolve(taskDir, packetArg);
  if (!existsSync(originalPacketPath)) throw new Error(`Packet does not exist: ${originalPacketPath}`);

  const repoManifest = readJson<{ checkout_dir: string }>(join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit, "manifest.json"));
  const checkoutDir = repoManifest.checkout_dir;
  const smokeDir = join(taskDir, "runtime", "github-packet-skill-smoke");
  const codexHome = join(smokeDir, "codex-home");
  const greplicaHome = join(smokeDir, "greplica-home");
  const proposalPath = join(smokeDir, "packet-ingest.proposal.json");
  const smokePacketPath = join(smokeDir, "input-packet.json");
  const transcriptPath = join(smokeDir, "agent-events.jsonl");
  const finalMessagePath = join(smokeDir, "agent-final-message.txt");
  const reportPath = join(smokeDir, "report.json");
  const greplicaCommand = defaultGreplicaCommand();

  rmSync(smokeDir, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(greplicaHome, { recursive: true });
  seedCodexRuntimeHome(codexHome);
  writeSmokePacket({
    sourcePacketPath: originalPacketPath,
    destinationPacketPath: smokePacketPath,
    recordNumbers: parseRecordNumbers(option(args, "--record-numbers")),
    maxRecords: parsePositiveInt(option(args, "--max-smoke-records"), 3),
  });

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    GREPLICA_HOME: greplicaHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const setup = [
    installGreplica(greplicaCommand, checkoutDir, env),
    ...validateAndApplyManifest({ taskDir, checkoutDir, env, greplicaCommand }),
  ];

  const result = await runCodexAgent({
    cwd: checkoutDir,
    env,
    model: option(args, "--agent-model") ?? "gpt-5.4",
    prompt: smokePrompt({
      skill: readFileSync(join(repoRoot, "scripts", "memory-build", "prompts", "github-packet-ingest.md"), "utf8"),
      greplicaCommand: greplicaCommand.join(" "),
      packetPath: smokePacketPath,
      proposalPath,
      targetPrNumber: task.target_pr_number,
      excludedNumbers: [...excludedGithubNumbers(task)].sort((left, right) => left - right),
    }),
    transcriptPath,
    finalMessagePath,
  });
  if (result.exit_code !== 0) throw new Error(`Codex smoke agent failed with exit code ${String(result.exit_code)}.`);
  if (!existsSync(proposalPath)) throw new Error(`Codex smoke agent did not create proposal: ${proposalPath}`);

  const validate = run([...greplicaCommand, "proposal", "validate", proposalPath], checkoutDir, env);
  const apply = run([...greplicaCommand, "proposal", "apply", proposalPath], checkoutDir, env);
  const audit = run([...greplicaCommand, "graph", "audit", "anchors"], checkoutDir, env);
  const probe = run([...greplicaCommand, "graph", "context", "pull request checkout assumes wrong git remote"], checkoutDir, env);
  const proposal = readJson<{ creates?: { claims?: unknown[]; sources?: unknown[]; edges?: unknown[] } }>(proposalPath);
  const report = {
    task_id: task.task_id,
    source_packet: originalPacketPath,
    packet: smokePacketPath,
    proposal: proposalPath,
    setup_stdout: setup,
    generation: result,
    validate_stdout: validate,
    apply_stdout: apply,
    audit_stdout: audit,
    probe_stdout_path: join(smokeDir, "probe.md"),
    counts: {
      claims: proposal.creates?.claims?.length ?? 0,
      sources: proposal.creates?.sources?.length ?? 0,
      edges: proposal.creates?.edges?.length ?? 0,
    },
    generated_at: new Date().toISOString(),
  };
  writeFileSync(report.probe_stdout_path, probe, "utf8");
  writeJson(reportPath, report);
  console.log(`GitHub packet skill smoke wrote: ${reportPath}`);
  console.log(`Claims: ${report.counts.claims}`);
  console.log(`Sources: ${report.counts.sources}`);
  console.log(`Edges: ${report.counts.edges}`);
}

function writeSmokePacket(input: {
  sourcePacketPath: string;
  destinationPacketPath: string;
  recordNumbers: Set<number> | undefined;
  maxRecords: number;
}): void {
  const packet = readJson<{ records?: Array<{ number?: number }> } & Record<string, unknown>>(input.sourcePacketPath);
  const records = packet.records ?? [];
  const selected = input.recordNumbers === undefined
    ? records.slice(0, input.maxRecords)
    : records.filter((record) => record.number !== undefined && input.recordNumbers?.has(record.number)).slice(0, input.maxRecords);
  const smokeRecords = selected.length > 0 ? selected : records.slice(0, input.maxRecords);
  writeJson(input.destinationPacketPath, {
    ...packet,
    packet_id: `${String(packet.packet_id ?? "github-packet")}-smoke`,
    source_packet: input.sourcePacketPath,
    smoke_record_numbers: smokeRecords.map((record) => record.number).filter((value) => value !== undefined),
    records: smokeRecords,
  });
}

function smokePrompt(input: {
  skill: string;
  greplicaCommand: string;
  packetPath: string;
  proposalPath: string;
  targetPrNumber?: number;
  excludedNumbers: number[];
}): string {
  return `You are smoke-testing the Greplica GitHub packet ingest skill on a base-checkout benchmark memory package.

Use this exact skill as the workflow contract:

<greplica_github_packet_ingest_skill>
${input.skill}
</greplica_github_packet_ingest_skill>

Runtime facts:
- Current working directory is the base checkout for the target repository.
- GREPLICA_HOME is already set to an isolated smoke directory.
- Bootstrap memory has already been applied.
- Use this greplica command exactly: ${input.greplicaCommand}
- Read exactly this packet file: ${input.packetPath}
- Write the proposal JSON exactly here: ${input.proposalPath}
- Target PR ${input.targetPrNumber ?? "<none>"} must not be ingested.
- Excluded GitHub numbers: ${input.excludedNumbers.length === 0 ? "<none>" : input.excludedNumbers.join(", ")}. These include target PRs/issues and linked issues that would leak the benchmark task.

Smoke task:
1. Follow the packet ingest skill on the packet file.
2. Do not create sources, claims, or edges derived from excluded GitHub numbers, even if the packet contains that record or mentions it.
3. Keep this smoke compact by using only the records included in the smoke packet. Do not impose a fixed claim-count cap.
4. Use titles only for routing. Do not create title-only claims or generic "issue/PR existed" claims.
5. Verify any code-backed fact against the current checkout and use symbol anchors.
6. Proposal validation rejects claims with four or more code_anchors. Three anchors is the hard maximum and should be rare; split broad claims into narrower claims instead.
7. Use explicit evidenced_by edges with metadata.reason for source-backed claims.
8. Validate the proposal with: ${input.greplicaCommand} proposal validate ${input.proposalPath}
9. Stop after validation. Do not apply the proposal.`;
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: run-github-packet-skill-smoke --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

function defaultPacketFromManifest(taskDir: string): string {
  const manifest = readJson<{ packets?: string[] }>(join(taskDir, "evidence", "github-packets", "manifest.json"));
  const first = manifest.packets?.[0];
  if (first === undefined) throw new Error(`GitHub packet manifest has no packets for task: ${taskDir}`);
  return first;
}

function parseRecordNumbers(value: string | undefined): Set<number> | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new Error("--record-numbers must be a comma-separated list of positive integers.");
  }
  return new Set(numbers);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer option.");
  return parsed;
}
