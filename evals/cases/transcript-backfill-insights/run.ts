import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  evaluateProposalAnchorQuality,
  type ProposalAnchorQualityResult,
} from "../../lib/code-anchor-quality.js";
import { runCodexAgent } from "../../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

const caseId = "transcript-backfill-insights";
const baseCommit = "6c43bafc1fc861088281fec5bd003261c76e63e9";

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
  transcriptBundlePath: string;
  backfillProposalPath: string;
  graphReadPath: string;
  rubricPath: string;
  greplicaCommand: string[];
}

interface EvalResult {
  case_id: string;
  target_repo_url: string;
  base_commit: string;
  run_dir: string;
  target_repo_dir: string;
  greplica_home_dir: string;
  seed_proposal_path: string;
  transcript_bundle_path: string;
  backfill_proposal_path: string;
  graph_read_path: string;
  success: boolean;
  setup_commands: CommandResult[];
  generation_time_seconds?: number;
  generation?: AgentRunResult;
  anchor_quality?: ProposalAnchorQualityResult;
  backfill_commands: CommandResult[];
  graph_read_command?: CommandResult;
  local_checks?: LocalCheckResult;
  judge?: {
    model: string;
    judge_input_path: string;
    judge_output_path: string;
    score: ScoreResult;
  };
}

interface Rubric {
  case_id: string;
  base_commit: string;
  score: {
    pass_threshold: number;
    expected_memory_points: number;
    expected_memory_hit_cap: number;
    role_correctness_points: number;
    evidence_correctness_points: number;
    anchor_correctness_points: number;
    quality_points: number;
    output_quality_points: number;
    generation_time_points: number;
    generation_time_full_credit_seconds: number;
    generation_time_limit_seconds: number;
    bad_memory_penalties: Record<BadMemoryCategory, QualityPenalty>;
    noise_penalties: Record<NoiseKey, QualityPenalty>;
  };
  judge: JudgeRubric;
}

interface QualityPenalty {
  points: number;
  max: number;
}

interface JudgeRubric {
  instructions: string[];
  allowed_memory_roles: MemoryRole[];
  bundle_facts: string[];
  expected_memories: ExpectedMemory[];
  expected_supersedes: ExpectedSupersedes[];
  expected_anchor_sets: ExpectedAnchorSet[];
  bad_memory_categories: Record<BadMemoryCategory, string>;
}

type MemoryRole =
  | "code_fact"
  | "flow_fact"
  | "constraint"
  | "rationale"
  | "tradeoff"
  | "drift"
  | "task"
  | "future_work";

type MemoryCategory =
  | "decision"
  | "rejected_alternative"
  | "risk_gotcha"
  | "component_flow"
  | "evidence_rule"
  | "future_work"
  | "corrected_assumption";

type BadMemoryCategory =
  | "unsupported"
  | "wrong_evidence"
  | "session_changelog"
  | "not_next_time_useful"
  | "planned_or_reverted_as_real"
  | "generic_agent_behavior"
  | "over_broad_summary";

type NoiseKey =
  | "stores_raw_transcript_junk"
  | "stores_system_or_developer_prompt"
  | "stores_encrypted_reasoning"
  | "stores_command_log_chatter";

interface ExpectedMemory {
  id: string;
  category: MemoryCategory;
  role: MemoryRole;
  weight: number;
  description: string;
}

interface JudgeExpectedMemory {
  id: string;
  category: MemoryCategory;
  role: MemoryRole;
  description: string;
}

interface ExpectedSupersedes {
  id: string;
  old_claim_id: string;
  description: string;
}

interface ExpectedCodeAnchor {
  file: string;
  symbol?: string;
}

interface ExpectedAnchorSet {
  expected_memory_id: string;
  anchors: ExpectedCodeAnchor[];
}

interface JudgeInput {
  task: string;
  instructions: string[];
  allowed_memory_roles: MemoryRole[];
  initial_memory: {
    description: string;
    bootstrap_seed_proposal: unknown;
  };
  bundle_evidence: {
    base_commit: string;
    transcript_bundle: string;
    bundle_facts: string[];
  };
  candidate_update: {
    proposal: unknown;
    final_message: string;
  };
  expected_checks: {
    expected_memories: JudgeExpectedMemory[];
    expected_supersedes: ExpectedSupersedes[];
  };
  bad_memory_checks: Record<BadMemoryCategory, string>;
}

