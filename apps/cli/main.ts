#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createLocalKnowledgeGraphService, KnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import type { KnowledgeGraphService as KnowledgeGraphServiceType, RepoRef } from "../../libs/knowledge-graph/service.js";
import { envVarSource, loadRepoEnv, type LoadedRepoEnv } from "../../libs/env/load-local-env.js";
import {
  ensureGreplicaConfig,
  greplicaConfigPath,
  type EmbeddingConfig,
  type GreplicaConfig,
} from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { createEmbedder } from "../../libs/knowledge-graph/graph-context/embedder.js";
import { compactGraphContextResult, renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
import { buildGraphFolderExport } from "../../libs/knowledge-graph/folder-export.js";
import { installGreplica, platformDisplayName } from "../../libs/install/install.js";
import { allPlatformInstallers } from "../../libs/install/platforms/index.js";
import type { InstallEmbedding, InstallPlatform } from "../../libs/install/paths.js";
import { hookCwd, hookEventName, hookSessionId, hookTranscriptPath, readHookInput } from "../../libs/hooks/hook-input.js";
import { HookSessionStore } from "../../libs/hooks/session-state.js";
import { runHookWorker, startHookWorker } from "../../libs/hooks/worker.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { SqliteRepository as SqliteKnowledgeGraphRepository } from "../../libs/storage/sqlite/repository.js";
import { detectRepoContext } from "./repo-context.js";

interface CommandContext {
  repo: RepoRef;
  env: LoadedRepoEnv;
  config: GreplicaConfig;
  service: KnowledgeGraphServiceType;
}

async function main(argv: string[]): Promise<void> {
  const [area, action, ...rest] = argv;

  if (area === "install") {
    const options = parseInstallArgs([action, ...rest].filter((arg): arg is string => arg !== undefined));
    const result = await installGreplica({
      ...options,
      repo: detectRepoContext(),
    });
    printInstallResult(result);
    return;
  }

  if (area === "hook" && action === "ingest") {
    runHookIngest(rest);
    return;
  }

  if (area === "hook" && action === "worker") {
    await runHookWorker();
    return;
  }

  if (area === "session" && action === "mark-memory-current") {
    runSessionMarkMemoryCurrent(rest);
    return;
  }

  if (area === "config") {
    runConfigCommand([action, ...rest].filter((arg): arg is string => arg !== undefined));
    return;
  }

  if (area === "doctor") {
    await runDoctor([action, ...rest].filter((arg): arg is string => arg !== undefined));
    return;
  }

  if (area === "graph" && action === "read") {
    const { repo, service } = createCommandContext();
    const graph = service.readGraph(repo);
    console.log("Current graph view: main + working");
    printSection("Components", graph.components, (item) => `${named(item)} ${anchor(item)}`.trim());
    printSection("Flows", graph.flows, named);
    printSection("Claims", graph.claims, (item) => `${field(item, "kind")}: ${field(item, "text")}`);
    printSection("Sources", graph.sources, (item) => `${field(item, "kind")}: ${field(item, "title") || field(item, "ref")}`);
    printSection("Edges", graph.edges, (item) => `${field(item, "from_type")}:${field(item, "from_id")} -[${field(item, "kind")}]-> ${field(item, "to_type")}:${field(item, "to_id")}`);
    return;
  }

  if (area === "graph" && action === "context") {
    const output = parseGraphContextOutput(rest);
    const query = rest.filter((arg) => arg !== "--json" && arg !== "--debug").join(" ").trim();
    if (query.length === 0) throw new Error(`Usage: greplica graph ${action} <query>`);
    const { repo, service } = createCommandContext();
    const result = await service.contextGraph(repo, query);
    if (output === "debug") {
      console.log(JSON.stringify(result, null, 2));
    } else if (output === "json") {
      console.log(JSON.stringify(compactGraphContextResult(result), null, 2));
    } else {
      console.log(renderGraphContextMarkdown(result));
    }
    return;
  }

  if (area === "graph" && action === "export") {
    const outputDir = requireFile(rest[0], "Usage: greplica graph export <dir>");
    const { repo, service } = createCommandContext();
    const files = buildGraphFolderExport(service.readGraph(repo));
    writeGraphFolderExport(outputDir, files);
    console.log(`Exported current graph view to ${outputDir}`);
    console.log(`Files: ${files.length}`);
    return;
  }

  if (area === "graph" && action === "view") {
    const options = parseGraphViewArgs(rest);
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
    return;
  }

  if (area === "proposal" && action === "validate") {
    const file = requireFile(rest[0], "Usage: greplica proposal validate <file>");
    const { repo, service } = createCommandContext();
    const proposal = readProposal(file);
    const result = service.validateProposal(repo, proposal);
    if (result.valid) {
      console.log("Proposal is valid.");
      return;
    }
    console.log("Proposal is invalid:");
    for (const error of result.errors) console.log(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  if (area === "proposal" && action === "apply") {
    const file = requireFile(rest[0], "Usage: greplica proposal apply <file>");
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
    return;
  }

  printHelp();
  process.exitCode = area === undefined ? 0 : 1;
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
  const stdin = isatty(0) ? "" : readFileSync(0, "utf8");
  const hook = readHookInput(stdin);
  const eventName = hookEventName(hook);
  const cwd = hookCwd(hook) ?? process.cwd();
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
      transcriptPath: hookTranscriptPath(hook),
      cwd,
      eventName,
    });
    startHookWorker();

    if (!result.shouldInjectGuidance) return;
    const additionalContext =
      `${greplicaContextMarker}: greplica is a repo-memory search tool for finding relevant architecture, decisions, flows, and code anchors. Before broad manual exploration in this repository, run greplica graph context "<question>" with a focused natural-language query. When Greplica provides useful context, mention that you used it and briefly say what it helped with.`;
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      }),
    );
  } finally {
    db.close();
  }
}

