import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommandResult,
  findRepoRoot,
  git,
  readJson,
  round,
  run,
  timestamp,
  valueAfter,
  writeJson,
} from "../lib/common.js";
import { runCodexAgent } from "../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../libs/env/load-local-env.js";

type RunnerName = "baseline" | "greplica" | "docs";
type JudgeKey =
  | "is_actionable_engineering_plan"
  | "identifies_relevant_systems"
  | "captures_likely_root_cause"
  | "uses_contextual_facts_correctly"
  | "proposes_narrow_fix_direction"
  | "includes_targeted_tests_or_validation"
  | "keeps_plan_focused"
  | "does_not_attempt_code_changes"
  | "introduces_no_obvious_false_root_cause";

interface CaseConfig {
  case_id: string;
  dataset: {
    name: string;
    held_out_session_id: string;
    held_out_created_at?: string;
    checkpoint_id?: string;
  };
  repo: {
    full_name: string;
    url: string;
    base_commit: string;
  };
  task: {
    prompt_path: string;
    judge_path: string;
    expected_relevant_areas?: string[];
  };
  memory?: {
    manifest_path?: string;
  };
}

interface Args {
  caseId: string;
  runner: RunnerName;
  agentModel?: string;
  judgeModel?: string;
  runRoot?: string;
  fixtureOnly: boolean;
}

interface RunContext {
  repoRoot: string;
  caseDir: string;
  runDir: string;
  targetRepoDir: string;
  guardDir: string;
  greplicaHomeDir: string;
  codexHomeDir: string;
  docsMemoryDir: string;
  docsMemoryStatsPath: string;
  transcriptPath: string;
  finalPlanPath: string;
  judgeInputPath: string;
  judgeChecksPath: string;
  scorePath: string;
  prompt: string;
  judgeGuidance: string;
  config: CaseConfig;
  greplicaCommand: string[];
}

interface TranscriptAudit {
  tainted: boolean;
  violations: string[];
  first_command?: string;
  first_greplica_command?: string;
  greplica_context_commands?: string[];
  greplica_first_navigation_used?: boolean;
  first_docs_memory_command?: string;
  docs_memory_commands?: string[];
  docs_memory_first_navigation_used?: boolean;
}

interface DocsMemoryStats {
  directory: string;
  exported_file_count: number;
  exported_markdown_chars: number;
  exported_markdown_estimated_tokens: number;
  raw_proposal_chars: number;
  raw_proposal_estimated_tokens: number;
  largest_files: Array<{ path: string; chars: number }>;
}

interface JudgeChecks extends Record<JudgeKey, boolean> {
  evidence: Record<JudgeKey, string>;
  explanation: string;
}

const judgeKeys: JudgeKey[] = [
  "is_actionable_engineering_plan",
  "identifies_relevant_systems",
  "captures_likely_root_cause",
  "uses_contextual_facts_correctly",
  "proposes_narrow_fix_direction",
  "includes_targeted_tests_or_validation",
  "keeps_plan_focused",
  "does_not_attempt_code_changes",
  "introduces_no_obvious_false_root_cause",
];

