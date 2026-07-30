import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findRepoRoot,
  readJson,
  run,
  runOrThrow,
  timestamp,
  valueAfter,
  writeJson,
} from "../lib/common.js";
import { runCodexAgent } from "../../libs/agent-runner/codex.js";
import type { AgentRunResult } from "../../libs/agent-runner/types.js";
import { loadRepoEnv } from "../../libs/env/load-local-env.js";
import {
  claudeTranscriptToMarkdown,
  extractClaudeEdits,
  type ExtractedEdits,
  type SessionSpec,
} from "./build-memory.js";

interface CaseConfig {
  case_id: string;
  dataset: {
    prior_sessions?: Array<{
      session_id: string;
      created_at?: string;
      checkpoint_id?: string;
      title?: string;
    }>;
    transcript_root?: string;
  };
  repo: {
    full_name: string;
    base_commit: string;
  };
  notes?: {
    seed_path?: string;
  };
}

interface Replay {
  spec: SessionSpec;
  transcriptMarkdownPath: string;
  edits: ExtractedEdits;
}

interface Args {
  caseId: string;
  agentModel?: string;
  runRoot?: string;
  fixtureOnly: boolean;
}

interface Context {
  repoRoot: string;
  caseDir: string;
  runDir: string;
  targetRepoDir: string;
  transcriptMarkdownDir: string;
  codexHomeDir: string;
  notesRepoPath: string;
  storedNotesPath: string;
  storedManifestPath: string;
  config: CaseConfig;
}

interface GenerationStep {
  kind: "bootstrap" | "update";
  session_id?: string;
  generation: AgentRunResult;
  notes_chars: number;
}

