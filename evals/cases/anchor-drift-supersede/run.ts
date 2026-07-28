import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  readJson,
  round,
  run,
  runOrThrow,
  timestamp,
  valueAfter,
  writeJson,
} from "../../lib/common.js";
import { runCodexAgent } from "../../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

// This eval measures how well the agent repairs drifted memory. We seed
// code_verified claims, apply a patch that changes the code behind some of
// them, then run the update-working-memory flow and score whether the agent
// superseded the now-stale claims (with an accurate replacement) while leaving
// the still-fresh claims untouched.

const caseId = "anchor-drift-supersede";
const baseCommit = "cd363e28ca71bf265f654a7b22cf2cfa5282b520";

interface Args {
  agent?: "codex";
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

interface StaleClaim {
  id: string;
  patched_fact: string;
}

interface Correction {
  stale_claim_id: string;
  expected_correction: string;
}

interface Rubric {
  case_id: string;
  base_commit: string;
  score: {
    pass_threshold: number;
    supersede_recall_points: number;
    correction_quality_points: number;
    leave_fresh_points: number;
    false_supersede_penalty: number;
  };
  stale_claims: StaleClaim[];
  fresh_claims: string[];
  judge: {
    instructions: string[];
    patch_summary: string;
    corrections: Correction[];
  };
}

interface JudgeInput {
  task: string;
  instructions: string[];
  patch_summary: string;
  session_patch: string;
  stale_claims: StaleClaim[];
  corrections: Correction[];
  candidate_update: { proposal: unknown };
}

interface JudgeCorrection {
  stale_claim_id: string;
  correction_present: boolean;
  correction_correct: boolean;
  matched_claim_ids: string[];
  reason: string;
}

interface JudgeOutput {
  corrections: JudgeCorrection[];
}

interface ScoreResult {
  supersede_recall_score: number;
  correction_quality_score: number;
  leave_fresh_score: number;
  false_supersede_penalty: number;
  final_score: number;
  pass_threshold: number;
  passed: boolean;
  superseded_stale_ids: string[];
  superseded_fresh_ids: string[];
}

interface EvalResult {
  case_id: string;
  target_repo_url: string;
  base_commit: string;
  run_dir: string;
  target_repo_dir: string;
  greplica_home_dir: string;
  seed_proposal_path: string;
  session_patch_path: string;
  update_proposal_path: string;
  graph_read_path: string;
  success: boolean;
  setup_commands: CommandResult[];
  patch_command?: CommandResult;
  generation?: AgentRunResult;
  update_commands: CommandResult[];
  graph_read_command?: CommandResult;
  structural_score?: StructuralScore;
  judge?: {
    model: string;
    judge_input_path: string;
    judge_output_path: string;
    score: ScoreResult;
  };
}

interface StructuralScore {
  superseded_stale_ids: string[];
  superseded_fresh_ids: string[];
}

interface ProposalClaim {
  id: string;
  supersedes?: unknown;
}

interface ProposalEdge {
  kind?: unknown;
  from?: unknown;
  from_id?: unknown;
  to?: unknown;
  to_id?: unknown;
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
  const graphReadCommand = updateCommands.every((command) => command.exit_code === 0)
    ? readFinalGraph(context)
    : undefined;

  const rubric = readJson<Rubric>(context.rubricPath);
  const proposal = proposalCreated ? readJson<unknown>(context.updateProposalPath) : undefined;
  const structuralScore = proposal !== undefined ? classifySupersedes(rubric, proposal) : undefined;
  const judge = graphReadCommand?.exit_code === 0 && proposal !== undefined && args.judge === "openai"
    ? await runOpenAiJudge(context, rubric, proposal, structuralScore, args)
    : undefined;

  // Deterministic gate, so a run without --judge still fails a structurally wrong
  // proposal: every stale claim must be superseded and no fresh claim churned.
  const structurallyPassed =
    structuralScore !== undefined &&
    structuralScore.superseded_stale_ids.length === rubric.stale_claims.length &&
    structuralScore.superseded_fresh_ids.length === 0;