export async function main(argv = process.argv.slice(2), defaultCaseId?: string): Promise<void> {
  const args = parseArgs(argv, defaultCaseId);
  const context = prepareRun(args);
  const setupCommands = await prepareTargetRepo(context);
  const fixturePrep = verifyFixture(context);

  if (args.fixtureOnly) {
    writeJson(resolve(context.runDir, "result.json"), {
      case_id: context.config.case_id,
      runner: args.runner,
      success: true,
      run_dir: context.runDir,
      target_repo_dir: context.targetRepoDir,
      setup_commands: setupCommands,
      fixture_prep: fixturePrep,
    });
    console.log("Fixture prep passed.");
    console.log(`Run directory: ${context.runDir}`);
    return;
  }

  const seedCommands = args.runner === "greplica" || args.runner === "docs" ? seedGreplicaMemory(context) : [];
  const docsMemorySetup = args.runner === "docs" ? setupDocsMemory(context) : null;
  installToolGuards(context.guardDir, args.runner, context.greplicaCommand);
  const generation = await runPlanningAgent(context, args);
  const changedFiles = changedFilesInRepo(context.targetRepoDir);
  const repoDiff = git(context.targetRepoDir, ["diff", "--binary"]);
  const transcriptAudit = auditTranscript(context.transcriptPath, args.runner);
  if (changedFiles.length > 0) {
    transcriptAudit.tainted = true;
    transcriptAudit.violations.push(`repo_edit_detected: ${changedFiles.join(", ")}`);
  }

  const judgeInput = {
    task: {
      prompt: context.prompt,
      judge_guidance: context.judgeGuidance,
      expected_relevant_areas: context.config.task.expected_relevant_areas ?? [],
    },
    candidate: {
      final_plan: readOptional(context.finalPlanPath),
      repo_diff: repoDiff,
      changed_files: changedFiles,
    },
    transcript_audit: transcriptAudit,
    instructions: [
      "Return JSON only.",
      "Answer only the predefined boolean checks plus evidence and explanation.",
      "Do not compute or include any numeric score, pass/fail verdict, or ranking.",
      "Judge whether the final plan is useful to a real engineer, not whether it follows a rigid format.",
      "Use the case-specific judge guidance as gold facts and anti-patterns.",
      "For does_not_attempt_code_changes, code-like examples in a plan do not count by themselves; mark false only when the candidate edits files, claims to have implemented changes, or primarily outputs a patch instead of a plan.",
    ],
  };
  writeJson(context.judgeInputPath, judgeInput);
  const judgeChecks = await runOpenAiJudge(judgeInput, args.judgeModel, context.judgeChecksPath);
  const score = scoreJudgeChecks({
    judgeChecks,
    transcriptAudit,
    changedFiles,
    generation,
    estimatedCostUsd: estimateOpenAiCostUsd(args.agentModel, generation.input_tokens, generation.output_tokens),
  });
  writeJson(context.scorePath, score);

  const result = {
    case_id: context.config.case_id,
    runner: args.runner,
    success: generation.exit_code === 0 && score.passed,
    run_dir: context.runDir,
    target_repo_dir: context.targetRepoDir,
    greplica_home_dir: context.greplicaHomeDir,
    repo: context.config.repo.full_name,
    repo_url: context.config.repo.url,
    base_commit: context.config.repo.base_commit,
    held_out_session_id: context.config.dataset.held_out_session_id,
    prompt: context.prompt,
    setup_commands: setupCommands,
    seed_commands: seedCommands,
    docs_memory_setup_commands: docsMemorySetup?.commands ?? [],
    docs_memory_dir: docsMemorySetup?.stats.directory,
    docs_memory_stats_path: docsMemorySetup === null ? undefined : context.docsMemoryStatsPath,
    docs_memory_stats: docsMemorySetup?.stats,
    fixture_prep: fixturePrep,
    generation,
    final_plan_path: context.finalPlanPath,
    changed_files: changedFiles,
    transcript_audit: transcriptAudit,
    judge: {
      model: args.judgeModel ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      input_path: context.judgeInputPath,
      checks_path: context.judgeChecksPath,
      checks: judgeChecks,
    },
    score_path: context.scorePath,
    score,
  };
  writeJson(resolve(context.runDir, "result.json"), result);
  console.log(score.passed ? `SWE-chat plan ${args.runner} passed.` : `SWE-chat plan ${args.runner} failed.`);
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Score: ${score.score}`);
  process.exitCode = result.success ? 0 : 1;
}

function prepareRun(args: Args): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  if (!args.fixtureOnly && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required to run the LLM-assisted judge.");
  const caseDir = resolve(repoRoot, "evals/cases", args.caseId);
  const config = readJson<CaseConfig>(resolve(caseDir, "case.json"));
  if (config.case_id !== args.caseId) throw new Error(`Unexpected case id in case.json: ${config.case_id}`);
  const runDir = resolve(args.runRoot ?? resolve(repoRoot, "eval-runs", timestamp(), config.case_id, args.runner));
  mkdirSync(runDir, { recursive: true });
  const prompt = readFileSync(resolve(caseDir, config.task.prompt_path), "utf8").trim();
  if (!prompt) throw new Error(`Case ${config.case_id} has no prompt.`);
  const judgeGuidance = readFileSync(resolve(caseDir, config.task.judge_path), "utf8").trim();
  if (!judgeGuidance) throw new Error(`Case ${config.case_id} has no judge guidance.`);
  return {
    repoRoot,
    caseDir,
    runDir,
    targetRepoDir: resolve(runDir, "target-repo"),
    guardDir: resolve(runDir, "tool-guards"),
    greplicaHomeDir: resolve(runDir, args.runner === "greplica" || args.runner === "docs" ? "agent-greplica-home" : "baseline-empty-greplica-home"),
    codexHomeDir: resolve(runDir, "greplica-setup-codex-home"),
    docsMemoryDir: resolve(runDir, "target-repo", "greplica-memory-docs"),
    docsMemoryStatsPath: resolve(runDir, "docs-memory-stats.json"),
    transcriptPath: resolve(runDir, "agent-events.jsonl"),
    finalPlanPath: resolve(runDir, "final-plan.md"),
    judgeInputPath: resolve(runDir, "judge-input.json"),
    judgeChecksPath: resolve(runDir, "judge-checks.json"),
    scorePath: resolve(runDir, "score.json"),
    prompt,
    judgeGuidance,
    config,
    greplicaCommand: [process.execPath, resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

async function prepareTargetRepo(context: RunContext): Promise<CommandResult[]> {
  rmSync(context.targetRepoDir, { recursive: true, force: true });
  const archivePath = resolve(context.runDir, "base-source.tar.gz");
  const extractDir = resolve(context.runDir, "base-source");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const response = await fetch(`https://codeload.github.com/${context.config.repo.full_name}/tar.gz/${context.config.repo.base_commit}`);
  if (!response.ok) throw new Error(`Failed to download base archive: ${response.status} ${response.statusText}`);
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  const extract = run(["tar", "-xzf", archivePath, "-C", extractDir], context.repoRoot, process.env);
  if (extract.exit_code !== 0) throw new Error(`Failed to extract base archive: ${extract.stderr ?? extract.stdout ?? ""}`);
  const roots = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) throw new Error(`Expected one archive root in ${extractDir}, found ${roots.length}`);
  renameSync(resolve(extractDir, roots[0]?.name ?? ""), context.targetRepoDir);
  const commands = [
    run(["git", "init", "-q"], context.targetRepoDir, process.env),
    run(["git", "remote", "add", "origin", `swechat-eval://${context.config.repo.full_name}`], context.targetRepoDir, process.env),
    run(["git", "add", "-A"], context.targetRepoDir, process.env),
    run(["git", "-c", "user.email=swechat-eval@example.invalid", "-c", "user.name=SWE-chat Eval", "commit", "-q", "--no-gpg-sign", "-m", `base snapshot ${context.config.repo.base_commit}`], context.targetRepoDir, process.env),
  ];
  for (const command of commands) {
    if (command.exit_code !== 0) throw new Error(`Failed setup command: ${command.command.join(" ")}\n${command.stderr ?? command.stdout ?? ""}`);
  }
  return [extract, ...commands];
}

