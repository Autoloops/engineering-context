import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  readJson,
  run,
  runOrThrow,
  timestamp,
  valueAfter,
  writeJson,
} from "../../lib/common.js";
import {
  buildJudgeCases,
  judgeOutputSchema,
  scoreQuality,
  type QualityJudgeOutput,
  type QualityRubric,
  type QualityScore,
} from "../../lib/drift-quality-scoring.js";
import { runCodexAgent } from "../../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

// Quality marker for anchor-drift memory repair. Seeds claims across a difficulty
// ladder, applies one realistic patch that drifts about half of them in varied
// ways, runs the update-working-memory flow, and grades the agent's repair with
// partial credit on several analytic dimensions so the score spreads.

const caseId = "anchor-drift-quality";
const baseCommit = "ec947c7e4728c2e6ef84868cc9428d473e22326e";

interface Args {
  agentModel?: string;
  judge?: "openai";
  judgeModel?: string;
}

interface RunContext {
  repoRoot: string;
  fixtureDir: string;
  runDir: string;
  targetRepoDir: string;
  targetRepoUrl: string;
  greplicaHomeDir: string;
  codexHomeDir: string;
  seedProposalPath: string;
  sessionPatchPath: string;
  updateProposalPath: string;
  graphReadPath: string;
  rubricPath: string;
  greplicaCommand: string[];
}

interface EvalResult {
  case_id: string;
  target_repo_url: string;
  base_commit: string;
  run_dir: string;
  update_proposal_path: string;
  success: boolean;
  setup_commands: CommandResult[];
  patch_command?: CommandResult;
  generation?: AgentRunResult;
  update_commands: CommandResult[];
  graph_read_command?: CommandResult;
  judge?: {
    model: string;
    judge_input_path: string;
    judge_output_path: string;
    score: QualityScore;
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const context = prepareRun();
  copyFixtures(context);
  prepareTargetRepo(context);
  prepareGreplicaHome(context);

  const setupCommands = seedBootstrapMemory(context);
  const setupSucceeded = setupCommands.every((command) => command.exit_code === 0);
  const patchCommand = setupSucceeded ? applySessionPatch(context) : undefined;
  const patchSucceeded = patchCommand?.exit_code === 0;
  const generation = patchSucceeded ? await runUpdateAgent(context, args) : undefined;
  const proposalCreated = existsSync(context.updateProposalPath);
  const updateCommands = generation?.exit_code === 0 && proposalCreated ? applyUpdateProposal(context) : [];
  const graphReadCommand = updateCommands.every((command) => command.exit_code === 0) ? readFinalGraph(context) : undefined;

  const rubric = readJson<QualityRubric>(context.rubricPath);
  const proposal = proposalCreated ? readJson<unknown>(context.updateProposalPath) : undefined;
  const judge = graphReadCommand?.exit_code === 0 && proposal !== undefined && args.judge === "openai"
    ? await runOpenAiJudge(context, rubric, proposal, args)
    : undefined;

  const success =
    setupSucceeded &&
    patchSucceeded &&
    generation?.exit_code === 0 &&
    proposalCreated &&
    updateCommands.every((command) => command.exit_code === 0) &&
    graphReadCommand?.exit_code === 0 &&
    (judge === undefined || judge.score.passed);

  writeResult(context, setupCommands, patchCommand, generation, updateCommands, graphReadCommand, judge, success);
  printSummary(context, judge, success);
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const fixtureDir = resolve(repoRoot, "evals/cases/anchor-drift-quality");
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  mkdirSync(runDir, { recursive: true });

  return {
    repoRoot,
    fixtureDir,
    runDir,
    targetRepoDir: resolve(runDir, "target-repo"),
    targetRepoUrl: process.env.GREPLICA_EVAL_TARGET_REPO_URL ?? repoRoot,
    greplicaHomeDir: resolve(runDir, "greplica-home"),
    codexHomeDir: resolve(runDir, "codex-home"),
    seedProposalPath: resolve(runDir, "bootstrap-seed.proposal.json"),
    sessionPatchPath: resolve(runDir, "session.patch"),
    updateProposalPath: resolve(runDir, "update-proposal.json"),
    graphReadPath: resolve(runDir, "final-graph.txt"),
    rubricPath: resolve(fixtureDir, "rubric.json"),
    greplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

function copyFixtures(context: RunContext): void {
  copyFileSync(resolve(context.fixtureDir, "bootstrap-seed.proposal.json"), context.seedProposalPath);
  copyFileSync(resolve(context.fixtureDir, "session.patch"), context.sessionPatchPath);
}

function prepareTargetRepo(context: RunContext): void {
  runOrThrow(["git", "clone", context.targetRepoUrl, context.targetRepoDir], context.repoRoot);
  runOrThrow(["git", "checkout", baseCommit], context.targetRepoDir);
}

function prepareGreplicaHome(context: RunContext): void {
  mkdirSync(context.greplicaHomeDir, { recursive: true });
  mkdirSync(context.codexHomeDir, { recursive: true });
  seedCodexRuntimeHome(context.codexHomeDir);
}

function seedCodexRuntimeHome(codexHomeDir: string): void {
  const sourceHome = resolve(homedir(), ".codex");
  for (const file of ["auth.json", "config.toml", "models_cache.json", ".codex-global-state.json", "installation_id"]) {
    const source = resolve(sourceHome, file);
    if (existsSync(source)) copyFileSync(source, resolve(codexHomeDir, file));
  }
}

function seedBootstrapMemory(context: RunContext): CommandResult[] {
  return [
    runProductCommand(context, "install", "--platform", "codex", "--embedding", "local"),
    runProductCommand(context, "proposal", "validate", context.seedProposalPath),
    runProductCommand(context, "proposal", "apply", context.seedProposalPath),
  ];
}

function applySessionPatch(context: RunContext): CommandResult {
  return run(["git", "apply", context.sessionPatchPath], context.targetRepoDir, process.env);
}

async function runUpdateAgent(context: RunContext, args: Args): Promise<AgentRunResult> {
  const result = await runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, CODEX_HOME: context.codexHomeDir, GREPLICA_HOME: context.greplicaHomeDir },
    model: args.agentModel ?? "gpt-5.4-mini",
    prompt: codexUpdatePrompt(context),
    transcriptPath: resolve(context.runDir, "agent-events.jsonl"),
    finalMessagePath: resolve(context.runDir, "agent-final-message.txt"),
    proposalPath: context.updateProposalPath,
  });