interface JudgeOutput {
  expected_memories: Array<{
    expected_id: string;
    present: boolean;
    matched_claim_ids: string[];
    role_correct: boolean;
    evidence_correct: boolean;
    reason: string;
  }>;
  supersedes: Array<{
    expected_id: string;
    present: boolean;
    matched_claim_ids: string[];
    matched_supersedes: string[];
    reason: string;
  }>;
  bad_memories: Array<{
    claim_id: string;
    category: BadMemoryCategory;
    reason: string;
  }>;
  output_quality: {
    has_concrete_flow_or_component: boolean;
    describes_next_time_value: boolean;
    avoids_session_recap: boolean;
    explains_graph_retrieval_value: boolean;
    includes_supported_correction_or_omits_if_weak: boolean;
    reason: string;
  };
  noise: Record<NoiseKey, boolean> & {
    reason: string;
  };
}

interface ProposalClaim {
  id: string;
  text?: unknown;
  truth?: unknown;
  supersedes?: unknown;
  code_anchors?: unknown;
}

interface ProposalSource {
  id: string;
  ref?: unknown;
  title?: unknown;
}

interface ProposalNamedSubject {
  id: string;
  name?: unknown;
  text?: unknown;
}

interface ProposalEdge {
  kind?: unknown;
  from?: unknown;
  from_id?: unknown;
  to?: unknown;
  to_id?: unknown;
  metadata?: unknown;
}

interface ScoreResult {
  expected_memory_score: number;
  expected_memory_hit_count: number;
  expected_memory_hit_cap: number;
  role_correctness_score: number;
  evidence_correctness_score: number;
  anchor_correctness_score: number;
  quality_score: number;
  output_quality_score: number;
  generation_time_score: number;
  generation_time_seconds: number | undefined;
  generation_time_full_credit_seconds: number;
  generation_time_limit_seconds: number;
  final_score: number;
  pass_threshold: number;
  passed: boolean;
  anchor_correctness: AnchorCorrectnessResult;
  local_checks: LocalCheckResult | undefined;
}

interface LocalCheckResult {
  passed: boolean;
  issues: string[];
  claim_count: number;
  source_count: number;
  reasoned_evidence_edges: number;
  generated_claims_in_graph: number;
}

interface AnchorCorrectnessResult {
  correct_required_anchors: number;
  total_required_anchors: number;
  passed_expected_memory_ids: string[];
  checks: AnchorCorrectnessCheck[];
}

interface AnchorCorrectnessCheck {
  expected_memory_id: string;
  matched_claim_ids: string[];
  correct_required_anchors: number;
  total_required_anchors: number;
  passed: boolean;
  expected_anchors: ExpectedCodeAnchor[];
  actual_anchors: ExpectedCodeAnchor[];
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
  const generationStartedAt = Date.now();
  const generation = setupSucceeded ? await runBackfillAgent(context, args) : undefined;
  const generationTimeSeconds = generation === undefined ? undefined : round((Date.now() - generationStartedAt) / 1000, 2);
  const proposalCreated = existsSync(context.backfillProposalPath);
  const anchorQuality = proposalCreated
    ? await evaluateProposalAnchorQuality(readJson<unknown>(context.backfillProposalPath), context.targetRepoDir)
    : undefined;
  const backfillCommands: CommandResult[] = [];
  const graphReadCommand = generation?.exit_code === 0 && proposalCreated
    ? readFinalGraph(context)
    : undefined;
  const localChecks = proposalCreated
    ? evaluateLocalChecks(readJson<unknown>(context.backfillProposalPath), graphReadCommand)
    : undefined;
  const judge = generation?.exit_code === 0 && proposalCreated && args.judge === "openai"
    ? await runOpenAiJudge(context, args, generationTimeSeconds, localChecks)
    : undefined;
  const success =
    setupSucceeded &&
    generation?.exit_code === 0 &&
    proposalCreated &&
    anchorQuality?.passed === true &&
    backfillCommands.every((command) => command.exit_code === 0) &&
    graphReadCommand?.exit_code === 0 &&
    localChecks?.passed === true &&
    (judge === undefined || judge.score.passed);

  writeResult(
    context,
    setupCommands,
    generationTimeSeconds,
    generation,
    anchorQuality,
    backfillCommands,
    graphReadCommand,
    localChecks,
    judge,
    success,
  );

