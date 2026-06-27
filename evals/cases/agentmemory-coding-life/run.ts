import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  round,
  run,
  runOrThrow,
  timestamp,
  valueAfter,
  writeJson,
} from "../../lib/common.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";
import { runCodexAgent } from "../../../libs/agent-runner/codex.js";
import { runClaudeAgent } from "../../../libs/agent-runner/claude.js";
import type { AgentRunInput, AgentRunResult } from "../../../libs/agent-runner/types.js";
import { loadQueries, loadSessions, type Query, type Session } from "./dataset.js";
import { buildSeedProposal } from "./seed.js";
import { requestJudge, type JudgeProvider, type JudgeVerdict } from "./judge.js";

const caseId = "agentmemory-coding-life";

type Arm = "full-context" | "greplica";
const ALL_ARMS: Arm[] = ["full-context", "greplica"];

type Engine = "codex" | "claude";

interface Args {
  arms: Arm[];
  engine: Engine;
  agentModel: string | undefined;
  judgeProvider: JudgeProvider | undefined;
  judgeModel: string | undefined;
  embedding: "local" | "openai";
  queryIds: string[] | undefined;
  limit: number | undefined;
}

interface Judge {
  provider: JudgeProvider;
  apiKey: string;
  model: string;
}

interface RunContext {
  repoRoot: string;
  runDir: string;
  greplicaCommand: string[];
  embedding: "local" | "openai";
}

interface ScoreRow {
  arm: Arm;
  query_id: string;
  type: string;
  question: string;
  gold_answer: string;
  gold_session_ids: string[];
  answer: string;
  pass: boolean | null;
  judge: { model: string | null; correct: boolean | null; reasoning: string | null };
  agent: {
    model: string;
    exit_code: number | null;
    elapsed_ms: number;
    tool_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    error?: string;
  };
  transcript_path: string;
  final_message_path: string;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const context = prepareRun(args);

  const sessions = loadSessions(context.repoRoot);
  const queries = selectQueries(loadQueries(context.repoRoot), args);

  const judge = resolveJudge(args);
  if (judge === undefined) {
    console.warn(
      "No judge API key found (set OPENAI_API_KEY or ANTHROPIC_API_KEY): answers will be collected but not judged (pass = null).",
    );
  } else {
    console.log(`Judge: ${judge.provider} (${judge.model})`);
  }
  if (args.engine === "claude" && !process.env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set: the claude engine will rely on whatever auth the local claude CLI has.");
  }

  const ndjsonPath = resolve(context.runDir, "scores.ndjson");
  writeFileSync(ndjsonPath, "");