function verifyFixture(context: RunContext): Record<string, unknown> {
  return { base_commit: context.config.repo.base_commit };
}

function seedGreplicaMemory(context: RunContext): CommandResult[] {
  mkdirSync(context.greplicaHomeDir, { recursive: true });
  mkdirSync(context.codexHomeDir, { recursive: true });
  const manifestPath = resolve(context.caseDir, context.config.memory?.manifest_path ?? "memory-seeds/manifest.json");
  const manifest = readJson<{ apply_order: string[] }>(manifestPath);
  const seedDir = dirname(manifestPath);
  const commands = [runGreplica(context, "install", "--platform", "codex", "--embedding", "openai")];
  for (const file of manifest.apply_order) {
    const proposalPath = resolve(seedDir, file);
    if (!existsSync(proposalPath)) throw new Error(`Memory seed missing: ${proposalPath}`);
    commands.push(runGreplica(context, "proposal", "validate", proposalPath));
    commands.push(runGreplica(context, "proposal", "apply", proposalPath));
  }
  for (const command of commands) {
    if (command.exit_code !== 0) throw new Error(`Greplica seed failed: ${command.command.join(" ")}\n${command.stderr ?? command.stdout ?? ""}`);
  }
  return commands;
}

function runGreplica(context: RunContext, ...args: string[]): CommandResult {
  return run([...context.greplicaCommand, ...args], context.targetRepoDir, {
    ...process.env,
    GREPLICA_HOME: context.greplicaHomeDir,
    CODEX_HOME: context.codexHomeDir,
  });
}