  console.log(success ? "Transcript backfill insights eval passed." : "Transcript backfill insights eval failed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Backfill proposal: ${context.backfillProposalPath}`);
  if (generationTimeSeconds !== undefined) {
    console.log(`Generation time: ${formatSeconds(generationTimeSeconds)}`);
  }
  if (anchorQuality) {
    console.log(
      `Anchor quality: ${anchorQuality.error_count} errors, ${anchorQuality.warning_count} warnings across ${anchorQuality.checked_claim_count} code-verified claims.`,
    );
    printAnchorQualityIssues(anchorQuality);
  }
  if (judge) {
    console.log(`Score: ${judge.score.final_score.toFixed(2)} / 100`);
    console.log(
      `Useful memories: ${judge.score.expected_memory_hit_count}/${judge.score.expected_memory_hit_cap} hit cap, score ${judge.score.expected_memory_score.toFixed(2)}`,
    );
    console.log(`Quality score: ${judge.score.quality_score.toFixed(2)}`);
    console.log(`Output quality score: ${judge.score.output_quality_score.toFixed(2)}`);
    console.log(
      `Generation time score: ${judge.score.generation_time_score.toFixed(2)} / ${readJson<Rubric>(context.rubricPath).score.generation_time_points}`,
    );
    console.log(
      `Anchor correctness: ${judge.score.anchor_correctness.correct_required_anchors}/${judge.score.anchor_correctness.total_required_anchors} required anchors matched.`,
    );
  }
  if (localChecks !== undefined && !localChecks.passed) {
    console.log("Local structural checks failed:");
    for (const issue of localChecks.issues) console.log(`- ${issue}`);
  }
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const fixtureDir = resolve(repoRoot, "evals/cases/transcript-backfill-insights");
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
    transcriptBundlePath: resolve(runDir, "previous-sessions.bundle.md"),
    backfillProposalPath: resolve(runDir, "backfill-proposal.json"),
    graphReadPath: resolve(runDir, "final-graph.txt"),
    rubricPath: resolve(fixtureDir, "rubric.json"),
    greplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

function copyFixtures(context: RunContext): void {
  copyFileSync(resolve(context.fixtureDir, "bootstrap-seed.proposal.json"), context.seedProposalPath);
  copyFileSync(resolve(context.fixtureDir, "previous-sessions.bundle.md"), context.transcriptBundlePath);
}

function prepareTargetRepo(context: RunContext): void {
  runOrThrow(["git", "clone", context.targetRepoUrl, context.targetRepoDir], context.repoRoot);
  runOrThrow(["git", "checkout", baseCommit], context.targetRepoDir);
}

function prepareGreplicaHome(context: RunContext): void {
  mkdirSync(context.greplicaHomeDir, { recursive: true });
  mkdirSync(context.codexHomeDir, { recursive: true });
  seedLocalModelCache(context.greplicaHomeDir);
  seedCodexRuntimeHome(context.codexHomeDir);
}

function seedLocalModelCache(greplicaHomeDir: string): void {
  const sourceModels = resolve(homedir(), ".greplica", "models");
  if (!existsSync(sourceModels)) return;
  cpSync(sourceModels, resolve(greplicaHomeDir, "models"), { recursive: true });
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

async function runBackfillAgent(context: RunContext, args: Args): Promise<AgentRunResult> {
  const model = args.agentModel ?? "gpt-5.5";
  const result = await runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, CODEX_HOME: context.codexHomeDir, GREPLICA_HOME: context.greplicaHomeDir },
    model,
    prompt: codexBackfillPrompt(context),
    transcriptPath: resolve(context.runDir, "agent-events.jsonl"),
    finalMessagePath: resolve(context.runDir, "agent-final-message.txt"),
    proposalPath: context.backfillProposalPath,
  });

  if (result.exit_code !== 0) {
    throw new Error(`Codex agent failed with exit code ${String(result.exit_code)}.`);
  }
  if (!existsSync(context.backfillProposalPath)) {
    throw new Error(`Codex agent did not create proposal at ${context.backfillProposalPath}.`);
  }

  return result;
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

async function runOpenAiJudge(
  context: RunContext,
  args: Args,
  generationTimeSeconds: number | undefined,
  localChecks: LocalCheckResult | undefined,
): Promise<NonNullable<EvalResult["judge"]>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required when using --judge openai.");