  const success =
    setupSucceeded &&
    patchSucceeded &&
    generation?.exit_code === 0 &&
    proposalCreated &&
    updateCommands.every((command) => command.exit_code === 0) &&
    graphReadCommand?.exit_code === 0 &&
    structurallyPassed &&
    (judge === undefined || judge.score.passed);

  writeResult(context, setupCommands, patchCommand, generation, updateCommands, graphReadCommand, structuralScore, judge, success);

  console.log(success ? "Anchor drift supersede run passed." : "Anchor drift supersede run failed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Update proposal: ${context.updateProposalPath}`);
  if (structuralScore) {
    console.log(`Superseded stale claims: ${structuralScore.superseded_stale_ids.join(", ") || "none"}`);
    console.log(`Wrongly superseded fresh claims: ${structuralScore.superseded_fresh_ids.join(", ") || "none"}`);
  }
  if (judge) {
    console.log(`Score: ${judge.score.final_score.toFixed(2)} / 100`);
  }
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const fixtureDir = resolve(repoRoot, "evals/cases/anchor-drift-supersede");
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  const targetRepoDir = resolve(runDir, "target-repo");
  const targetRepoUrl = process.env.GREPLICA_EVAL_TARGET_REPO_URL ?? repoRoot;
  const greplicaHomeDir = resolve(runDir, "greplica-home");
  const codexHomeDir = resolve(runDir, "codex-home");

  mkdirSync(runDir, { recursive: true });

  return {
    repoRoot,
    fixtureDir,
    runDir,
    targetRepoDir,
    targetRepoUrl,
    greplicaHomeDir,
    codexHomeDir,
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

// Seed the baseline memory the agent will later have to repair.
function seedBootstrapMemory(context: RunContext): CommandResult[] {
  return [
    runProductCommand(context, "install", "--platform", "codex", "--embedding", "local"),
    runProductCommand(context, "proposal", "validate", context.seedProposalPath),
    runProductCommand(context, "proposal", "apply", context.seedProposalPath),
  ];
}

// Apply the code change that makes the two config claims go stale.
function applySessionPatch(context: RunContext): CommandResult {
  return run(["git", "apply", context.sessionPatchPath], context.targetRepoDir, process.env);
}

async function runUpdateAgent(context: RunContext, args: Args): Promise<AgentRunResult> {
  const model = args.agentModel ?? "gpt-5.4-mini";
  const result = await runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, CODEX_HOME: context.codexHomeDir, GREPLICA_HOME: context.greplicaHomeDir },
    model,
    prompt: codexUpdatePrompt(context),
    transcriptPath: resolve(context.runDir, "agent-events.jsonl"),
    finalMessagePath: resolve(context.runDir, "agent-final-message.txt"),
    proposalPath: context.updateProposalPath,
  });

  if (result.exit_code !== 0) {
    throw new Error(`Codex agent failed with exit code ${String(result.exit_code)}.`);
  }
  if (!existsSync(context.updateProposalPath)) {
    throw new Error(`Codex agent did not create proposal at ${context.updateProposalPath}.`);
  }

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
  const env = {
    ...process.env,
    CODEX_HOME: context.codexHomeDir,
    GREPLICA_HOME: context.greplicaHomeDir,
  };
  return run([...context.greplicaCommand, ...args], context.targetRepoDir, env);
}

// Structurally check which seed claims the candidate proposal supersedes. This
// is deterministic and needs no judge: supersede recall (stale claims fixed)
// and the false-positive side (fresh claims wrongly churned) both come from here.
function classifySupersedes(rubric: Rubric, proposal: unknown): StructuralScore {
  const staleIds = rubric.stale_claims.map((claim) => claim.id);
  return {
    superseded_stale_ids: staleIds.filter((id) => hasSupersedes(proposal, id)),
    superseded_fresh_ids: rubric.fresh_claims.filter((id) => hasSupersedes(proposal, id)),
  };
}

async function runOpenAiJudge(
  context: RunContext,
  rubric: Rubric,
  proposal: unknown,
  structuralScore: StructuralScore | undefined,
  args: Args,
): Promise<NonNullable<EvalResult["judge"]>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required when using --judge openai.");