const greplicaContextMarker = "Greplica hook guidance";

function runSessionMarkMemoryCurrent(args: string[]): void {
  const sessionRef = parseRequiredOption(args, "--session-ref", "Usage: greplica session mark-memory-current --session-ref <ref>");
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
  throw new Error("Usage: greplica hook ingest --platform codex|claude");
}

function parseHookPlatform(value: string | undefined): InstallPlatform {
  if (value === "codex" || value === "claude") return value;
  throw new Error("Usage: greplica hook ingest --platform codex|claude");
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
  if (args.length > 0) throw new Error("Usage: greplica config");

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
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${installUsage()}`);
      platform = parseInstallPlatform(requireFlagValue(args, index, "--platform"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${installUsage()}`);
      platform = parseInstallPlatform(arg.slice("--platform=".length));
      continue;
    }
    if (arg === "--embedding") {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${installUsage()}`);
      embedding = parseInstallEmbedding(requireFlagValue(args, index, "--embedding"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--embedding=")) {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${installUsage()}`);
      embedding = parseInstallEmbedding(arg.slice("--embedding=".length));
      continue;
    }
    throw new Error(installUsage());
  }

  if (platform === undefined || embedding === undefined) throw new Error(installUsage());
  return { platform, embedding };
}

function requireFlagValue(args: string[], index: number, flag: string, usage = installUsage()): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${usage}`);
  return value;
}

function parseInstallPlatform(value: string): InstallPlatform {
  if (value === "codex" || value === "claude" || value === "opencode" || value === "cursor") return value;
  throw new Error(`Invalid --platform ${value}.\n${installUsage()}`);
}

function parseInstallEmbedding(value: string): InstallEmbedding {
  if (value === "local" || value === "openai") return value;
  throw new Error(`Invalid --embedding ${value}.\n${installUsage()}`);
}

function printInstallResult(result: Awaited<ReturnType<typeof installGreplica>>): void {
  console.log(`Installed Greplica for ${platformDisplayName(result.platform)}.`);
  console.log("");
  if (result.skills.length > 0) {
    console.log("Skills:");
    for (const skill of result.skills) console.log(`- ${skill}`);
    console.log("");
  }
  if (result.hooks !== undefined) {
    console.log("Hooks:");
    console.log(`- events: ${result.hooks.events.join(", ")}`);
    console.log(`- command: ${result.hooks.command}`);
    for (const configFile of result.hooks.configFiles) console.log(`- config: ${configFile}`);
    console.log("- note: your agent may ask you to trust or accept these hooks the next time it starts.");
    console.log("");
  }
  if (result.rules !== undefined) {
    console.log("Project rules:");
    for (const configFile of result.rules.configFiles) console.log(`- ${configFile}`);
    console.log("- note: reload your editor if the new project rule does not appear immediately.");
    console.log("");
  }
  console.log("Embedding:");
  console.log(`- ${result.embedding}`);
  console.log(`- config: ${result.configFile}`);
  console.log(`- database: ${result.databasePath}`);
  console.log(`- session stop threshold: ${result.session.stopThreshold}`);
  console.log(`- session time threshold: ${result.session.timeThresholdMinutes} minutes`);
  console.log(`- session current grace: ${result.session.currentGraceMinutes} minutes`);
  console.log("");
  console.log("Next steps:");
  console.log("- Restart your coding agent if the new skills or hooks do not appear immediately.");
  if (result.hooks !== undefined) {
    console.log("- Accept or trust the installed hooks if your agent asks. Hook dispatchers ignore repos where greplica install was not run.");
    console.log("- Hooks record session activity and attempt background working-memory updates for this repo.");
    console.log("- If you do not accept the hooks, background saves will not run; manually ask the agent to use greplica-update-working-memory near the end of useful sessions.");
  } else {
    console.log("- Hooks were not installed for this platform. Manually ask the agent to use greplica-update-working-memory near the end of useful sessions.");
  }
  console.log("- Add a short AGENTS.md/CLAUDE.md instruction if hooks are unavailable or not accepted: use greplica graph context \"<question>\" before broad manual exploration.");
  console.log("- Ask the agent to use greplica-bootstrap once for repos that do not have memory yet.");
  console.log("- During work, the agent can run greplica graph context \"<question>\" to fetch relevant repo memory.");
  if (result.embedding === "local") {
    console.log(`- OpenAI embeddings are also available if you want better retrieval quality later: greplica install --platform ${result.platform} --embedding openai`);
  } else {
    console.log(`- Local embeddings are also available if you want to switch back later: greplica install --platform ${result.platform} --embedding local`);
  }
  for (const note of result.notes) console.log(`- ${note}`);
}

function installUsage(): string {
  const cli = basename(process.argv[1] ?? "greplica");
  return `Usage: ${cli} install --platform <platform> --embedding local|openai`;
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

function parseGraphContextOutput(args: string[]): "markdown" | "json" | "debug" {
  const json = args.includes("--json");
  const debug = args.includes("--debug");
  if (json && debug) throw new Error("Use either --json or --debug, not both.");
  if (debug) return "debug";
  if (json) return "json";
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
      outputPath = resolve(requireFlagValue(args, index, "--out", graphViewUsage()));
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outputPath = resolve(arg.slice("--out=".length));
      continue;
    }
    throw new Error(graphViewUsage());
  }

  return { outputPath, noOpen };
}

function graphViewUsage(): string {
  const cli = basename(process.argv[1] ?? "greplica");
  return `Usage: ${cli} graph view [--out <file>] [--no-open]`;
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

function printHelp(): void {
  const cli = basename(process.argv[1] ?? "greplica");
  console.log(`Usage:
  ${cli} install --platform <platform> --embedding local|openai
  ${cli} config
  ${cli} doctor [--check-embeddings]
  ${cli} graph read
  ${cli} graph context <query> [--json|--debug]
  ${cli} graph export <dir>
  ${cli} graph view [--out <file>] [--no-open]
  ${cli} session mark-memory-current --session-ref <ref>
  ${cli} proposal validate <file>
  ${cli} proposal apply <file>`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
