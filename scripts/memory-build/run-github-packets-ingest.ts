import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  copyRequiredDir,
  defaultWorkbenchDir,
  ensureBenchmarkRepoIdentity,
  excludedGithubNumbers,
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

interface PacketManifest {
  packets: string[];
}

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
  const packetManifest = readJson<PacketManifest>(join(taskDir, "evidence", "github-packets", "manifest.json"));
  const packets = selectPackets(packetManifest.packets, {
    packet: option(args, "--packet"),
    start: parsePositiveInt(option(args, "--start-packet"), 1),
    max: parseOptionalPositiveInt(option(args, "--max-packets")),
  });
  if (packets.length === 0) throw new Error("No GitHub packets selected.");

  const runDir = join(taskDir, "runtime", "github-packet-ingest");
  const codexHome = join(runDir, "codex-home");
  const greplicaHome = join(runDir, "greplica-home");
  const reportPath = join(runDir, "report.json");
  const command = greplicaCommand();

  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  seedCodexRuntimeHome(codexHome);
  const seedRuntimeHome = join(taskDir, "runtime", "greplica-home");
  const seededFromRuntime = existsSync(join(seedRuntimeHome, "graph.db"));
  if (seededFromRuntime) {
    copyRequiredDir(seedRuntimeHome, greplicaHome);
  } else {
    mkdirSync(greplicaHome, { recursive: true });
  }

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    GREPLICA_HOME: greplicaHome,
    GIT_CEILING_DIRECTORIES: dirname(checkoutDir),
  };
  const setup = [
    installGreplica(command, checkoutDir, env),
    ...(seededFromRuntime ? [] : validateAndApplyManifest({ taskDir, checkoutDir, env, greplicaCommand: command })),
  ];
  const appliedPacketProposals: string[] = [];
  const runs = [];
  const skill = readFileSync(join(repoRoot, "scripts", "memory-build", "prompts", "github-packet-ingest.md"), "utf8");
  const model = option(args, "--agent-model") ?? "gpt-5.4";

  for (const selected of packets) {
    const packetPath = resolve(taskDir, selected);
    if (!existsSync(packetPath)) throw new Error(`Packet does not exist: ${packetPath}`);
    const packetId = packetFileId(packetPath);
    const proposalFile = `020-github-${packetId}.proposal.json`;
    const proposalPath = join(taskDir, "proposals", proposalFile);
    const packetRunDir = join(runDir, packetId);
    mkdirSync(packetRunDir, { recursive: true });
    const transcriptPath = join(packetRunDir, "agent-events.jsonl");
    const finalMessagePath = join(packetRunDir, "agent-final-message.txt");

    const result = await runCodexAgent({
      cwd: checkoutDir,
      env,
      model,
      prompt: packetIngestPrompt({
        skill,
        greplicaCommand: command.join(" "),
        packetPath,
        proposalPath,
        excludedNumbers: [...excludedGithubNumbers(task)].sort((left, right) => left - right),
      }),
      transcriptPath,
      finalMessagePath,
    });
    if (result.exit_code !== 0) throw new Error(`Packet ingest agent failed for ${selected} with exit code ${String(result.exit_code)}.`);
    if (!existsSync(proposalPath)) throw new Error(`Packet ingest did not write proposal: ${proposalPath}`);

    const validate = run([...command, "proposal", "validate", proposalPath], checkoutDir, env);
    const apply = run([...command, "proposal", "apply", proposalPath], checkoutDir, env);
    appliedPacketProposals.push(proposalFile);
    appendToManifest(taskDir, proposalFile);
    runs.push({
      packet: selected,
      proposal: relative(taskDir, proposalPath),
      generation: result,
      validate_stdout: validate,
      apply_stdout: apply,
    });
    console.log(`Ingested ${selected} -> ${proposalFile}`);
  }

  const audit = run([...command, "graph", "audit", "anchors"], checkoutDir, env);
  const probe = run([...command, "graph", "context", "repository behavior public API parser errors compatibility tests"], checkoutDir, env);
  writeFileSync(join(runDir, "probe.md"), probe, "utf8");
  writeJson(reportPath, {
    task_id: task.task_id,
    seeded_from_runtime: seededFromRuntime,
    seed_runtime_home: seededFromRuntime ? seedRuntimeHome : undefined,
    setup_stdout: setup,
    packets,
    packet_proposals: appliedPacketProposals,
    runs,
    audit_stdout: audit,
    probe_stdout_path: join(runDir, "probe.md"),
    generated_at: new Date().toISOString(),
  });
  checksumManifest(taskDir);
  console.log(`GitHub packet ingest report: ${relative(repoRoot, reportPath)}`);
  console.log(`Packet proposals: ${appliedPacketProposals.length}`);
}