export async function main(argv = process.argv.slice(2), defaultCaseId?: string): Promise<void> {
  const args = parseArgs(argv, defaultCaseId);
  const context = prepareRun(args);
  const model = args.agentModel ?? "gpt-5.5";
  const replays = prepareReplayArtifacts(context);

  if (args.fixtureOnly) {
    writeJson(resolve(context.runDir, "manifest.json"), buildManifest(context, model, replays, []));
    console.log("SWE-chat notes generation fixture prep passed.");
    console.log(`Run directory: ${context.runDir}`);
    return;
  }

  await prepareTargetRepo(context);
  commitCleanRepoSnapshot(context, `repo snapshot ${context.config.repo.base_commit}`);

  const steps: GenerationStep[] = [];
  const bootstrap = await runNotesAgent(context, model, bootstrapNotesPrompt(context), "00-bootstrap");
  steps.push({ kind: "bootstrap", generation: bootstrap, notes_chars: readNotes(context).length });
  commitCleanRepoSnapshot(context, "bootstrap agent notes");

  for (const replay of replays) {
    prepareSessionOriginalWorkingTree(context, replay);
    applyPostSessionWorkingTree(context, replay);
    const label = `${String(replay.spec.index).padStart(2, "0")}-${replay.spec.sessionId.slice(0, 8)}`;
    const generation = await runNotesAgent(context, model, updateNotesPrompt(context, replay), label);
    steps.push({ kind: "update", session_id: replay.spec.sessionId, generation, notes_chars: readNotes(context).length });
    commitCleanRepoSnapshot(context, `agent notes after session ${replay.spec.sessionId}`);
  }

  const notes = readNotes(context);
  if (notes.trim().length === 0) throw new Error(`Notes generation produced an empty ${context.notesRepoPath}.`);
  mkdirSync(dirname(context.storedNotesPath), { recursive: true });
  writeFileSync(context.storedNotesPath, notes);
  const manifest = buildManifest(context, model, replays, steps, notes);
  writeJson(resolve(context.runDir, "manifest.json"), manifest);
  writeJson(context.storedManifestPath, manifest);

  console.log("SWE-chat notes generation passed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Stored notes: ${context.storedNotesPath}`);
}

function prepareRun(args: Args): Context {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const caseDir = resolve(repoRoot, "evals/cases", args.caseId);
  const config = readJson<CaseConfig>(resolve(caseDir, "case.json"));
  if (config.case_id !== args.caseId) throw new Error(`Unexpected case id in case.json: ${config.case_id}`);
  const runDir = resolve(args.runRoot ?? resolve(repoRoot, "eval-runs", timestamp(), config.case_id, "build-notes"));
  mkdirSync(runDir, { recursive: true });
  const storedNotesPath = resolve(caseDir, config.notes?.seed_path ?? "notes-seeds/agent-notes.md");
  return {
    repoRoot,
    caseDir,
    runDir,
    targetRepoDir: resolve(runDir, "target-repo"),
    transcriptMarkdownDir: resolve(runDir, "transcripts"),
    codexHomeDir: resolve(runDir, "notes-codex-home"),
    notesRepoPath: "docs/agent-notes.md",
    storedNotesPath,
    storedManifestPath: resolve(dirname(storedNotesPath), "manifest.json"),
    config,
  };
}

function prepareReplayArtifacts(context: Context): Replay[] {
  mkdirSync(context.transcriptMarkdownDir, { recursive: true });
  return sessionSpecs(context).map((spec) => {
    const transcriptPath = resolve(
      context.repoRoot,
      context.config.dataset.transcript_root ?? ".context/swechat-data/transcripts",
      `${spec.sessionId}.jsonl`,
    );
    if (!existsSync(transcriptPath)) throw new Error(`Missing transcript: ${transcriptPath}`);
    const transcript = readFileSync(transcriptPath, "utf8");
    const transcriptMarkdownPath = resolve(
      context.transcriptMarkdownDir,
      `${String(spec.index).padStart(2, "0")}-${spec.sessionId.slice(0, 8)}.messages.md`,
    );
    writeFileSync(transcriptMarkdownPath, claudeTranscriptToMarkdown(transcript, spec));
    const edits = extractClaudeEdits(transcript, repoName(context.config.repo.full_name));
    if (edits.files.length === 0) edits.warnings.push("no successful file edits reconstructed; replay is transcript-only");
    return { spec, transcriptMarkdownPath, edits };
  });
}

function sessionSpecs(context: Context): SessionSpec[] {
  const sessions = context.config.dataset.prior_sessions ?? [];
  if (sessions.length === 0) throw new Error(`Case ${context.config.case_id} has no prior sessions for notes generation.`);
  return sessions.map((session, index) => ({
    index: index + 1,
    sessionId: session.session_id,
    createdAt: session.created_at ?? "",
    checkpointId: session.checkpoint_id ?? "",
    title: session.title ?? "",
  }));
}

async function prepareTargetRepo(context: Context): Promise<void> {
  rmSync(context.targetRepoDir, { recursive: true, force: true });
  const archivePath = resolve(context.runDir, "base-source.tar.gz");
  const extractDir = resolve(context.runDir, "base-source");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const response = await fetch(`https://codeload.github.com/${context.config.repo.full_name}/tar.gz/${context.config.repo.base_commit}`);
  if (!response.ok) throw new Error(`Failed to download base archive: ${response.status} ${response.statusText}`);
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  // Run tar from the run directory with relative paths: GNU tar interprets
  // absolute Windows paths ("C:\...") as remote host specs and fails.
  const extract = run(["tar", "-xzf", relative(context.runDir, archivePath), "-C", relative(context.runDir, extractDir)], context.runDir, process.env);
  if (extract.exit_code !== 0) throw new Error(`Failed to extract base archive: ${extract.stderr ?? extract.stdout ?? ""}`);
  const roots = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) throw new Error(`Expected one archive root in ${extractDir}, found ${roots.length}`);
  renameSync(resolve(extractDir, roots[0]?.name ?? ""), context.targetRepoDir);
  runOrThrow(["git", "init", "-q"], context.targetRepoDir);
  runOrThrow(["git", "remote", "add", "origin", `swechat-eval://${context.config.repo.full_name}`], context.targetRepoDir);
}

