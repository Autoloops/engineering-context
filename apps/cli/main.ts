#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createLocalKnowledgeGraphService, KnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import type { ClaimAnchorAuditResult, RepoRef } from "../../libs/knowledge-graph/service.js";
import { envVarSource, loadRepoEnv, type LoadedRepoEnv } from "../../libs/env/load-local-env.js";
import {
  ensureGreplicaConfig,
  greplicaConfigPath,
  type EmbeddingConfig,
  type GreplicaConfig,
} from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { createEmbedder } from "../../libs/knowledge-graph/graph-context/embedder.js";
import { renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
import { buildGraphFolderExport } from "../../libs/knowledge-graph/folder-export.js";
import { buildTranscriptBundle } from "../../libs/session-transcript/bundle.js";
import { installGreplica, platformDisplayName } from "../../libs/install/install.js";
import { allPlatformInstallers, platformInstaller } from "../../libs/install/platforms/index.js";
import type { InstallEmbedding, InstallPlatform } from "../../libs/install/paths.js";
import { hookCwd, hookEventName, hookSessionId, hookTranscriptPath, readHookInput } from "../../libs/hooks/hook-input.js";
import { HookSessionStore } from "../../libs/hooks/session-state.js";
import { runHookWorker, startHookWorker } from "../../libs/hooks/worker.js";
import { withLocalModelLock } from "../../libs/knowledge-graph/graph-context/local-model-lock.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { SqliteRepository as SqliteKnowledgeGraphRepository } from "../../libs/storage/sqlite/repository.js";
import { detectRepoContext } from "./repo-context.js";

interface CommandContext {
  repo: RepoRef;
  env: LoadedRepoEnv;
  config: GreplicaConfig;
  service: KnowledgeGraphService;
}

type HelpMode = "query-aware";

interface CliCommand {
  key: string;
  path: readonly string[];
  usage: string;
  handler: (args: string[]) => void | Promise<void>;
  showInTopLevelHelp?: boolean;
  helpMode?: HelpMode;
}

interface CliCommandGroup {
  commands: CliCommand[];
  helpRequested: boolean;
}

const cliCommands = [
  {
    key: "install",
    path: ["install"],
    usage: "install --platform codex|claude|opencode|openhands|factory-droid --embedding local|openai",
    handler: runInstallCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "config",
    path: ["config"],
    usage: "config",
    handler: runConfigCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "doctor",
    path: ["doctor"],
    usage: "doctor [--check-embeddings]",
    handler: runDoctor,
    showInTopLevelHelp: true,
  },
  {
    key: "embeddingsPrewarm",
    path: ["embeddings", "prewarm"],
    usage: "embeddings prewarm",
    handler: runEmbeddingsPrewarm,
    showInTopLevelHelp: true,
  },
  {
    key: "graphRead",
    path: ["graph", "read"],
    usage: "graph read",
    handler: runGraphReadCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "graphContext",
    path: ["graph", "context"],
    usage: "graph context <query> [--debug]",
    handler: runGraphContextCommand,
    showInTopLevelHelp: true,
    helpMode: "query-aware",
  },
  {
    key: "graphAuditAnchors",
    path: ["graph", "audit", "anchors"],
    usage: "graph audit anchors",
    handler: runGraphAuditAnchorsCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "graphExport",
    path: ["graph", "export"],
    usage: "graph export <dir>",
    handler: runGraphExportCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "graphView",
    path: ["graph", "view"],
    usage: "graph view [--out <file>] [--no-open]",
    handler: runGraphViewCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "proposalValidate",
    path: ["proposal", "validate"],
    usage: "proposal validate <file>",
    handler: runProposalValidateCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "proposalApply",
    path: ["proposal", "apply"],
    usage: "proposal apply <file>",
    handler: runProposalApplyCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "sessionMarkMemoryCurrent",
    path: ["session", "mark-memory-current"],
    usage: "session mark-memory-current --session-ref <ref>",
    handler: runSessionMarkMemoryCurrent,
    showInTopLevelHelp: true,
  },
  {
    key: "transcriptBundle",
    path: ["transcript", "bundle"],
    usage: "transcript bundle --platform codex|claude --file <path> [--file <path>...] --out <bundle.md>",
    handler: runTranscriptBundle,
    showInTopLevelHelp: true,
  },
  {
    key: "hookIngest",
    path: ["hook", "ingest"],
    usage: "hook ingest --platform codex|claude|openhands|factory-droid",
    handler: runHookIngest,
  },
  {
    key: "hookWorker",
    path: ["hook", "worker"],
    usage: "hook worker",
    handler: runHookWorker,
  },
] as const satisfies readonly CliCommand[];

type CommandKey = (typeof cliCommands)[number]["key"];

const commandByKey = new Map(cliCommands.map((command) => [command.key, command]));
const commandsByDescendingPathLength = [...cliCommands].sort((left, right) => right.path.length - left.path.length);

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || isHelpRequest(argv[0])) {
    printTopLevelHelp();
    return;
  }

  const command = matchCommand(argv);
  if (command !== undefined) {
    const args = argv.slice(command.path.length);
    if (commandHasHelpRequest(command, args)) {
      printUsage([command]);
      return;
    }
    await command.handler(args);
    return;
  }

  const group = matchCommandGroup(argv);
  if (group !== undefined) {
    printGroupHelp(group.commands);
    process.exitCode = group.helpRequested ? 0 : 1;
    return;
  }

  printTopLevelHelp();
  process.exitCode = 1;
}

