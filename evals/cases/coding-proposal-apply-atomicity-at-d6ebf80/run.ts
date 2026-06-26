import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  run,
  runOrThrow,
  timestamp,
  valueAfter,
  writeJson,
} from "../../lib/common.js";
import { runCodexAgent } from "../../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

const caseId = "coding-proposal-apply-atomicity-at-d6ebf80";
const baseCommit = "d6ebf80298990fba01f94eb99804dd9e36a1606f";

type Arm = "control" | "greplica";

interface Args {
  arm: Arm;
  agent?: "codex";
  agentModel?: string;
}

interface RunContext {
  repoRoot: string;
  fixtureDir: string;
  runDir: string;
  targetRepoDir: string;
  targetRepoUrl: string;
  agentGreplicaHomeDir: string;
  verificationGreplicaHomeDir: string;
  memorySeedPaths: string[];
  verificationScriptPath: string;
  verificationResultPath: string;
  navigationGreplicaCommand: string[];
}

interface EvalResult {
  case_id: string;
  arm: Arm;
  target_repo_url: string;
  base_commit: string;
  run_dir: string;
  target_repo_dir: string;
  agent_greplica_home_dir: string;
  verification_greplica_home_dir: string;
  memory_seed_paths: string[];
  navigation_greplica_command: string[];
  verification_result_path: string;
  success: boolean;
  correctness: {
    passed_checks: number;
    total_checks: number;
    ratio: number;
  };
  setup_commands: CommandResult[];
  generation?: AgentRunResult;
  verification_commands: CommandResult[];
  checks: CheckResult[];
}

interface CheckResult {
  id: string;
  passed: boolean;
  details: string[];
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const context = prepareRun();

  prepareTargetRepo(context);
  prepareGreplicaHomes(context);

  const setupCommands = [
    runSetupCommand(["npm", "install"], context.targetRepoDir),
    runSetupCommand(["npm", "run", "build"], context.targetRepoDir),
  ];

  const setupSucceeded = setupCommands.every((command) => command.exit_code === 0);
  if (setupSucceeded && args.arm === "greplica") setupCommands.push(...seedAgentMemory(context));

  const generation = setupCommands.every((command) => command.exit_code === 0)
    ? await runCodingAgent(context, args)
    : undefined;

  const verificationCommands: CommandResult[] = [];
  if (generation?.exit_code === 0) {
    verificationCommands.push(runVerificationCommand(["npm", "run", "build"], context.targetRepoDir));
    if (verificationCommands.every((command) => command.exit_code === 0)) {
      verificationCommands.push(runCandidateVerificationScript(context));
    }
  }

  const checks = runChecks(context, verificationCommands);
  const passedChecks = checks.filter((check) => check.passed).length;
  const success =
    setupCommands.every((command) => command.exit_code === 0) &&
    generation?.exit_code === 0 &&
    verificationCommands.every((command) => command.exit_code === 0) &&
    passedChecks === checks.length;

  writeResult(context, args, setupCommands, generation, verificationCommands, checks, success);

  console.log(success ? "Coding proposal apply atomicity eval passed." : "Coding proposal apply atomicity eval failed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Correctness: ${passedChecks}/${checks.length}`);
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const fixtureDir = resolve(repoRoot, "evals/cases/coding-proposal-apply-atomicity-at-d6ebf80");
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  const targetRepoDir = resolve(runDir, "target-repo");
  const targetRepoUrl = process.env.GREPLICA_EVAL_TARGET_REPO_URL ?? repoRoot;

  mkdirSync(runDir, { recursive: true });

  return {
    repoRoot,
    fixtureDir,
    runDir,
    targetRepoDir,
    targetRepoUrl,
    agentGreplicaHomeDir: resolve(runDir, "agent-greplica-home"),
    verificationGreplicaHomeDir: resolve(runDir, "verification-greplica-home"),
    memorySeedPaths: [
      resolve(fixtureDir, "seed-01-bootstrap.proposal.json"),
      resolve(fixtureDir, "seed-02-update-working-memory-2026-06-03.proposal.json"),
      resolve(fixtureDir, "seed-03-eval-scoring.proposal.json"),
      resolve(fixtureDir, "seed-04-eval-design.proposal.json"),
    ],
    verificationScriptPath: resolve(targetRepoDir, ".eval/check-proposal-apply-atomicity.mjs"),
    verificationResultPath: resolve(runDir, "verification-result.json"),
    navigationGreplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

function prepareTargetRepo(context: RunContext): void {
  runOrThrow(["git", "clone", context.targetRepoUrl, context.targetRepoDir], context.repoRoot);
  runOrThrow(["git", "checkout", baseCommit], context.targetRepoDir);
  installVerificationScript(context);
}

function installVerificationScript(context: RunContext): void {
  const evalDir = resolve(context.targetRepoDir, ".eval");
  mkdirSync(evalDir, { recursive: true });
  copyFileSync(resolve(context.fixtureDir, "check-proposal-apply-atomicity.mjs"), context.verificationScriptPath);
}

function prepareGreplicaHomes(context: RunContext): void {
  mkdirSync(context.agentGreplicaHomeDir, { recursive: true });
  mkdirSync(context.verificationGreplicaHomeDir, { recursive: true });
}

function seedAgentMemory(context: RunContext): CommandResult[] {
  return context.memorySeedPaths.flatMap((seedPath) => [
    runGreplicaCommand(context.navigationGreplicaCommand, context.targetRepoDir, context.agentGreplicaHomeDir, "proposal", "validate", seedPath),
    runGreplicaCommand(context.navigationGreplicaCommand, context.targetRepoDir, context.agentGreplicaHomeDir, "proposal", "apply", seedPath),
  ]);
}

async function runCodingAgent(context: RunContext, args: Args): Promise<AgentRunResult> {
  if (args.agent !== "codex") throw new Error("Only --agent codex is supported.");

  const model = args.agentModel ?? "gpt-5.4-mini";
  return runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, GREPLICA_HOME: context.agentGreplicaHomeDir },
    model,
    prompt: buildPrompt(context, args.arm),
    transcriptPath: resolve(context.runDir, "agent-events.jsonl"),
    finalMessagePath: resolve(context.runDir, "agent-final-message.txt"),
  });
}