  const model = args.judgeModel ?? process.env.OPENAI_MODEL;
  if (!model) throw new Error("Set OPENAI_MODEL or pass --judge-model when using --judge openai.");

  const judgeInput = buildJudgeInput(context, rubric, proposal);
  const judgeInputPath = resolve(context.runDir, "judge-input.json");
  const judgeOutputPath = resolve(context.runDir, "judge-output.json");
  writeJson(judgeInputPath, judgeInput);

  const judgeOutput = await requestJudge(apiKey, model, judgeInput);
  writeJson(judgeOutputPath, judgeOutput);

  return {
    model,
    judge_input_path: judgeInputPath,
    judge_output_path: judgeOutputPath,
    score: scoreJudgeOutput(rubric, judgeOutput, structuralScore ?? classifySupersedes(rubric, proposal)),
  };
}

function buildJudgeInput(context: RunContext, rubric: Rubric, proposal: unknown): JudgeInput {
  return {
    task: "Classify whether the candidate update proposal correctly re-verifies each stale claim. Return JSON only; do not compute numeric scores.",
    instructions: rubric.judge.instructions,
    patch_summary: rubric.judge.patch_summary,
    session_patch: readFileSync(context.sessionPatchPath, "utf8"),
    stale_claims: rubric.stale_claims,
    corrections: rubric.judge.corrections,
    candidate_update: { proposal },
  };
}

// final_score = supersede recall + correction quality + leaving fresh claims
// alone, minus a penalty for each fresh claim the agent wrongly superseded.
function scoreJudgeOutput(rubric: Rubric, judge: JudgeOutput, structural: StructuralScore): ScoreResult {
  const staleCount = rubric.stale_claims.length;
  const freshCount = rubric.fresh_claims.length;
  const correctionById = new Map(judge.corrections.map((correction) => [correction.stale_claim_id, correction]));

  const supersedeRecall = staleCount === 0 ? 1 : structural.superseded_stale_ids.length / staleCount;
  const correctionQuality = staleCount === 0
    ? 1
    : rubric.stale_claims.filter((claim) => {
        const correction = correctionById.get(claim.id);
        return correction?.correction_present === true && correction?.correction_correct === true;
      }).length / staleCount;
  const leaveFresh = freshCount === 0
    ? 1
    : (freshCount - structural.superseded_fresh_ids.length) / freshCount;

  const supersedeRecallScore = supersedeRecall * rubric.score.supersede_recall_points;
  const correctionQualityScore = correctionQuality * rubric.score.correction_quality_points;
  const leaveFreshScore = leaveFresh * rubric.score.leave_fresh_points;
  const falseSupersedePenalty = structural.superseded_fresh_ids.length * rubric.score.false_supersede_penalty;
  const finalScore = Math.max(0, supersedeRecallScore + correctionQualityScore + leaveFreshScore - falseSupersedePenalty);

  return {
    supersede_recall_score: round(supersedeRecallScore, 2),
    correction_quality_score: round(correctionQualityScore, 2),
    leave_fresh_score: round(leaveFreshScore, 2),
    false_supersede_penalty: round(falseSupersedePenalty, 2),
    final_score: round(finalScore, 2),
    pass_threshold: rubric.score.pass_threshold,
    passed: finalScore >= rubric.score.pass_threshold,
    superseded_stale_ids: structural.superseded_stale_ids,
    superseded_fresh_ids: structural.superseded_fresh_ids,
  };
}

function writeResult(
  context: RunContext,
  setupCommands: CommandResult[],
  patchCommand: CommandResult | undefined,
  generation: AgentRunResult | undefined,
  updateCommands: CommandResult[],
  graphReadCommand: CommandResult | undefined,
  structuralScore: StructuralScore | undefined,
  judge: EvalResult["judge"],
  success: boolean,
): void {
  const result: EvalResult = {
    case_id: caseId,
    target_repo_url: context.targetRepoUrl,
    base_commit: baseCommit,
    run_dir: context.runDir,
    target_repo_dir: context.targetRepoDir,
    greplica_home_dir: context.greplicaHomeDir,
    seed_proposal_path: context.seedProposalPath,
    session_patch_path: context.sessionPatchPath,
    update_proposal_path: context.updateProposalPath,
    graph_read_path: context.graphReadPath,
    success,
    setup_commands: setupCommands,
    patch_command: patchCommand,
    generation,
    update_commands: updateCommands,
    graph_read_command: graphReadCommand,
    structural_score: structuralScore,
    judge,
  };

  writeJson(resolve(context.runDir, "result.json"), result);
}