function matchCommand(argv: string[]): CliCommand | undefined {
  return commandsByDescendingPathLength.find((command) => command.path.every((part, index) => argv[index] === part));
}

function matchCommandGroup(argv: string[]): CliCommandGroup | undefined {
  const helpRequested = isHelpRequest(argv.at(-1));
  const groupPath = helpRequested ? argv.slice(0, -1) : argv;
  for (let length = groupPath.length; length > 0; length -= 1) {
    const prefix = groupPath.slice(0, length);
    const commands = commandsForGroupPath(prefix);
    if (commands.length > 0) return { commands, helpRequested };
  }
  return undefined;
}

function commandsForGroupPath(prefix: string[]): CliCommand[] {
  return cliCommands.filter((command) => command.path.length > prefix.length && prefix.every((part, index) => command.path[index] === part));
}

function commandHasHelpRequest(command: CliCommand, args: string[]): boolean {
  if (command.helpMode === "query-aware") return isQueryAwareHelpRequest(args);
  return args[0] === "help" || hasHelpFlag(args);
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

function isHelpRequest(arg: string | undefined): boolean {
  return isHelpFlag(arg) || arg === "help";
}

function hasHelpFlag(args: Array<string | undefined>): boolean {
  return args.some(isHelpFlag);
}

function isOnlyHelpFlag(args: string[]): boolean {
  return args.length === 1 && isHelpFlag(args[0]);
}

function isQueryAwareHelpRequest(args: string[]): boolean {
  const queryParts = args.filter((arg) => arg !== "--debug");
  return isOnlyHelpFlag(queryParts);
}

async function runInstallCommand(args: string[]): Promise<void> {
  const options = parseInstallArgs(args);
  const result = await installGreplica({
    ...options,
    repo: detectRepoContext(),
  });
  printInstallResult(result);
}

function runGraphReadCommand(_args: string[]): void {
  const { repo, service } = createCommandContext();
  const graph = service.readGraph(repo);
  console.log("Current graph view: main + working");
  printSection("Components", graph.components, (item) => `${named(item)} ${anchor(item)}`.trim());
  printSection("Flows", graph.flows, named);
  printSection("Claims", graph.claims, (item) => `${field(item, "kind")}: ${field(item, "text")}`);
  printSection("Sources", graph.sources, (item) => `${field(item, "kind")}: ${field(item, "title") || field(item, "ref")}`);
  printSection("Edges", graph.edges, (item) => `${field(item, "from_type")}:${field(item, "from_id")} -[${field(item, "kind")}]-> ${field(item, "to_type")}:${field(item, "to_id")}`);
}

async function runGraphContextCommand(args: string[]): Promise<void> {
  const output = parseGraphContextOutput(args);
  const query = args.filter((arg) => arg !== "--debug").join(" ").trim();
  if (query.length === 0) throw new Error(usage("graphContext"));
  const { repo, service } = createCommandContext();
  const result = await service.contextGraph(repo, query);
  if (output === "debug") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderGraphContextMarkdown(result));
  }
}