  const model = args.judgeModel ?? process.env.OPENAI_MODEL;
  if (!model) throw new Error("Set OPENAI_MODEL or pass --judge-model when using --judge openai.");

  const rubric = readJson<Rubric>(context.rubricPath);
  const judgeInput = buildJudgeInput(context, rubric);
  const judgeInputPath = resolve(context.runDir, "judge-input.json");
  const judgeOutputPath = resolve(context.runDir, "judge-output.json");
  writeJson(judgeInputPath, judgeInput);

  const judgeOutput = await requestJudge(apiKey, model, judgeInput);
  writeJson(judgeOutputPath, judgeOutput);

  return {
    model,
    judge_input_path: judgeInputPath,
    judge_output_path: judgeOutputPath,
    score: scoreJudgeOutput(rubric, judgeOutput, readJson<unknown>(context.backfillProposalPath), generationTimeSeconds, localChecks),
  };
}

function buildJudgeInput(context: RunContext, rubric: Rubric): JudgeInput {
  return {
    task:
      "Classify this fast-session-bootstrap proposal against a gold pool. Return JSON classification only; do not compute numeric scores.",
    instructions: rubric.judge.instructions,
    allowed_memory_roles: rubric.judge.allowed_memory_roles,
    initial_memory: {
      description: "The deterministic bootstrap memory seeded before the historical session patch was applied.",
      bootstrap_seed_proposal: readJson<unknown>(context.seedProposalPath),
    },
    bundle_evidence: {
      base_commit: baseCommit,
      transcript_bundle: readFileSync(context.transcriptBundlePath, "utf8"),
      bundle_facts: rubric.judge.bundle_facts,
    },
    candidate_update: {
      proposal: readJson<unknown>(context.backfillProposalPath),
      final_message: readIfExists(resolve(context.runDir, "agent-final-message.txt")),
    },
    expected_checks: {
      expected_memories: rubric.judge.expected_memories.map(toJudgeExpectedMemory),
      expected_supersedes: rubric.judge.expected_supersedes,
    },
    bad_memory_checks: rubric.judge.bad_memory_categories,
  };
}

function toJudgeExpectedMemory(memory: ExpectedMemory): JudgeExpectedMemory {
  return {
    id: memory.id,
    category: memory.category,
    role: memory.role,
    description: memory.description,
  };
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeResult(
  context: RunContext,
  setupCommands: CommandResult[],
  generationTimeSeconds: number | undefined,
  generation: AgentRunResult | undefined,
  anchorQuality: ProposalAnchorQualityResult | undefined,
  backfillCommands: CommandResult[],
  graphReadCommand: CommandResult | undefined,
  localChecks: LocalCheckResult | undefined,
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
    transcript_bundle_path: context.transcriptBundlePath,
    backfill_proposal_path: context.backfillProposalPath,
    graph_read_path: context.graphReadPath,
    success,
    setup_commands: setupCommands,
    generation_time_seconds: generationTimeSeconds,
    generation,
    anchor_quality: anchorQuality,
    backfill_commands: backfillCommands,
    graph_read_command: graphReadCommand,
    local_checks: localChecks,
    judge,
  };

  writeJson(resolve(context.runDir, "result.json"), result);
}

function parseArgs(args: string[]): Args {
  const agent = valueAfter(args, "--agent");
  if (agent !== undefined && agent !== "codex") throw new Error("Only --agent codex is supported.");
  const judge = valueAfter(args, "--judge");
  if (judge !== undefined && judge !== "openai") throw new Error("Only --judge openai is supported.");
  const agentModel = valueAfter(args, "--agent-model");
  const judgeModel = valueAfter(args, "--judge-model");
  return { agent: "codex", agentModel, judge, judgeModel };
}

function codexBackfillPrompt(context: RunContext): string {
  const skill = readFileSync(resolve(context.repoRoot, "skills/greplica-fast-session-bootstrap/SKILL.md"), "utf8");

  return `Use this exact user-facing skill as the workflow contract:

<greplica_transcript_backfill_skill>
${skill}
</greplica_transcript_backfill_skill>

Run greplica-fast-session-bootstrap on this transcript bundle:
${context.transcriptBundlePath}

For this eval, write the proposal JSON exactly here:
${context.backfillProposalPath}

Do not edit repository source files. Do not include local eval-run paths in the final answer.`;
}