function setupDocsMemory(context: RunContext): { commands: CommandResult[]; stats: DocsMemoryStats } {
  rmSync(context.docsMemoryDir, { recursive: true, force: true });
  const exportCommand = runGreplica(context, "graph", "export", context.docsMemoryDir);
  if (exportCommand.exit_code !== 0) throw new Error(`Greplica docs export failed: ${exportCommand.command.join(" ")}\n${exportCommand.stderr ?? exportCommand.stdout ?? ""}`);
  const stats = collectDocsMemoryStats(context);
  if (stats.exported_markdown_chars <= 0) throw new Error(`Docs memory export produced no Markdown content: ${context.docsMemoryDir}`);
  writeJson(context.docsMemoryStatsPath, stats);
  return { commands: [exportCommand], stats };
}

function collectDocsMemoryStats(context: RunContext): DocsMemoryStats {
  const files = listFiles(context.docsMemoryDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const content = readFileSync(join(context.docsMemoryDir, file), "utf8");
      return { path: file, chars: content.length };
    });
  const manifestPath = resolve(context.caseDir, context.config.memory?.manifest_path ?? "memory-seeds/manifest.json");
  const manifest = readJson<{ apply_order: string[] }>(manifestPath);
  const seedDir = dirname(manifestPath);
  const rawProposalChars = manifest.apply_order.reduce((sum, file) => sum + readFileSync(resolve(seedDir, file), "utf8").length, 0);
  const markdownChars = files.reduce((sum, file) => sum + file.chars, 0);
  return {
    directory: relative(context.runDir, context.docsMemoryDir),
    exported_file_count: files.length,
    exported_markdown_chars: markdownChars,
    exported_markdown_estimated_tokens: Math.ceil(markdownChars / 4),
    raw_proposal_chars: rawProposalChars,
    raw_proposal_estimated_tokens: Math.ceil(rawProposalChars / 4),
    largest_files: files.sort((left, right) => right.chars - left.chars).slice(0, 10),
  };
}

async function runPlanningAgent(context: RunContext, args: Args): Promise<AgentRunResult> {
  return runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, PATH: `${context.guardDir}:${process.env.PATH ?? ""}`, GREPLICA_HOME: context.greplicaHomeDir },
    model: args.agentModel ?? "gpt-5.4-mini",
    prompt: agentPrompt(context, args.runner),
    transcriptPath: context.transcriptPath,
    finalMessagePath: context.finalPlanPath,
  });
}

function agentPrompt(context: RunContext, runner: RunnerName): string {
  const common = `- Produce a normal user-facing engineering plan. Do not output JSON.
- Stop after the plan. Do not edit files, write patches, commit, or leave any working-tree changes.
- Do not use web search, browsers, GitHub, gh, curl, wget, package registries, remote URLs, or any other network source.
- Do not inspect git history or future repository state. Avoid git log, git show, git blame, git reflog, git fetch, git pull, tags, remotes, or branches beyond the current checked-out snapshot.
- Use only the current repository files, local search, and local read-only commands.
- The plan should be what you would send a real engineer before implementation.`;
  const navigation = runner === "greplica"
    ? `- Use Greplica as your repo memory map: first run greplica graph context "<short query from the user request>".
- Plan from the returned claims/components/flows and their anchors, treating them as remembered navigation context rather than final truth.
- Verify only the anchors needed for the plan; avoid broad repo search unless Greplica returns no useful context or the anchors are missing.
- Use only greplica graph context during the task. Do not use greplica proposal, install, doctor, graph read, bootstrap, update, or mutation/setup commands.
- Do not use CodeGraph commands.`
    : runner === "docs"
      ? `- Use the local memory docs as your repo memory map. Before broad manual exploration, search or read greplica-memory-docs/ using task terms.
- Treat the docs as navigation context, then verify only the repo files needed for the plan.
- Do not use Greplica commands.
- Do not use CodeGraph commands.`
      : `- Do not use Greplica commands or Greplica memory.
- Do not use CodeGraph commands.`;
  return `You are running a local-only planning benchmark.

Rules:
${navigation}
${common}

User request:
${context.prompt}
`;
}