async function runGraphAuditAnchorsCommand(_args: string[]): Promise<void> {
  const { repo, service } = createCommandContext();
  const result = await service.auditCodeAnchors(repo);
  printAnchorAudit(result);
  if (anchorAuditIssueCount(result) > 0) process.exitCode = 1;
}

function runGraphExportCommand(args: string[]): void {
  const outputDir = requireFile(args[0], usage("graphExport"));
  const { repo, service } = createCommandContext();
  const files = buildGraphFolderExport(service.readGraph(repo));
  writeGraphFolderExport(outputDir, files);
  console.log(`Exported current graph view to ${outputDir}`);
  console.log(`Files: ${files.length}`);
}

function runGraphViewCommand(args: string[]): void {
  const options = parseGraphViewArgs(args);
  const { repo, service } = createCommandContext();
  const graph = service.readGraph(repo);
  if (graph.components.length === 0) {
    console.log("No components to visualise. Bootstrap memory first.");
    process.exitCode = 1;
    return;
  }

  const outputPath = options.outputPath ?? defaultGraphViewOutputPath(repo.repo_name);
  mkdirSync(dirname(outputPath), { recursive: true });
  const html = service.buildGraphView(repo);
  writeFileSync(outputPath, html, "utf8");
  console.log(`Wrote graph view to ${outputPath}`);

  if (!options.noOpen) {
    openInBrowser(outputPath);
  }
}

async function runProposalValidateCommand(args: string[]): Promise<void> {
  const file = requireFile(args[0], usage("proposalValidate"));
  const { repo, service } = createCommandContext();
  const proposal = readProposal(file);
  const result = await service.validateProposal(repo, proposal);
  if (result.valid) {
    console.log("Proposal is valid.");
    return;
  }
  console.log("Proposal is invalid:");
  for (const error of result.errors) console.log(`- ${error}`);
  process.exitCode = 1;
}

async function runProposalApplyCommand(args: string[]): Promise<void> {
  const file = requireFile(args[0], usage("proposalApply"));
  const { repo, service } = createCommandContext();
  const installed = service.requireRepo(repo);
  const proposal = readProposal(file);
  const result = await service.applyProposal(repo, proposal);
  console.log("Applied proposal to working memory.");
  console.log(`Memory commit: ${result.memory_commit_id}`);
  console.log(`Scope: ${result.scope_id}`);
  console.log(`Components: ${result.created.components}`);
  console.log(`Flows: ${result.created.flows}`);
  console.log(`Claims: ${result.created.claims}`);
  console.log(`Sources: ${result.created.sources}`);
  console.log(`Edges: ${result.created.edges}`);
  console.log(`Embeddings checked: ${result.embedding_status.checked_objects}`);
  console.log(`Embeddings created: ${result.embedding_status.created}`);
  console.log(`Embeddings reused: ${result.embedding_status.reused}`);
  markProposalApplyMemoryUpdated(installed.repo_id, proposal);
}