function parseArgs(args: string[]): Args {
  const agent = valueAfter(args, "--agent");
  if (agent !== undefined && agent !== "codex") throw new Error("Only --agent codex is supported.");
  const judge = valueAfter(args, "--judge");
  if (judge !== undefined && judge !== "openai") throw new Error("Only --judge openai is supported.");
  return { agent: "codex", agentModel: valueAfter(args, "--agent-model"), judge, judgeModel: valueAfter(args, "--judge-model") };
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
3. Query existing memory with greplica graph context to find claims about the changed code.
4. For any existing claim whose code changed so that it is now inaccurate, create a superseding claim with corrected text and correct code anchors.
5. Leave claims whose code did not change unchanged; do not supersede still-accurate memory.
6. Create the update proposal JSON at ${context.updateProposalPath}.
7. Validate it with: ${greplica} proposal validate ${context.updateProposalPath}
8. Fix validation errors until valid. Do not apply the proposal; the eval runner applies it after you exit.`;
}

async function requestJudge(apiKey: string, model: string, input: JudgeInput): Promise<JudgeOutput> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are an evaluator for Greplica anchor-drift memory repair. Return JSON only. For each stale claim, classify whether the candidate proposal restates it and whether the new value is correct. Do not calculate numeric scores.",
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: { type: "json_schema", name: "anchor_drift_supersede_judge", strict: true, schema: judgeOutputSchema() },
      },
    }),
  });

  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`OpenAI judge request failed: ${JSON.stringify(body)}`);

  return JSON.parse(extractOutputText(body)) as JudgeOutput;
}

function judgeOutputSchema(): Record<string, unknown> {
  const correctionItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      stale_claim_id: { type: "string" },
      correction_present: { type: "boolean" },
      correction_correct: { type: "boolean" },
      matched_claim_ids: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
    required: ["stale_claim_id", "correction_present", "correction_correct", "matched_claim_ids", "reason"],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: { corrections: { type: "array", items: correctionItem } },
    required: ["corrections"],
  };
}

function hasSupersedes(proposal: unknown, oldClaimId: string): boolean {
  const creates = proposalCreates(proposal);
  if (!creates) return false;

  for (const claim of proposalClaims(creates)) {
    if (stringArray(claim.supersedes).includes(oldClaimId)) return true;
  }

  return proposalEdges(creates).some((edge) => {
    return edge.kind === "supersedes" && edgeTo(edge) === oldClaimId && typeof edgeFrom(edge) === "string";
  });
}

function proposalCreates(proposal: unknown): Record<string, unknown> | undefined {
  if (!isRecord(proposal) || !isRecord(proposal.creates)) return undefined;
  return proposal.creates;
}

function proposalClaims(creates: Record<string, unknown>): ProposalClaim[] {
  if (!Array.isArray(creates.claims)) return [];
  return creates.claims.flatMap((claim) => {
    if (!isRecord(claim) || typeof claim.id !== "string") return [];
    return [{ id: claim.id, supersedes: claim.supersedes }];
  });
}

function proposalEdges(creates: Record<string, unknown>): ProposalEdge[] {
  if (!Array.isArray(creates.edges)) return [];
  return creates.edges.flatMap((edge) => {
    if (!isRecord(edge)) return [];
    return [{ kind: edge.kind, from: edge.from, from_id: edge.from_id, to: edge.to, to_id: edge.to_id }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function edgeFrom(edge: ProposalEdge): string {
  return typeof edge.from === "string" ? edge.from : typeof edge.from_id === "string" ? edge.from_id : "";
}

function edgeTo(edge: ProposalEdge): string {
  return typeof edge.to === "string" ? edge.to : typeof edge.to_id === "string" ? edge.to_id : "";
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