async function requestJudge(apiKey: string, model: string, input: JudgeInput): Promise<JudgeOutput> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are an evaluator for Greplica fast-session-bootstrap proposals. Return JSON only. Classify gold-pool memories, supersedes, bad memories, final output quality, and transcript noise. Do not calculate numeric scores.",
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "update_working_memory_eval_judge",
          strict: true,
          schema: judgeOutputSchema(),
        },
      },
    }),
  });

  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OpenAI judge request failed: ${JSON.stringify(body)}`);
  }

  const outputText = extractOutputText(body);
  return JSON.parse(outputText) as JudgeOutput;
}

function scoreJudgeOutput(
  rubric: Rubric,
  judge: JudgeOutput,
  proposal: unknown,
  generationTimeSeconds: number | undefined,
  localChecks: LocalCheckResult | undefined,
): ScoreResult {
  const classifiedById = new Map(judge.expected_memories.map((memory) => [memory.expected_id, memory]));
  const expectedWeightCap = usefulMemoryWeightCap(rubric);
  let presentWeight = 0;
  let roleCorrectWeight = 0;
  let evidenceCorrectWeight = 0;
  let hitCount = 0;

  for (const expected of rubric.judge.expected_memories) {
    const classified = classifiedById.get(expected.id);
    if (!classified?.present) continue;
    hitCount += 1;
    presentWeight += expected.weight;
    if (classified.role_correct) roleCorrectWeight += expected.weight;
    if (classified.evidence_correct) evidenceCorrectWeight += expected.weight;
  }

  const expectedMemoryScore = expectedWeightCap === 0
    ? 0
    : (Math.min(presentWeight, expectedWeightCap) / expectedWeightCap) * rubric.score.expected_memory_points;
  const roleCorrectnessScore = presentWeight === 0
    ? 0
    : (roleCorrectWeight / presentWeight) * rubric.score.role_correctness_points;
  const evidenceCorrectnessScore = presentWeight === 0
    ? 0
    : (evidenceCorrectWeight / presentWeight) * rubric.score.evidence_correctness_points;

  const anchorCorrectness = scoreAnchorCorrectness(rubric, judge, proposal);
  const anchorCorrectnessScore = anchorCorrectness.total_required_anchors === 0
    ? rubric.score.anchor_correctness_points
    : (anchorCorrectness.correct_required_anchors / anchorCorrectness.total_required_anchors) *
      rubric.score.anchor_correctness_points;

  const qualityPenalty = scoreQualityPenalty(rubric, judge);
  const qualityScore = Math.max(0, rubric.score.quality_points - qualityPenalty);
  const outputQualityScore = scoreOutputQuality(rubric, judge);
  const generationTime = scoreGenerationTime(rubric, generationTimeSeconds);
  const finalScore =
    expectedMemoryScore +
    roleCorrectnessScore +
    evidenceCorrectnessScore +
    anchorCorrectnessScore +
    qualityScore +
    outputQualityScore +
    generationTime.score;

  return {
    expected_memory_score: round(expectedMemoryScore, 2),
    expected_memory_hit_count: hitCount,
    expected_memory_hit_cap: rubric.score.expected_memory_hit_cap,
    role_correctness_score: round(roleCorrectnessScore, 2),
    evidence_correctness_score: round(evidenceCorrectnessScore, 2),
    anchor_correctness_score: round(anchorCorrectnessScore, 2),
    quality_score: round(qualityScore, 2),
    output_quality_score: round(outputQualityScore, 2),
    generation_time_score: round(generationTime.score, 2),
    generation_time_seconds: generationTimeSeconds,
    generation_time_full_credit_seconds: rubric.score.generation_time_full_credit_seconds,
    generation_time_limit_seconds: rubric.score.generation_time_limit_seconds,
    final_score: round(finalScore, 2),
    pass_threshold: rubric.score.pass_threshold,
    passed: finalScore >= rubric.score.pass_threshold && !generationTime.exceeded_limit && localChecks?.passed !== false,
    anchor_correctness: anchorCorrectness,
    local_checks: localChecks,
  };
}

function usefulMemoryWeightCap(rubric: Rubric): number {
  return [...rubric.judge.expected_memories]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, rubric.score.expected_memory_hit_cap)
    .reduce((sum, memory) => sum + memory.weight, 0);
}

function scoreOutputQuality(rubric: Rubric, judge: JudgeOutput): number {
  const checks = [
    judge.output_quality.has_concrete_flow_or_component,
    judge.output_quality.describes_next_time_value,
    judge.output_quality.avoids_session_recap,
    judge.output_quality.explains_graph_retrieval_value,
    judge.output_quality.includes_supported_correction_or_omits_if_weak,
  ];
  const passed = checks.filter(Boolean).length;
  return (passed / checks.length) * rubric.score.output_quality_points;
}

function scoreQualityPenalty(rubric: Rubric, judge: JudgeOutput): number {
  let penalty = 0;
  for (const [category, config] of Object.entries(rubric.score.bad_memory_penalties) as Array<[BadMemoryCategory, QualityPenalty]>) {
    const count = judge.bad_memories.filter((memory) => memory.category === category && memory.claim_id.startsWith("claim.")).length;
    penalty += Math.min(count * config.points, config.max);
  }
  for (const [key, config] of Object.entries(rubric.score.noise_penalties) as Array<[NoiseKey, QualityPenalty]>) {
    if (judge.noise[key]) penalty += Math.min(config.points, config.max);
  }
  return penalty;
}

function scoreGenerationTime(
  rubric: Rubric,
  elapsedSeconds: number | undefined,
): { score: number; exceeded_limit: boolean } {
  const maxPoints = rubric.score.generation_time_points;
  if (maxPoints === 0) return { score: 0, exceeded_limit: false };
  if (elapsedSeconds === undefined) return { score: 0, exceeded_limit: true };
  const fullCreditSeconds = rubric.score.generation_time_full_credit_seconds;
  const limitSeconds = rubric.score.generation_time_limit_seconds;

  if (elapsedSeconds <= fullCreditSeconds) return { score: maxPoints, exceeded_limit: false };
  if (elapsedSeconds >= limitSeconds) return { score: 0, exceeded_limit: true };

  const remainingFraction = (limitSeconds - elapsedSeconds) / (limitSeconds - fullCreditSeconds);
  return { score: maxPoints * remainingFraction, exceeded_limit: false };
}

function scoreAnchorCorrectness(
  rubric: Rubric,
  judge: JudgeOutput,
  proposal: unknown,
): AnchorCorrectnessResult {
  const classifiedById = new Map(judge.expected_memories.map((memory) => [memory.expected_id, memory]));
  const claimsById = new Map(proposalClaims(proposalCreates(proposal) ?? {}).map((claim) => [claim.id, claim]));
  const checks: AnchorCorrectnessCheck[] = [];

  for (const expectation of rubric.judge.expected_anchor_sets) {
    const classified = classifiedById.get(expectation.expected_memory_id);
    if (!classified?.present) continue;

    const codeVerifiedClaims = classified.matched_claim_ids.flatMap((claimId) => {
      const claim = claimsById.get(claimId);
      return claim?.truth === "code_verified" ? [claim] : [];
    });
    if (codeVerifiedClaims.length === 0) continue;

    const actualAnchors = codeVerifiedClaims.flatMap((claim) => {
      return claimCodeAnchors(claim.code_anchors);
    });
    const correctRequiredAnchors = expectation.anchors.filter((expectedAnchor) => {
      return actualAnchors.some((actualAnchor) => anchorsEqual(actualAnchor, expectedAnchor));
    }).length;

    checks.push({
      expected_memory_id: expectation.expected_memory_id,
      matched_claim_ids: classified.matched_claim_ids,
      correct_required_anchors: correctRequiredAnchors,
      total_required_anchors: expectation.anchors.length,
      passed: correctRequiredAnchors === expectation.anchors.length,
      expected_anchors: expectation.anchors,
      actual_anchors: actualAnchors,
    });
  }

  const correctRequiredAnchors = checks.reduce((sum, check) => sum + check.correct_required_anchors, 0);
  const totalRequiredAnchors = checks.reduce((sum, check) => sum + check.total_required_anchors, 0);

  return {
    correct_required_anchors: correctRequiredAnchors,
    total_required_anchors: totalRequiredAnchors,
    passed_expected_memory_ids: checks.filter((check) => check.passed).map((check) => check.expected_memory_id),
    checks,
  };
}

function printAnchorQualityIssues(anchorQuality: ProposalAnchorQualityResult): void {
  for (const issue of anchorQuality.issues.slice(0, 8)) {
    const anchor = issue.anchor === undefined
      ? ""
      : ` (${issue.anchor.file}${issue.anchor.symbol === undefined ? "" : `#${issue.anchor.symbol}`})`;
    console.log(`- ${issue.severity}: ${issue.claim_id}${anchor}: ${issue.message}`);
  }
  if (anchorQuality.issues.length > 8) {
    console.log(`- ... ${anchorQuality.issues.length - 8} more anchor quality issues in result.json`);
  }
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(2)}s`;
}