function printAnchorAudit(result: ClaimAnchorAuditResult): void {
  console.log("Code anchor audit");
  console.log("");
  printAuditSection("Missing anchors", result.missing_anchors, (issue) => issue.claim_id);
  printAuditSection("Invalid files", result.missing_files, (issue) => `${issue.claim_id} -> ${formatAuditAnchor(issue.anchor)}`);
  printAuditSection("Missing symbols", result.missing_symbols, (issue) => `${issue.claim_id} -> ${formatAuditAnchor(issue.anchor)}`);
  printAuditSection("Ambiguous symbols", result.ambiguous_symbols, (issue) => `${issue.claim_id} -> ${formatAuditAnchor(issue.anchor)}`);
  printAuditSection("Unsupported languages", result.unsupported_languages, (issue) => `${issue.claim_id} -> ${formatAuditAnchor(issue.anchor)}`);
}

function anchorAuditIssueCount(result: ClaimAnchorAuditResult): number {
  return result.missing_anchors.length +
    result.missing_files.length +
    result.missing_symbols.length +
    result.ambiguous_symbols.length +
    result.unsupported_languages.length;
}

function printAuditSection<T>(title: string, items: T[], render: (item: T) => string): void {
  console.log(`${title}:`);
  if (items.length === 0) {
    console.log("- None.");
  } else {
    for (const item of items) console.log(`- ${render(item)}`);
  }
  console.log("");
}

function formatAuditAnchor(anchor: { file: string; symbol?: string } | undefined): string {
  if (anchor === undefined) return "<missing>";
  return anchor.symbol === undefined ? anchor.file : `${anchor.file}#${anchor.symbol}`;
}

function createCommandContext(): CommandContext {
  const repo = detectRepoContext();
  const env = loadRepoEnv(repo.repo_root ?? process.cwd());
  const config = ensureGreplicaConfig();
  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
  return { repo, env, config, service };
}

function runHookIngest(args: string[]): void {
  if (process.env.GREPLICA_HOOK_DISABLE === "1") return;

  const platform = parseHookIngestPlatform(args);
  const runner = platformInstaller(platform);
  const stdin = isatty(0) ? "" : readFileSync(0, "utf8");
  const hook = readHookInput(stdin);
  const eventName = hookEventName(hook);
  const cwd = hookCwd(hook) ?? process.cwd();
  const transcriptPath = runner.transcriptPathFromHook?.(hook) ?? hookTranscriptPath(hook);
  const repo = detectRepoContext(cwd);
  const db = openDatabase();
  try {
    const repository = new SqliteKnowledgeGraphRepository(db);
    const service = new KnowledgeGraphService(repository);
    let installed: ReturnType<KnowledgeGraphService["requireRepo"]>;
    try {
      installed = service.requireRepo(repo);
    } catch {
      return;
    }
    const sessionStore = new HookSessionStore(db);
    const result = sessionStore.recordHook({
      platform,
      repoId: installed.repo_id,
      sessionId: hookSessionId(hook),
      transcriptPath,
      cwd,
      eventName,
    });
    startHookWorker();

    if (!result.shouldInjectGuidance) return;
    const additionalContext =
      `${greplicaContextMarker}: greplica is a repo-memory search tool for finding relevant architecture, decisions, flows, and code anchors. Before broad manual exploration in this repository, run greplica graph context "<question>" with a focused natural-language query. When Greplica provides useful context, mention that you used it and briefly say what it helped with.`;
    console.log(JSON.stringify(hookGuidanceOutput(platform, additionalContext)));
  } finally {
    db.close();
  }
}