function buildPrompt(context: RunContext, arm: Arm): string {
  const taskPrompt = `Fix proposal apply atomicity.

When graph-object embedding generation fails during proposal apply, the apply should fail and leave no partial proposal data behind.

Required behavior:
- surface the embedding failure to the caller instead of reporting a successful apply
- leave no components, flows, claims, sources, edges, graph memberships, memory commits, or graph-object embeddings from the failed proposal
- preserve the existing validation behavior
- preserve successful proposal apply behavior

The cloned repo includes a deterministic verifier at:

.eval/check-proposal-apply-atomicity.mjs

The verifier imports the built service, injects a failing graph-context builder, runs a proposal apply, and checks that failed proposal writes are rolled back.`;

  if (arm === "control") {
    return `Do not use Greplica navigation/context commands or Greplica skills in this run.
You may run .eval/check-proposal-apply-atomicity.mjs because it is the deterministic verifier for the bug you are fixing.

${taskPrompt}`;
  }

  return `Before broad manual exploration, use Greplica as an external navigation tool. Use this current-workspace Greplica command while working from the cloned target repository:

${context.navigationGreplicaCommand.join(" ")} graph context "<natural-language question about the current task>"

Treat Greplica output as navigation, not final truth. Verify implementation facts against current files before editing.

${taskPrompt}`;
}

function runCandidateVerificationScript(context: RunContext): CommandResult {
  return run(
    [
      "node",
      context.verificationScriptPath,
      "--result-json",
      context.verificationResultPath,
    ],
    context.targetRepoDir,
    { ...process.env, GREPLICA_HOME: context.verificationGreplicaHomeDir },
  );
}

function runChecks(context: RunContext, verificationCommands: CommandResult[]): CheckResult[] {
  const verificationCommand = verificationCommands[verificationCommands.length - 1];
  if (verificationCommand?.exit_code !== 0 && !existsSync(context.verificationResultPath)) {
    return [
      {
        id: "verification_script",
        passed: false,
        details: ["verification script failed before writing result json"],
      },
    ];
  }

  if (!existsSync(context.verificationResultPath)) {
    return [
      {
        id: "verification_script",
        passed: false,
        details: ["verification script did not write result json"],
      },
    ];
  }

  const result = JSON.parse(readFileSync(context.verificationResultPath, "utf8")) as { checks?: CheckResult[] };
  if (!Array.isArray(result.checks)) {
    return [
      {
        id: "verification_script",
        passed: false,
        details: ["verification result json did not include checks"],
      },
    ];
  }

  return result.checks;
}

function runGreplicaCommand(command: string[], cwd: string, greplicaHomeDir: string, ...args: string[]): CommandResult {
  return run([...command, ...args], cwd, {
    ...process.env,
    GREPLICA_HOME: greplicaHomeDir,
  });
}

function runSetupCommand(command: string[], cwd: string): CommandResult {
  return run(command, cwd, process.env, { stdio: "inherit" });
}

function runVerificationCommand(command: string[], cwd: string): CommandResult {
  return run(command, cwd, process.env);
}

function writeResult(
  context: RunContext,
  args: Args,
  setupCommands: CommandResult[],
  generation: AgentRunResult | undefined,
  verificationCommands: CommandResult[],
  checks: CheckResult[],
  success: boolean,
): void {
  const passedChecks = checks.filter((check) => check.passed).length;
  const result: EvalResult = {
    case_id: caseId,
    arm: args.arm,
    target_repo_url: context.targetRepoUrl,
    base_commit: baseCommit,
    run_dir: context.runDir,
    target_repo_dir: context.targetRepoDir,
    agent_greplica_home_dir: context.agentGreplicaHomeDir,
    verification_greplica_home_dir: context.verificationGreplicaHomeDir,
    memory_seed_paths: context.memorySeedPaths,
    navigation_greplica_command: context.navigationGreplicaCommand,
    verification_result_path: context.verificationResultPath,
    success,
    correctness: {
      passed_checks: passedChecks,
      total_checks: checks.length,
      ratio: checks.length === 0 ? 0 : passedChecks / checks.length,
    },
    setup_commands: setupCommands,
    generation,
    verification_commands: verificationCommands,
    checks,
  };

  writeJson(resolve(context.runDir, "result.json"), result);
}

function parseArgs(args: string[]): Args {
  const arm = valueAfter(args, "--arm") ?? "control";
  if (arm !== "control" && arm !== "greplica") throw new Error("Expected --arm control or --arm greplica.");
  const agent = valueAfter(args, "--agent") ?? "codex";
  if (agent !== "codex") throw new Error("Only --agent codex is supported.");
  const agentModel = valueAfter(args, "--agent-model");
  return { arm, agent, agentModel };
}