  const rows: ScoreRow[] = [];
  for (const arm of args.arms) {
    console.log(`\n== arm: ${arm} (engine: ${args.engine}) ==`);
    const armSetup = prepareArm(context, arm, sessions, args.engine);
    for (const query of queries) {
      const row = await runQuery(context, arm, armSetup, query, sessions, args.engine, args.agentModel, judge);
      rows.push(row);
      appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`);
      const mark = row.pass === null ? "?" : row.pass ? "+" : "-";
      console.log(`  ${mark} ${query.id} [${query.type}] tokens=${row.agent.total_tokens ?? "?"} tools=${row.agent.tool_calls}`);
    }
  }

  const summary = summarize(rows, args.arms);
  writeJson(resolve(context.runDir, "summary.json"), summary);
  writeJson(resolve(context.runDir, "run-manifest.json"), {
    case_id: caseId,
    dataset: "coding-agent-life-v1",
    run_dir: context.runDir,
    arms: args.arms,
    agent_engine: args.engine,
    agent_model: args.agentModel ?? `${args.engine}-default`,
    judge_model: judge?.model ?? null,
    embedding: context.embedding,
    query_ids: queries.map((query) => query.id),
    greplica_command: context.greplicaCommand,
    generated_at: new Date().toISOString(),
  });

  printSummary(summary);
  console.log(`\nRun directory: ${context.runDir}`);
}

function prepareRun(args: Args): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  mkdirSync(runDir, { recursive: true });
  return {
    repoRoot,
    runDir,
    greplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
    embedding: args.embedding,
  };
}

interface ArmSetup {
  cwd: string;
  greplicaHome: string | undefined;
  setupCommands: CommandResult[];
}

function prepareArm(context: RunContext, arm: Arm, sessions: Session[], engine: Engine): ArmSetup {
  const armDir = resolve(context.runDir, arm);
  const cwd = resolve(armDir, "workspace");
  mkdirSync(cwd, { recursive: true });
  runOrThrow(["git", "init"], cwd, process.env, { stdio: "pipe" });
  writeFileSync(resolve(cwd, "README.md"), `# coding-agent-life-v1 ${arm} arm workspace\n`);

  if (arm !== "greplica") {
    return { cwd, greplicaHome: undefined, setupCommands: [] };
  }

  const greplicaHome = resolve(armDir, "greplica-home");
  mkdirSync(greplicaHome, { recursive: true });
  const seedPath = resolve(armDir, "seed.proposal.json");
  writeJson(seedPath, buildSeedProposal(sessions));

  const setupCommands = [
    runGreplica(context, greplicaHome, cwd, "install", "--platform", engine, "--embedding", context.embedding),
    runGreplica(context, greplicaHome, cwd, "proposal", "validate", seedPath),
    runGreplica(context, greplicaHome, cwd, "proposal", "apply", seedPath),
  ];
  for (const command of setupCommands) {
    if (command.exit_code !== 0) {
      throw new Error(
        `greplica arm setup failed: ${command.command.join(" ")}\n${command.stderr ?? command.stdout ?? ""}`,
      );
    }
  }
  return { cwd, greplicaHome, setupCommands };
}

async function runQuery(
  context: RunContext,
  arm: Arm,
  setup: ArmSetup,
  query: Query,
  sessions: Session[],
  engine: Engine,
  agentModel: string | undefined,
  judge: Judge | undefined,
): Promise<ScoreRow> {
  const queryDir = resolve(context.runDir, arm, query.id);
  mkdirSync(queryDir, { recursive: true });
  const transcriptPath = resolve(queryDir, "transcript.jsonl");
  const finalMessagePath = resolve(queryDir, "final-message.txt");

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (setup.greplicaHome !== undefined) env.GREPLICA_HOME = setup.greplicaHome;

  const agentInput: AgentRunInput = {
    cwd: setup.cwd,
    env,
    model: agentModel,
    prompt: buildPrompt(context, arm, query, sessions),
    transcriptPath,
    finalMessagePath,
  };

  let generation: AgentRunResult | undefined;
  let agentError: string | undefined;
  try {
    generation = engine === "claude" ? await runClaudeAgent(agentInput) : await runCodexAgent(agentInput);
  } catch (error: unknown) {
    agentError = error instanceof Error ? error.message : String(error);
  }

  const answer = existsSync(finalMessagePath) ? readFileSync(finalMessagePath, "utf8").trim() : "";

  let verdict: JudgeVerdict | undefined;
  let judgeError: string | undefined;
  if (judge !== undefined && answer.length > 0) {
    try {
      verdict = await requestJudge(judge.provider, judge.apiKey, judge.model, {
        question: query.question,
        goldAnswer: query.answer,
        candidateAnswer: answer,
      });
    } catch (error: unknown) {
      judgeError = error instanceof Error ? error.message : String(error);
    }
  }

  const pass = judge === undefined ? null : verdict?.correct ?? false;

  return {
    arm,
    query_id: query.id,
    type: query.type,
    question: query.question,
    gold_answer: query.answer,
    gold_session_ids: query.goldSessionIds,
    answer,
    pass,
    judge: {
      model: judge?.model ?? null,
      correct: verdict?.correct ?? null,
      reasoning: verdict?.reasoning ?? judgeError ?? null,
    },
    agent: {
      model: generation?.model ?? agentModel ?? `${engine}-default`,
      exit_code: generation?.exit_code ?? null,
      elapsed_ms: generation?.elapsed_ms ?? 0,
      tool_calls: generation?.tool_calls ?? 0,
      input_tokens: generation?.input_tokens ?? null,
      output_tokens: generation?.output_tokens ?? null,
      total_tokens: generation?.total_tokens ?? null,
      ...(agentError === undefined ? {} : { error: agentError }),
    },
    transcript_path: transcriptPath,
    final_message_path: finalMessagePath,
  };
}

function buildPrompt(context: RunContext, arm: Arm, query: Query, sessions: Session[]): string {
  const question = query.question;
  if (arm === "full-context") {
    const logs = sessions
      .map((session) => `### ${session.id}${session.timestamp ? ` (${session.timestamp})` : ""}\n${session.content}`)
      .join("\n\n");
    return [
      "You are answering a recall question about a software project's past work.",
      "Below are all past coding-agent session logs. Use only these logs.",
      "Answer in one or two sentences, citing the relevant session id(s) or PR number(s).",
      "",
      "<session_logs>",
      logs,
      "</session_logs>",
      "",
      `Question: ${question}`,
    ].join("\n");
  }

  const greplica = context.greplicaCommand.join(" ");
  return [
    "You are answering a recall question about a software project's past work.",
    "This repository has greplica memory of past coding-agent sessions.",
    `Before answering, recall relevant sessions by running: ${greplica} graph context "${question}"`,
    "You may run that command more than once with different phrasings if needed.",
    "Then answer in one or two sentences, citing the relevant session id(s) or PR number(s).",
    "If greplica returns nothing useful, say you do not know.",
    "",
    `Question: ${question}`,
  ].join("\n");
}

function runGreplica(context: RunContext, greplicaHome: string, cwd: string, ...args: string[]): CommandResult {
  return run([...context.greplicaCommand, ...args], cwd, { ...process.env, GREPLICA_HOME: greplicaHome });
}

interface ArmSummary {
  arm: Arm;
  n: number;
  judged: number;
  pass_count: number;
  pass_rate: number | null;
  avg_total_tokens: number | null;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  avg_tool_calls: number;
  avg_elapsed_ms: number;
}

function summarize(rows: ScoreRow[], arms: Arm[]): { case_id: string; by_arm: ArmSummary[] } {
  const byArm = arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    const judged = armRows.filter((row) => row.pass !== null);
    const passCount = judged.filter((row) => row.pass === true).length;
    return {
      arm,
      n: armRows.length,
      judged: judged.length,
      pass_count: passCount,
      pass_rate: judged.length === 0 ? null : round(passCount / judged.length, 4),
      avg_total_tokens: averageOrNull(armRows.map((row) => row.agent.total_tokens)),
      avg_input_tokens: averageOrNull(armRows.map((row) => row.agent.input_tokens)),
      avg_output_tokens: averageOrNull(armRows.map((row) => row.agent.output_tokens)),
      avg_tool_calls: round(average(armRows.map((row) => row.agent.tool_calls)), 2),
      avg_elapsed_ms: Math.round(average(armRows.map((row) => row.agent.elapsed_ms))),
    };
  });
  return { case_id: caseId, by_arm: byArm };
}