// OpenHands injects via top-level additionalContext; Claude/Codex use hookSpecificOutput.
function hookGuidanceOutput(platform: InstallPlatform, additionalContext: string): Record<string, unknown> {
  if (platform === "openhands") return { additionalContext };
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

const greplicaContextMarker = "Greplica hook guidance";

function runSessionMarkMemoryCurrent(args: string[]): void {
  const sessionRef = parseRequiredOption(args, "--session-ref", usage("sessionMarkMemoryCurrent"));
  const { repo, service } = createCommandContext();
  const installed = service.requireRepo(repo);
  const db = openDatabase();
  try {
    const marked = markMemoryCurrentFromSessionRef(new HookSessionStore(db), installed.repo_id, sessionRef);
    if (marked) {
      console.log("Marked session memory current.");
      return;
    }
    console.log(`No tracked session matched ${sessionRef}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

function runTranscriptBundle(args: string[]): void {
  const options = parseTranscriptBundleArgs(args);
  const result = buildTranscriptBundle({
    platform: options.platform,
    files: options.files,
  });
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, result.markdown, "utf8");

  console.log(`Wrote transcript bundle to ${options.outputPath}`);
  console.log(`Platform: ${options.platform}`);
  console.log(`Transcripts: ${result.entries.length}`);
  console.log("Session refs:");
  for (const entry of result.entries) {
    console.log(`- ${entry.sessionRef ?? "unknown"} (${entry.file})`);
  }
}

function markProposalApplyMemoryUpdated(repoId: string, proposal: unknown): void {
  const sessionRefs = sessionRefsFromProposal(proposal);
  if (sessionRefs.length === 0) return;

  const db = openDatabase();
  try {
    const sessionStore = new HookSessionStore(db);
    for (const sessionRef of sessionRefs) markMemoryCurrentFromSessionRef(sessionStore, repoId, sessionRef);
  } finally {
    db.close();
  }
}

function markMemoryCurrentFromSessionRef(sessionStore: HookSessionStore, repoId: string, sessionRef: string): boolean {
  const identity = sessionIdentityFromSourceRef(sessionRef);
  if (identity === undefined) return false;
  return sessionStore.markMemoryCurrent({
    repoId,
    platform: identity.platform,
    sessionId: identity.sessionId,
  });
}

function sessionIdentityFromSourceRef(ref: string): { platform: InstallPlatform; sessionId: string } | undefined {
  for (const platform of allPlatformInstallers()) {
    const sessionId = platform.sessionIdFromSourceRef(ref);
    if (sessionId !== undefined && sessionId.length > 0) return { platform: platform.platform, sessionId };
  }
  return undefined;
}

function sessionRefsFromProposal(proposal: unknown): string[] {
  if (!isRecord(proposal) || !isRecord(proposal.creates) || !Array.isArray(proposal.creates.sources)) return [];
  const refs: string[] = [];
  for (const source of proposal.creates.sources) {
    if (isRecord(source) && source.kind === "session" && typeof source.ref === "string") refs.push(source.ref);
  }
  return refs;
}

function parseHookIngestPlatform(args: string[]): InstallPlatform {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") return parseHookPlatform(args[index + 1]);
    if (arg.startsWith("--platform=")) return parseHookPlatform(arg.slice("--platform=".length));
  }
  throw new Error(usage("hookIngest"));
}

function parseHookPlatform(value: string | undefined): InstallPlatform {
  if (value === "codex" || value === "claude" || value === "openhands" || value === "factory-droid") return value;
  throw new Error(usage("hookIngest"));
}

async function runDoctor(args: string[]): Promise<void> {
  let context: CommandContext;
  try {
    context = createCommandContext();
  } catch (error: unknown) {
    console.log("Repo: not detected");
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let ready = true;
  console.log("Greplica doctor");
  console.log(`Repo: ${context.repo.repo_name}`);
  console.log(`Repo root: ${context.repo.repo_root ?? ""}`);
  console.log(`Remote: ${context.repo.remote_url ?? "none"}`);
  console.log(`Default branch: ${context.repo.default_branch}`);

  try {
    const result = context.service.requireRepo(context.repo);
    console.log(`Database: ${result.database_path}`);
    console.log("Memory state: ready");
    console.log(`Main scope: ${result.main_scope_id}`);
    console.log(`Working scope: ${result.working_scope_id}`);
  } catch (error: unknown) {
    ready = false;
    const message = error instanceof Error ? error.message : String(error);
    console.log(message.startsWith("Greplica is not installed") ? "Memory state: not installed" : "Memory state: failed");
    console.log(message);
  }

  console.log(`Config: ${displayConfigPath()}`);
  printEmbeddingConfig(context.config.embedding);
  printSessionConfig(context.config.session);

  if (context.config.embedding.provider === "openai") {
    const source = envVarSource("OPENAI_API_KEY", context.env);
    if (source === undefined) {
      ready = false;
      console.log("OPENAI_API_KEY: missing");
      console.log("Set OPENAI_API_KEY in the shell, target-root .env.local, or target-root .env.");
    } else if (source.kind === "environment") {
      console.log("OPENAI_API_KEY: found in environment");
    } else {
      console.log(`OPENAI_API_KEY: found in ${source.path}`);
    }
  }

  if (args.includes("--check-embeddings") || args.includes("--check-openai")) {
    ready = (await checkEmbeddings(context.config.embedding)) && ready;
  }

  process.exitCode = ready ? 0 : 1;
}

async function runEmbeddingsPrewarm(args: string[]): Promise<void> {
  if (args.length > 0) throw new Error(usage("embeddingsPrewarm"));

  const config = ensureGreplicaConfig();
  if (config.embedding.provider === "openai") {
    console.log("Embedding provider is openai; local prewarm is not needed.");
    return;
  }

  const result = await withLocalModelLock(config.embedding, { wait: false }, () => checkEmbeddings(config.embedding));
  if (!result.acquired) {
    console.log("Local embedding prewarm is already running; skipping.");
    return;
  }
  process.exitCode = result.value === true ? 0 : 1;
}

async function checkEmbeddings(config: EmbeddingConfig): Promise<boolean> {
  try {
    console.log(`Checking ${config.provider} embeddings...`);
    const embedder = createEmbedder(config);
    await embedder.embed("greplica embeddings check");
    console.log(`${config.provider} embeddings: ok`);
    return true;
  } catch (error: unknown) {
    console.log(`${config.provider} embeddings: failed`);
    console.log(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function runConfigCommand(args: string[]): void {
  if (args.length > 0) throw new Error(usage("config"));

  const config = ensureGreplicaConfig();
  console.log("Greplica config");
  console.log(`Path: ${displayConfigPath()}`);
  console.log("");
  console.log("Edit this JSON to change Greplica defaults:");
  console.log(JSON.stringify(config, null, 2));
  console.log("");
  console.log("Allowed embedding.provider values:");
  console.log("- local");
  console.log("- openai");
  console.log("");
  console.log("Session hook settings:");
  printSessionConfig(config.session);
  console.log("- stopThreshold: run background memory update after this many Stop hooks since memory was current.");
  console.log("- timeThresholdMinutes: run after this much time if the session has activity not covered by current memory.");
  console.log("- currentGraceMinutes: skip time-based updates when memory was marked current close to last activity.");
  console.log("");
  console.log("Common embedding examples:");
  console.log("- local MPNet base: provider=local, model=all-mpnet-base-v2, dimensions=768, batchSize=16");
  console.log("- local MiniLM: provider=local, model=all-MiniLM-L6-v2, dimensions=384, batchSize=32");
  console.log("- OpenAI small: provider=openai, model=text-embedding-3-small, dimensions=1536, batchSize=100");
}

function parseInstallArgs(args: string[]): { platform: InstallPlatform; embedding: InstallEmbedding } {
  let platform: InstallPlatform | undefined;
  let embedding: InstallEmbedding | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${usage("install")}`);
      platform = parseInstallPlatform(requireFlagValue(args, index, "--platform"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${usage("install")}`);
      platform = parseInstallPlatform(arg.slice("--platform=".length));
      continue;
    }
    if (arg === "--embedding") {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${usage("install")}`);
      embedding = parseInstallEmbedding(requireFlagValue(args, index, "--embedding"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--embedding=")) {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${usage("install")}`);
      embedding = parseInstallEmbedding(arg.slice("--embedding=".length));
      continue;
    }
    throw new Error(usage("install"));
  }

  if (platform === undefined || embedding === undefined) throw new Error(usage("install"));
  return { platform, embedding };
}

interface TranscriptBundleOptions {
  platform: InstallPlatform;
  files: string[];
  outputPath: string;
}

function parseTranscriptBundleArgs(args: string[]): TranscriptBundleOptions {
  let platform: InstallPlatform | undefined;
  let outputPath: string | undefined;
  const files: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${usage("transcriptBundle")}`);
      platform = parseTranscriptBundlePlatform(requireFlagValue(args, index, "--platform", usage("transcriptBundle")));
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${usage("transcriptBundle")}`);
      platform = parseTranscriptBundlePlatform(arg.slice("--platform=".length));
      continue;
    }
    if (arg === "--file") {
      files.push(resolve(requireFlagValue(args, index, "--file", usage("transcriptBundle"))));
      index += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      files.push(resolve(arg.slice("--file=".length)));
      continue;
    }
    if (arg === "--out") {
      if (outputPath !== undefined) throw new Error(`Specify --out only once.\n${usage("transcriptBundle")}`);
      outputPath = resolve(requireFlagValue(args, index, "--out", usage("transcriptBundle")));
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      if (outputPath !== undefined) throw new Error(`Specify --out only once.\n${usage("transcriptBundle")}`);
      outputPath = resolve(arg.slice("--out=".length));
      continue;
    }
    throw new Error(usage("transcriptBundle"));
  }

  if (platform === undefined || outputPath === undefined || files.length === 0) throw new Error(usage("transcriptBundle"));
  return { platform, files, outputPath };
}