function evaluateLocalChecks(proposal: unknown, graphReadCommand: CommandResult | undefined): LocalCheckResult {
  const creates = proposalCreates(proposal) ?? {};
  const claims = proposalClaims(creates);
  const sources = proposalSources(creates);
  const edges = proposalEdges(creates);
  const issues: string[] = [];

  if (claims.length < 8 || claims.length > 40) {
    issues.push(`Expected 8-40 generated claims for the five-session bundle, found ${claims.length}.`);
  }

  if (sources.length === 0) {
    issues.push("Expected at least one stable transcript session source.");
  }

  for (const source of sources) {
    const identity = `${source.id} ${String(source.ref ?? "")} ${String(source.title ?? "")}`.toLowerCase();
    if (identity.includes("source.current_session") || identity.includes("current session")) {
      issues.push(`Source ${source.id} uses generic current-session identity.`);
    }
    if (!isStableSessionRef(source.ref)) {
      issues.push(`Source ${source.id} does not use a stable Codex/Claude session ref.`);
    }
  }

  const reasonedEvidenceEdges = edges.filter(isReasonedEvidenceEdge);
  const sourceBackedClaims = claims.filter((claim) => claim.truth === "source_verified");
  for (const claim of sourceBackedClaims) {
    if (!reasonedEvidenceEdges.some((edge) => edgeFrom(edge) === claim.id)) {
      issues.push(`Source-backed claim ${claim.id} has no reasoned evidenced_by edge.`);
    }
  }

  const broadSubjects = [...proposalSubjects(creates), ...claims].filter(hasBroadSessionSummaryText);
  if (broadSubjects.length > 0) {
    issues.push(`Generated broad session-summary subjects: ${broadSubjects.map((item) => item.id).join(", ")}.`);
  }

  const graphOutput = graphReadCommand?.stdout ?? "";
  const generatedClaimsInGraph = claims.filter((claim) => graphOutput.includes(claim.id)).length;
  if (graphReadCommand?.exit_code !== 0) {
    issues.push("Final graph read failed.");
  } else if (claims.length > 0 && generatedClaimsInGraph === 0) {
    issues.push("Final graph read did not contain any generated claim IDs; the proposal may not have been applied.");
  }

  return {
    passed: issues.length === 0,
    issues,
    claim_count: claims.length,
    source_count: sources.length,
    reasoned_evidence_edges: reasonedEvidenceEdges.length,
    generated_claims_in_graph: generatedClaimsInGraph,
  };
}