function installToolGuards(guardDir: string, runner: RunnerName, greplicaCommand: string[]): void {
  mkdirSync(guardDir, { recursive: true });
  writeExecutable(resolve(guardDir, "git"), `#!/bin/sh
case "$1" in
  clone|fetch|pull|log|show|reflog|blame|bisect)
    echo "benchmark tool guard: git $1 is disabled" >&2
    exit 126
    ;;
esac
exec /usr/bin/git "$@"
`);
  for (const executable of ["gh", "curl", "wget"]) {
    writeExecutable(resolve(guardDir, executable), `#!/bin/sh
echo "benchmark tool guard: ${executable} is disabled" >&2
exit 126
`);
  }
  if (runner === "greplica") {
    writeExecutable(resolve(guardDir, "codegraph"), `#!/bin/sh
echo "benchmark tool guard: codegraph is disabled" >&2
exit 126
`);
    writeExecutable(resolve(guardDir, "greplica"), `#!/bin/sh
if [ "$1" = "graph" ] && [ "$2" = "context" ]; then
  exec ${greplicaCommand.map(shellQuote).join(" ")} "$@"
fi
echo "benchmark tool guard: only greplica graph context is allowed" >&2
exit 126
`);
    return;
  }
  writeExecutable(resolve(guardDir, "greplica"), `#!/bin/sh
echo "benchmark tool guard: greplica is disabled" >&2
exit 126
`);
  writeExecutable(resolve(guardDir, "codegraph"), `#!/bin/sh
echo "benchmark tool guard: codegraph is disabled" >&2
exit 126
`);
}

function auditTranscript(transcriptPath: string, runner: RunnerName): TranscriptAudit {
  const violations: string[] = [];
  let first_command: string | undefined;
  let first_greplica_command: string | undefined;
  const greplica_context_commands: string[] = [];
  let first_docs_memory_command: string | undefined;
  const docs_memory_commands: string[] = [];
  for (const [index, line] of readOptional(transcriptPath).split("\n").entries()) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { event = line; }
    const compact = JSON.stringify(event).toLowerCase();
    if (compact.includes('"web_search"') || compact.includes('"mcp_tool_call"') || compact.includes('"browser"')) violations.push(`line ${index + 1}: forbidden tool surface`);
    if (compact.includes(".context/swechat") || compact.includes("judge-input") || compact.includes("case.json") || compact.includes("judge.md")) violations.push(`line ${index + 1}: hidden eval artifact access`);
    for (const command of extractCommandStrings(event)) {
      first_command ??= command;
      if (commandInvokesTool(command, "greplica")) {
        first_greplica_command ??= command;
        if (/\bgreplica\s+graph\s+context\b/.test(command.toLowerCase().replace(/\s+/g, " "))) greplica_context_commands.push(command);
      }
      if (commandTouchesDocsMemory(command)) {
        first_docs_memory_command ??= command;
        docs_memory_commands.push(command);
      }
      const violation = auditCommand(command, runner);
      if (violation) violations.push(`line ${index + 1}: ${violation}: ${command}`);
    }
  }
  return {
    tainted: violations.length > 0,
    violations,
    first_command,
    first_greplica_command,
    greplica_context_commands,
    greplica_first_navigation_used: runner === "greplica" && first_command !== undefined && /\bgreplica\s+graph\s+context\b/.test(first_command.toLowerCase().replace(/\s+/g, " ")),
    first_docs_memory_command,
    docs_memory_commands,
    docs_memory_first_navigation_used: runner === "docs" && first_command !== undefined && commandTouchesDocsMemory(first_command),
  };
}