function parseTranscriptBundlePlatform(value: string): InstallPlatform {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new Error(`Invalid --platform ${value}.\n${usage("transcriptBundle")}`);
}

function requireFlagValue(args: string[], index: number, flag: string, usageText = usage("install")): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${usageText}`);
  return value;
}

function parseInstallPlatform(value: string): InstallPlatform {
  if (value === "codex" || value === "claude" || value === "opencode" || value === "openhands" || value === "factory-droid") return value;
  throw new Error(`Invalid --platform ${value}.\n${usage("install")}`);
}

function parseInstallEmbedding(value: string): InstallEmbedding {
  if (value === "local" || value === "openai") return value;
  throw new Error(`Invalid --embedding ${value}.\n${usage("install")}`);
}

function printInstallResult(result: Awaited<ReturnType<typeof installGreplica>>): void {
  console.log(`Installed Greplica for ${platformDisplayName(result.platform)}.`);
  console.log(`Skills: ${result.skills.length} installed.`);
  if (result.hooks !== undefined) {
    console.log(`Hooks: installed for ${result.hooks.events.join(", ")}.`);
  } else {
    console.log("Hooks: not installed for this platform.");
  }
  console.log(`Embedding: ${result.embedding}.`);
  console.log(`Config: ${result.configFile}`);
  console.log(`Database: ${result.databasePath}`);
  console.log("");
  console.log("Next steps:");
  console.log("- Restart your coding agent if the new skills or hooks do not appear immediately.");
  if (result.hooks !== undefined) {
    console.log("- Accept or trust the installed hooks if your agent asks.");
  } else {
    console.log("- Ask the agent to use greplica-update-working-memory near the end of useful sessions.");
  }
  console.log("- Ask the agent to use greplica-bootstrap once for repos that do not have memory yet.");
  if (result.embedding === "local") {
    console.log(`- Optional later: greplica install --platform ${result.platform} --embedding openai`);
  } else {
    console.log(`- Optional later: greplica install --platform ${result.platform} --embedding local`);
  }
  for (const note of result.notes) console.log(`- ${note}`);
}

function cliName(): string {
  return basename(process.argv[1] ?? "greplica");
}

function usage(commandKey: CommandKey): string {
  const command = commandByKey.get(commandKey);
  if (command === undefined) throw new Error(`Unknown command key: ${commandKey}`);
  return `Usage: ${cliName()} ${command.usage}`;
}

function printEmbeddingConfig(config: EmbeddingConfig): void {
  console.log(`Embedding provider: ${config.provider}`);
  console.log(`Embedding model: ${config.model}`);
  console.log(`Embedding dimensions: ${config.dimensions}`);
  console.log(`Embedding batch size: ${config.batchSize}`);
}

function printSessionConfig(config: GreplicaConfig["session"]): void {
  console.log(`Session stop threshold: ${config.stopThreshold}`);
  console.log(`Session time threshold minutes: ${config.timeThresholdMinutes}`);
  console.log(`Session current grace minutes: ${config.currentGraceMinutes}`);
}

function displayConfigPath(): string {
  return resolve(greplicaConfigPath());
}

function readProposal(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireFile(file: string | undefined, usage: string): string {
  if (file === undefined || file.trim().length === 0) throw new Error(usage);
  return file;
}

function parseRequiredOption(args: string[], name: string, usage: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return requireFile(args[index + 1], usage);
    if (arg.startsWith(`${name}=`)) return requireFile(arg.slice(name.length + 1), usage);
  }
  throw new Error(usage);
}

function parseGraphContextOutput(args: string[]): "markdown" | "debug" {
  if (args.includes("--json")) throw new Error("greplica graph context --json was removed; use Markdown output or --debug.");
  const debug = args.includes("--debug");
  if (debug) return "debug";
  return "markdown";
}

interface GraphViewOptions {
  outputPath?: string;
  noOpen: boolean;
}

function parseGraphViewArgs(args: string[]): GraphViewOptions {
  let outputPath: string | undefined;
  let noOpen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }
    if (arg === "--out") {
      outputPath = resolve(requireFlagValue(args, index, "--out", usage("graphView")));
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outputPath = resolve(arg.slice("--out=".length));
      continue;
    }
    throw new Error(usage("graphView"));
  }

  return { outputPath, noOpen };
}

function defaultGraphViewOutputPath(repoName: string): string {
  const safeName = repoName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return join(tmpdir(), `greplica-graph-${safeName}.html`);
}

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [filePath];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", filePath];
  } else {
    command = "xdg-open";
    args = [filePath];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", () => {
    console.log(`Open ${filePath} in your browser to view the graph.`);
  });
}

function writeGraphFolderExport(outputDir: string, files: Array<{ path: string; content: string }>): void {
  mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const outputPath = join(outputDir, file.path);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, file.content, "utf8");
  }
}

function printSection<T extends { id: string }>(title: string, items: T[], format: (item: T) => string): void {
  console.log(`${title}: ${items.length}`);
  for (const item of items) {
    console.log(`- ${field(item, "id")} ${format(item)}`.trim());
  }
}

function named(item: { id: string; name?: string }): string {
  return item.name ?? item.id;
}

function anchor(item: object): string {
  const record = item as Record<string, unknown>;
  return typeof record.code_anchor === "string" ? `(${record.code_anchor})` : "";
}

function field(item: object, key: string): string {
  const value = (item as Record<string, unknown>)[key];
  return value === undefined || value === null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printTopLevelHelp(): void {
  printUsage(cliCommands.filter(isShownInTopLevelHelp));
}

function isShownInTopLevelHelp(command: CliCommand): boolean {
  return command.showInTopLevelHelp === true;
}

function printGroupHelp(commands: readonly CliCommand[]): void {
  printUsage(commands);
}

function printUsage(commands: readonly CliCommand[]): void {
  const cli = cliName();
  console.log(["Usage:", ...commands.map((command) => `  ${cli} ${command.usage}`)].join("\n"));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