function isStableSessionRef(value: unknown): boolean {
  return typeof value === "string" && (
    value.startsWith("codex-session:") ||
    value.startsWith("claude-code-session:")
  );
}

function isReasonedEvidenceEdge(edge: ProposalEdge): boolean {
  return edge.kind === "evidenced_by" &&
    typeof edgeFrom(edge) === "string" &&
    typeof edgeTo(edge) === "string" &&
    isRecord(edge.metadata) &&
    typeof edge.metadata.reason === "string" &&
    edge.metadata.reason.trim().length > 0;
}

function hasBroadSessionSummaryText(subject: ProposalClaim | ProposalNamedSubject): boolean {
  const name = "name" in subject ? subject.name : undefined;
  const text = `${String(name ?? "")} ${String(subject.text ?? "")}`.toLowerCase();
  if (
    text.includes("not a broad") ||
    text.includes("not a digest") ||
    text.includes("not store") ||
    text.includes("not session changelog") ||
    text.includes("instead of session history") ||
    text.includes("session-history behavior") ||
    text.includes("not recap previous sessions") ||
    text.includes("rather than recapping") ||
    text.includes("instead of recapping") ||
    text.includes("bad memor") ||
    text.includes("over-broad transcript summar")
  ) {
    return false;
  }
  return /\b(session|transcript|backfill|prior sessions|previous sessions)\b/.test(text) &&
    /\b(summary|summaries|recap|history|bundle|what happened|learned from)\b/.test(text);
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
    return [{ id: claim.id, text: claim.text, truth: claim.truth, supersedes: claim.supersedes, code_anchors: claim.code_anchors }];
  });
}