function packetIngestPrompt(input: {
  skill: string;
  greplicaCommand: string;
  packetPath: string;
  proposalPath: string;
  excludedNumbers: number[];
}): string {
  return `You are ingesting one pre-cutoff GitHub packet into Greplica memory.

Use this exact skill as the workflow contract:

<greplica_github_packet_ingest_skill>
${input.skill}
</greplica_github_packet_ingest_skill>

Runtime facts:
- Current working directory is the base checkout for the target repository.
- GREPLICA_HOME already contains the deep code bootstrap layer plus any earlier packet proposals from this run.
- Use this greplica command exactly: ${input.greplicaCommand}
- Read exactly this packet file: ${input.packetPath}
- Write the proposal JSON exactly here: ${input.proposalPath}
- Excluded GitHub numbers: ${input.excludedNumbers.length === 0 ? "<none>" : input.excludedNumbers.join(", ")}. These include target PRs/issues and linked issues that would leak the benchmark task.

Packet task:
1. Follow the packet ingest skill on the packet file.
2. Process this packet only. Do not read any other packet file.
3. Do not create sources, claims, or edges derived from any excluded GitHub number, even if the packet contains that record or mentions it.
4. Keep the high-signal durable claims that this packet warrants. There is no fixed claim-count cap; create zero claims if the packet has no durable memory, and do not drop useful claims solely to hit a count.
5. Use titles only for routing. Do not create title-only claims or generic "issue/PR existed" claims.
6. Verify any code-backed fact against the current checkout and use symbol anchors.
7. Proposal validation rejects claims with four or more code_anchors. Three anchors is the hard maximum and should be rare; split broad claims into narrower claims instead.
8. For every claim derived from a packet record, create an explicit evidenced_by edge to the GitHub source with metadata.reason. If the claim is code_verified, the source edge is provenance and the code anchor is the truth grounding.
9. Validate the proposal with: ${input.greplicaCommand} proposal validate ${input.proposalPath}
10. Stop after validation. Do not apply the proposal.`;
}

function selectPackets(packets: string[], input: { packet?: string; start: number; max?: number }): string[] {
  if (input.packet !== undefined) return [input.packet];
  const startIndex = Math.max(input.start - 1, 0);
  const selected = packets.slice(startIndex);
  return input.max === undefined ? selected : selected.slice(0, input.max);
}

function packetFileId(packetPath: string): string {
  return packetPath.split("/").at(-1)?.replace(/\.json$/, "") ?? "packet";
}

function appendToManifest(taskDir: string, proposalFile: string): void {
  const manifestPath = join(taskDir, "proposals", "manifest.json");
  const manifest = readJson<{ apply_order?: string[] }>(manifestPath);
  const applyOrder = manifest.apply_order ?? [];
  if (!applyOrder.includes(proposalFile)) applyOrder.push(proposalFile);
  writeJson(manifestPath, { ...manifest, apply_order: applyOrder });
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: run-github-packets-ingest --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer option.");
  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parsePositiveInt(value, 1);
}