function commitCleanRepoSnapshot(context: Context, message: string): void {
  runOrThrow(["git", "add", "-A"], context.targetRepoDir);
  runOrThrow(
    ["git", "-c", "user.email=swechat-notes@example.invalid", "-c", "user.name=SWE-chat Notes Replay", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", message],
    context.targetRepoDir,
  );
}

function prepareSessionOriginalWorkingTree(context: Context, replay: Replay): void {
  run(["git", "reset", "--hard"], context.targetRepoDir, process.env);
  run(["git", "clean", "-fd"], context.targetRepoDir, process.env);
  for (const file of replay.edits.files) writeRepoFile(context.targetRepoDir, file.path, file.original);
  commitCleanRepoSnapshot(context, `original session file state ${replay.spec.sessionId}`);
}

function applyPostSessionWorkingTree(context: Context, replay: Replay): void {
  for (const file of replay.edits.files) writeRepoFile(context.targetRepoDir, file.path, file.final);
}

async function runNotesAgent(context: Context, model: string, prompt: string, label: string): Promise<AgentRunResult> {
  mkdirSync(context.codexHomeDir, { recursive: true });
  const result = await runCodexAgent({
    cwd: context.targetRepoDir,
    env: { ...process.env, CODEX_HOME: context.codexHomeDir },
    model,
    prompt,
    transcriptPath: resolve(context.runDir, `${label}-agent-events.jsonl`),
    finalMessagePath: resolve(context.runDir, `${label}-final-message.txt`),
  });
  if (result.exit_code !== 0) throw new Error(`Notes agent failed for ${label} with exit code ${String(result.exit_code)}.`);
  if (readNotes(context).trim().length === 0) throw new Error(`Notes agent did not write ${context.notesRepoPath} for ${label}.`);
  return result;
}

function bootstrapNotesPrompt(context: Context): string {
  return `You are preparing repository notes for future coding agents.

Task: explore this repository and create ${context.notesRepoPath} (create the docs directory if it is missing) - a single Markdown file of durable engineering notes that a future agent should read before starting a task here.

Guidelines:
- Capture repo identity, the major components and where they live, key workflows and commands, and important constraints or gotchas.
- Prefer concrete facts with file paths over vague prose.
- Keep the file shallow and navigation-focused, not an exhaustive inventory.
- Do not modify any file other than ${context.notesRepoPath}. Do not commit.
- Do not use git history, the network, or any external tool.

This is a full ${context.config.repo.full_name} checkout at the benchmark base snapshot.`;
}

function updateNotesPrompt(context: Context, replay: Replay): string {
  const changeFact = replay.edits.files.length > 0
    ? "The historical session's code changes have already been applied to this working tree as uncommitted changes."
    : "No code edits were reconstructed for this historical session; treat it as transcript-only evidence and do not invent a patch.";
  return `You are updating repository notes after a completed coding session.

${context.notesRepoPath} contains notes from earlier sessions. The transcript of a historical coding session on this repository is at:
${replay.transcriptMarkdownPath}

${changeFact}

Task: read the transcript and update ${context.notesRepoPath} with the durable learnings from this session that a future agent should know - decisions, constraints, gotchas, corrected assumptions, and where the relevant code lives.

Guidelines:
- Edit and reorganize the notes freely, but keep them in this single file.
- Keep existing notes that are still true; correct anything the session proved wrong.
- Prefer concrete facts with file paths over session narration.
- Do not modify any file other than ${context.notesRepoPath}. Do not commit.
- Do not use git history, the network, or any external tool.`;
}

function readNotes(context: Context): string {
  try {
    return readFileSync(resolve(context.targetRepoDir, context.notesRepoPath), "utf8");
  } catch {
    return "";
  }
}

function buildManifest(context: Context, model: string, replays: Replay[], steps: GenerationStep[], notes?: string) {
  const chars = notes?.length ?? 0;
  return {
    case_id: context.config.case_id,
    notes_path: relativeSeedPath(context),
    model,
    generated_at: new Date().toISOString(),
    sessions: replays.map((replay) => ({ session_id: replay.spec.sessionId, title: replay.spec.title })),
    steps: steps.map((step) => ({
      kind: step.kind,
      session_id: step.session_id,
      notes_chars: step.notes_chars,
      total_tokens: step.generation.total_tokens,
      tool_calls: step.generation.tool_calls,
    })),
    stats: {
      notes_chars: chars,
      notes_estimated_tokens: Math.ceil(chars / 4),
    },
  };
}

function relativeSeedPath(context: Context): string {
  return context.config.notes?.seed_path ?? "notes-seeds/agent-notes.md";
}

function repoName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

function writeRepoFile(repoDir: string, path: string, content: string): void {
  const fullPath = resolve(repoDir, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function parseArgs(argv: string[], defaultCaseId?: string): Args {
  const caseId = valueAfter(argv, "--case") ?? defaultCaseId;
  if (!caseId) throw new Error("Usage: swechat-plan build-notes --case <case-id>");
  return {
    caseId,
    agentModel: valueAfter(argv, "--agent-model"),
    runRoot: valueAfter(argv, "--run-root"),
    fixtureOnly: argv.includes("--fixture-only"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