function auditCommand(command: string, runner: RunnerName): string | undefined {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  if (/(\b|^)(gh|curl|wget)(\s|$)/.test(normalized)) return "forbidden_command";
  if (commandInvokesTool(normalized, "greplica")) {
    if (runner !== "greplica") return "forbidden_greplica_command";
    if (!/\bgreplica\s+graph\s+context\b/.test(normalized)) return "forbidden_greplica_command";
    if (/\bgreplica\s+(proposal|install|doctor|init|bootstrap|update)\b/.test(normalized)) return "forbidden_greplica_mutation_or_setup";
    if (/\bgreplica\s+graph\s+read\b/.test(normalized)) return "forbidden_greplica_graph_read";
  }
  if (commandInvokesTool(normalized, "codegraph")) {
    return "forbidden_codegraph_command";
  }
  if (normalized.includes("greplica-memory-docs") && runner !== "docs") return "forbidden_docs_memory_access";
  if (/\bnpx\s+.*codegraph\b/.test(normalized) || /\bnpm\s+(exec|install)\b.*codegraph\b/.test(normalized)) return "forbidden_codegraph_registry_or_setup";
  if (/\bgit\s+(clone|fetch|pull|log|show|reflog|blame|bisect)\b/.test(normalized)) return "forbidden_git_history_or_network";
  if (normalized.includes(".context/swechat") || normalized.includes("judge-input") || normalized.includes("case.json") || normalized.includes("judge.md")) return "hidden_eval_artifact_access";
  if ((normalized.includes("http://") || normalized.includes("https://")) && /fetch\(|urlopen\(|requests\.|urllib|http\.client/.test(normalized)) return "forbidden_network_access";
  return undefined;
}

function commandTouchesDocsMemory(command: string): boolean {
  return command.toLowerCase().includes("greplica-memory-docs");
}

function commandInvokesTool(command: string, tool: "greplica" | "codegraph"): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s;&|('"\\\\/])${escaped}($|[\\s'"])`).test(command.toLowerCase().replace(/\s+/g, " "));
}

async function runOpenAiJudge(input: unknown, model: string | undefined, outputPath: string): Promise<JudgeChecks> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the SWE-chat plan judge.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      input: [
        { role: "system", content: "You are a plan-quality evaluator. Return structured JSON facts only. Never calculate a score or pass/fail verdict." },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: { format: { type: "json_schema", name: "swechat_plan_judge", strict: true, schema: judgeSchema() } },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`OpenAI judge request failed: ${JSON.stringify(body)}`);
  const checks = validateJudgeChecks(JSON.parse(extractOutputText(body)));
  writeJson(outputPath, checks);
  return checks;
}

function validateJudgeChecks(value: unknown): JudgeChecks {
  if (!isRecord(value)) throw new Error("Judge output must be a JSON object.");
  if ("score" in value || "passed" in value || "final_score" in value) throw new Error("Judge output must not include score/pass fields.");
  for (const key of judgeKeys) if (typeof value[key] !== "boolean") throw new Error(`Judge output missing boolean ${key}.`);
  if (!isRecord(value.evidence)) throw new Error("Judge output missing evidence object.");
  for (const key of judgeKeys) if (typeof value.evidence[key] !== "string" || value.evidence[key].trim().length === 0) throw new Error(`Judge output missing evidence for ${key}.`);
  if (typeof value.explanation !== "string" || value.explanation.trim().length === 0) throw new Error("Judge output missing explanation.");
  return value as unknown as JudgeChecks;
}

function scoreJudgeChecks(input: {
  judgeChecks: JudgeChecks;
  transcriptAudit: TranscriptAudit;
  changedFiles: string[];
  generation: AgentRunResult;
  estimatedCostUsd: number | null;
}) {
  const noLeakage = !input.transcriptAudit.tainted;
  const noRepoEdits = input.changedFiles.length === 0;
  const components = {
    is_actionable_engineering_plan: input.judgeChecks.is_actionable_engineering_plan ? 12 : 0,
    identifies_relevant_systems: input.judgeChecks.identifies_relevant_systems ? 12 : 0,
    captures_likely_root_cause: input.judgeChecks.captures_likely_root_cause ? 18 : 0,
    uses_contextual_facts_correctly: input.judgeChecks.uses_contextual_facts_correctly ? 16 : 0,
    proposes_narrow_fix_direction: input.judgeChecks.proposes_narrow_fix_direction ? 14 : 0,
    includes_targeted_tests_or_validation: input.judgeChecks.includes_targeted_tests_or_validation ? 10 : 0,
    keeps_plan_focused: input.judgeChecks.keeps_plan_focused ? 6 : 0,
    does_not_attempt_code_changes: input.judgeChecks.does_not_attempt_code_changes && noRepoEdits ? 12 : 0,
    obvious_false_root_cause_penalty: input.judgeChecks.introduces_no_obvious_false_root_cause ? 0 : -40,
  };
  const score = Math.max(0, Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0)));
  return {
    score,
    passed: score >= 80 && noLeakage && noRepoEdits,
    no_leakage: noLeakage,
    no_repo_edits: noRepoEdits,
    audit_violations: input.transcriptAudit.violations,
    correctness_per_cost: {
      total_tokens: input.generation.total_tokens,
      tool_calls: input.generation.tool_calls,
      elapsed_seconds: input.generation.elapsed_ms === null ? null : round(input.generation.elapsed_ms / 1000, 3),
      estimated_cost_usd: input.estimatedCostUsd,
    },
    changed_files: input.changedFiles,
    components,
  };
}