  if (result.exit_code !== 0) throw new Error(`Codex agent failed with exit code ${String(result.exit_code)}.`);
  if (!existsSync(context.updateProposalPath)) throw new Error(`Codex agent did not create proposal at ${context.updateProposalPath}.`);
  return result;
}

function applyUpdateProposal(context: RunContext): CommandResult[] {
  return [
    runProductCommand(context, "proposal", "validate", context.updateProposalPath),
    runProductCommand(context, "proposal", "apply", context.updateProposalPath),
  ];
}

function readFinalGraph(context: RunContext): CommandResult {
  const command = runProductCommand(context, "graph", "read");
  writeFileSync(context.graphReadPath, command.stdout ?? "");
  return command;
}

function runProductCommand(context: RunContext, ...args: string[]): CommandResult {
  const env = { ...process.env, CODEX_HOME: context.codexHomeDir, GREPLICA_HOME: context.greplicaHomeDir };
  return run([...context.greplicaCommand, ...args], context.targetRepoDir, env);
}

async function runOpenAiJudge(
  context: RunContext,
  rubric: QualityRubric,
  proposal: unknown,
  args: Args,
): Promise<NonNullable<EvalResult["judge"]>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required when using --judge openai.");
  const model = args.judgeModel ?? process.env.OPENAI_MODEL;
  if (!model) throw new Error("Set OPENAI_MODEL or pass --judge-model when using --judge openai.");

  const seedClaims = readSeedClaimText(context.seedProposalPath);
  const judgeInput = {
    task: "Grade how well the agent repaired each drifted claim. Return JSON only; score every dimension in [0, 1]. Do not compute an overall score.",
    instructions: [
      "For each case, compare the agent_replacements to the expected_repair and the patch_summary.",
      "Score correctness: is the replacement factually right about the patched code? A confident but wrong value scores 0.",
      "Score completeness: did the replacement capture the whole change (e.g. both the model name and the dimension, or every added enum member)?",
      "Score preservation: did the replacement keep the parts of the original claim that are still true, and avoid deleting or corrupting them? For a claim where only one part drifted, changing the still-true parts is a preservation failure.",
      "For a rename case the text should stay the same; judge preservation on whether the fact was kept intact.",
      "For a removal case, correctness means the replacement acknowledges the symbol is gone and does not fabricate that it still exists.",
      "If agent_replacements is empty, all three scores are 0.",
      "Reason briefly before the scores. Do not reward verbosity or confident tone.",
    ],
    patch_summary: rubric.patch_summary,
    cases: buildJudgeCases(rubric, seedClaims, proposal),
  };

  const judgeInputPath = resolve(context.runDir, "judge-input.json");
  const judgeOutputPath = resolve(context.runDir, "judge-output.json");
  writeJson(judgeInputPath, judgeInput);

  const judgeOutput = await requestJudge(apiKey, model, judgeInput);
  writeJson(judgeOutputPath, judgeOutput);

  return {
    model,
    judge_input_path: judgeInputPath,
    judge_output_path: judgeOutputPath,
    score: scoreQuality(rubric, proposal, judgeOutput),
  };
}