function printSummary(summary: { by_arm: ArmSummary[] }): void {
  console.log("\n=== Summary ===");
  for (const arm of summary.by_arm) {
    const rate = arm.pass_rate === null ? "n/a" : `${(arm.pass_rate * 100).toFixed(1)}%`;
    console.log(
      `  ${arm.arm.padEnd(14)} pass ${arm.pass_count}/${arm.judged} (${rate})  ` +
        `avg_tokens=${arm.avg_total_tokens ?? "?"}  avg_tools=${arm.avg_tool_calls}  avg_ms=${arm.avg_elapsed_ms}`,
    );
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return Math.round(average(present));
}

function selectQueries(queries: Query[], args: Args): Query[] {
  let selected = queries;
  if (args.queryIds !== undefined) {
    const byId = new Map(queries.map((query) => [query.id, query]));
    selected = args.queryIds.map((id) => {
      const query = byId.get(id);
      if (query === undefined) throw new Error(`Query ${id} not found in dataset.`);
      return query;
    });
  }
  return args.limit === undefined ? selected : selected.slice(0, args.limit);
}

function resolveJudge(args: Args): Judge | undefined {
  const openAiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Explicit --judge wins; otherwise prefer OpenAI when its key is present, else fall
  // back to Anthropic so an ANTHROPIC_API_KEY alone is enough to get judged results.
  const provider: JudgeProvider | undefined =
    args.judgeProvider ?? (openAiKey ? "openai" : anthropicKey ? "anthropic" : undefined);
  if (provider === undefined) return undefined;

  if (provider === "anthropic") {
    if (!anthropicKey) throw new Error("--judge anthropic requires ANTHROPIC_API_KEY.");
    const model = args.judgeModel ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    return { provider, apiKey: anthropicKey, model };
  }

  if (!openAiKey) throw new Error("--judge openai requires OPENAI_API_KEY.");
  const model = args.judgeModel ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
  return { provider, apiKey: openAiKey, model };
}

function parseArgs(argv: string[]): Args {
  return {
    arms: parseArms(valueAfter(argv, "--arms")),
    engine: parseEngine(valueAfter(argv, "--agent")),
    agentModel: valueAfter(argv, "--agent-model"),
    judgeProvider: parseJudgeProvider(valueAfter(argv, "--judge")),
    judgeModel: valueAfter(argv, "--judge-model"),
    embedding: parseEmbedding(valueAfter(argv, "--embedding")),
    queryIds: parseList(valueAfter(argv, "--queries")),
    limit: parseOptionalPositiveInteger(valueAfter(argv, "--limit"), "--limit"),
  };
}

function parseEngine(value: string | undefined): Engine {
  if (value === undefined || value.trim().length === 0) return "codex";
  if (value === "codex" || value === "claude") return value;
  throw new Error("--agent must be codex or claude");
}

function parseJudgeProvider(value: string | undefined): JudgeProvider | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (value === "openai" || value === "anthropic") return value;
  throw new Error("--judge must be openai or anthropic");
}

function parseArms(value: string | undefined): Arm[] {
  if (value === undefined || value.trim().length === 0) return ALL_ARMS;
  const arms = value.split(",").map((arm) => arm.trim()).filter(Boolean);
  for (const arm of arms) {
    if (!ALL_ARMS.includes(arm as Arm)) {
      throw new Error(`--arms must be a comma list of: ${ALL_ARMS.join(", ")}`);
    }
  }
  return arms as Arm[];
}

function parseEmbedding(value: string | undefined): "local" | "openai" {
  if (value === undefined || value.trim().length === 0) return "local";
  if (value === "local" || value === "openai") return value;
  throw new Error("--embedding must be local or openai");
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseOptionalPositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