function judgeSchema(): Record<string, unknown> {
  const evidenceProperties = Object.fromEntries(judgeKeys.map((key) => [key, { type: "string" }]));
  return {
    type: "object",
    additionalProperties: false,
    required: [...judgeKeys, "evidence", "explanation"],
    properties: {
      ...Object.fromEntries(judgeKeys.map((key) => [key, { type: "boolean" }])),
      evidence: { type: "object", additionalProperties: false, required: judgeKeys, properties: evidenceProperties },
      explanation: { type: "string" },
    },
  };
}

function extractCommandStrings(value: unknown): string[] {
  const commands: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if ((key === "command" || key === "cmd") && typeof child === "string") commands.push(child);
      else visit(child);
    }
  };
  visit(value);
  return commands;
}

function changedFilesInRepo(targetRepoDir: string): string[] {
  return git(targetRepoDir, ["diff", "--name-only"]).split("\n").map((line) => line.trim()).filter(Boolean);
}

function estimateOpenAiCostUsd(model: string | undefined, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  const inputOverride = Number(process.env.EVAL_AGENT_INPUT_USD_PER_MTOK);
  const outputOverride = Number(process.env.EVAL_AGENT_OUTPUT_USD_PER_MTOK);
  const rates = Number.isFinite(inputOverride) && inputOverride > 0 && Number.isFinite(outputOverride) && outputOverride > 0
    ? { input: inputOverride, output: outputOverride }
    : (model ?? "").toLowerCase().includes("gpt-5.5")
      ? { input: 1.25, output: 10 }
      : null;
  return rates === null ? null : round((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output, 4);
}

function extractOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) throw new Error(`OpenAI response missing output text: ${JSON.stringify(body)}`);
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (isRecord(content) && typeof content.text === "string") return content.text;
  }
  throw new Error(`OpenAI response missing output text: ${JSON.stringify(body)}`);
}

function parseArgs(argv: string[], defaultCaseId?: string): Args {
  const caseId = valueAfter(argv, "--case") ?? defaultCaseId;
  if (!caseId) throw new Error("Usage: swechat-plan run --case <case-id> --runner baseline|greplica|docs");
  const runner = valueAfter(argv, "--runner") ?? "baseline";
  if (runner !== "baseline" && runner !== "greplica" && runner !== "docs") throw new Error("Only --runner baseline|greplica|docs is supported.");
  return {
    caseId,
    runner,
    agentModel: valueAfter(argv, "--agent-model"),
    judgeModel: valueAfter(argv, "--judge-model"),
    runRoot: valueAfter(argv, "--run-root"),
    fixtureOnly: argv.includes("--fixture-only"),
  };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readOptional(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function listFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, fullPath));
    else if (entry.isFile()) files.push(relative(root, fullPath));
  }
  return files.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