function readSeedClaimText(seedProposalPath: string): Map<string, string> {
  const seed = readJson<{ creates?: { claims?: Array<{ id?: unknown; text?: unknown }> } }>(seedProposalPath);
  const map = new Map<string, string>();
  for (const claim of seed.creates?.claims ?? []) {
    if (typeof claim.id === "string" && typeof claim.text === "string") map.set(claim.id, claim.text);
  }
  return map;
}

function writeResult(
  context: RunContext,
  setupCommands: CommandResult[],
  patchCommand: CommandResult | undefined,
  generation: AgentRunResult | undefined,
  updateCommands: CommandResult[],
  graphReadCommand: CommandResult | undefined,
  judge: EvalResult["judge"],
  success: boolean,
): void {
  const result: EvalResult = {
    case_id: caseId,
    target_repo_url: context.targetRepoUrl,
    base_commit: baseCommit,
    run_dir: context.runDir,
    update_proposal_path: context.updateProposalPath,
    success,
    setup_commands: setupCommands,
    patch_command: patchCommand,
    generation,
    update_commands: updateCommands,
    graph_read_command: graphReadCommand,
    judge,
  };
  writeJson(resolve(context.runDir, "result.json"), result);
}

function printSummary(context: RunContext, judge: EvalResult["judge"], success: boolean): void {
  console.log(success ? "Anchor drift quality run passed." : "Anchor drift quality run failed.");
  console.log(`Run directory: ${context.runDir}`);
  if (judge) {
    console.log(`Quality score: ${judge.score.final_score.toFixed(2)} / 100 (pass >= ${judge.score.pass_threshold})`);
    console.log(`By category: ${JSON.stringify(judge.score.by_category)}`);
    console.log(`By difficulty: ${JSON.stringify(judge.score.by_difficulty)}`);
  }
}

function parseArgs(args: string[]): Args {
  const judge = valueAfter(args, "--judge");
  if (judge !== undefined && judge !== "openai") throw new Error("Only --judge openai is supported.");
  return { agentModel: valueAfter(args, "--agent-model"), judge, judgeModel: valueAfter(args, "--judge-model") };
}

function codexUpdatePrompt(context: RunContext): string {
  const skill = readFileSync(resolve(context.repoRoot, "skills/greplica-update-working-memory/SKILL.md"), "utf8");
  const greplica = context.greplicaCommand.join(" ");

  return `You are running a Greplica update-working-memory pass after a coding change.

Use this exact user-facing skill as the workflow contract:

<greplica_update_working_memory_skill>
${skill}
</greplica_update_working_memory_skill>

Runtime facts for this eval:
- Current working directory is the target repository root.
- GREPLICA_HOME is already set to an isolated eval directory.
- Greplica memory has already been seeded with baseline claims about this repo.
- A code change has already been applied to this working tree as uncommitted changes.
- Use this greplica command exactly: ${greplica}
- Write the final update proposal JSON exactly here: ${context.updateProposalPath}

Task:
1. Run the update-working-memory skill workflow for the uncommitted changes.
2. Inspect the change with git status, git diff, and file reads.
3. Query existing memory with greplica graph context and greplica graph audit anchors to find claims about the changed code.
4. For any existing claim whose code changed so that it is now inaccurate, create a superseding claim with corrected text and correct code anchors. If a claim's anchored symbol was renamed, re-anchor the superseding claim to the new symbol. If the anchored code was removed, retire the claim rather than inventing a replacement fact.
5. Leave claims whose code did not change unchanged; do not supersede still-accurate memory.
6. Create the update proposal JSON at ${context.updateProposalPath}.
7. Validate it with: ${greplica} proposal validate ${context.updateProposalPath}
8. Fix validation errors until valid. Do not apply the proposal; the eval runner applies it after you exit.`;
}

async function requestJudge(apiKey: string, model: string, input: unknown): Promise<QualityJudgeOutput> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are an evaluator for Greplica anchor-drift memory repair. Return JSON only. Score each case's dimensions in [0, 1] by comparing the agent's replacement claims to the expected repair. Do not compute an overall score.",
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: { format: { type: "json_schema", name: "anchor_drift_quality_judge", strict: true, schema: judgeOutputSchema() } },
    }),
  });

  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`OpenAI judge request failed: ${JSON.stringify(body)}`);
  return JSON.parse(extractOutputText(body)) as QualityJudgeOutput;
}

function extractOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const output = body.output;
  if (!Array.isArray(output)) throw new Error("OpenAI response did not include output text.");
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") texts.push(content.text);
    }
  }
  const text = texts.join("");
  if (text.length === 0) throw new Error("OpenAI response output text was empty.");
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