function proposalSources(creates: Record<string, unknown>): ProposalSource[] {
  if (!Array.isArray(creates.sources)) return [];
  return creates.sources.flatMap((source) => {
    if (!isRecord(source) || typeof source.id !== "string") return [];
    return [{ id: source.id, ref: source.ref, title: source.title }];
  });
}

function proposalSubjects(creates: Record<string, unknown>): ProposalNamedSubject[] {
  const subjects: ProposalNamedSubject[] = [];
  for (const key of ["components", "flows"] as const) {
    const values = creates[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (isRecord(value) && typeof value.id === "string") {
        subjects.push({ id: value.id, name: value.name });
      }
    }
  }
  return subjects;
}

function claimCodeAnchors(value: unknown): ExpectedCodeAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((anchor) => {
    if (!isRecord(anchor) || typeof anchor.file !== "string") return [];
    return [{
      file: anchor.file,
      symbol: typeof anchor.symbol === "string" ? anchor.symbol : undefined,
    }];
  });
}

function anchorsEqual(actual: ExpectedCodeAnchor, expected: ExpectedCodeAnchor): boolean {
  return actual.file === expected.file && actual.symbol === expected.symbol;
}

function proposalEdges(creates: Record<string, unknown>): ProposalEdge[] {
  if (!Array.isArray(creates.edges)) return [];
  return creates.edges.flatMap((edge) => {
    if (!isRecord(edge)) return [];
    return [{
      kind: edge.kind,
      from: edge.from,
      from_id: edge.from_id,
      to: edge.to,
      to_id: edge.to_id,
      metadata: edge.metadata,
    }];
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

function judgeOutputSchema(): Record<string, unknown> {
  const expectedMemoryItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      expected_id: { type: "string" },
      present: { type: "boolean" },
      matched_claim_ids: { type: "array", items: { type: "string" } },
      role_correct: { type: "boolean" },
      evidence_correct: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["expected_id", "present", "matched_claim_ids", "role_correct", "evidence_correct", "reason"],
  };
  const supersedesItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      expected_id: { type: "string" },
      present: { type: "boolean" },
      matched_claim_ids: { type: "array", items: { type: "string" } },
      matched_supersedes: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
    required: ["expected_id", "present", "matched_claim_ids", "matched_supersedes", "reason"],
  };
  const badMemoryItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      claim_id: { type: "string" },
      category: {
        type: "string",
        enum: [
          "unsupported",
          "wrong_evidence",
          "session_changelog",
          "not_next_time_useful",
          "planned_or_reverted_as_real",
          "generic_agent_behavior",
          "over_broad_summary",
        ],
      },
      reason: { type: "string" },
    },
    required: ["claim_id", "category", "reason"],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      expected_memories: { type: "array", items: expectedMemoryItem },
      supersedes: { type: "array", items: supersedesItem },
      bad_memories: { type: "array", items: badMemoryItem },
      output_quality: {
        type: "object",
        additionalProperties: false,
        properties: {
          has_concrete_flow_or_component: { type: "boolean" },
          describes_next_time_value: { type: "boolean" },
          avoids_session_recap: { type: "boolean" },
          explains_graph_retrieval_value: { type: "boolean" },
          includes_supported_correction_or_omits_if_weak: { type: "boolean" },
          reason: { type: "string" },
        },
        required: [
          "has_concrete_flow_or_component",
          "describes_next_time_value",
          "avoids_session_recap",
          "explains_graph_retrieval_value",
          "includes_supported_correction_or_omits_if_weak",
          "reason",
        ],
      },
      noise: {
        type: "object",
        additionalProperties: false,
        properties: {
          stores_raw_transcript_junk: { type: "boolean" },
          stores_system_or_developer_prompt: { type: "boolean" },
          stores_encrypted_reasoning: { type: "boolean" },
          stores_command_log_chatter: { type: "boolean" },
          reason: { type: "string" },
        },
        required: [
          "stores_raw_transcript_junk",
          "stores_system_or_developer_prompt",
          "stores_encrypted_reasoning",
          "stores_command_log_chatter",
          "reason",
        ],
      },
    },
    required: ["expected_memories", "supersedes", "bad_memories", "output_quality", "noise"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
