#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ClaimAnchorAuditResult, RepoRef } from "../../libs/knowledge-graph/service.js";
import { envVarSource, loadRepoEnv, type LoadedRepoEnv } from "../../libs/env/load-local-env.js";
import {
  ensureGreplicaConfig,
  greplicaConfigPath,
  type EmbeddingConfig,
  type GreplicaConfig,
} from "../../libs/config/greplica-config.js";
import { createGraphMemoryProvider } from "../../libs/knowledge-graph/provider-factory.js";
import type { GraphMemoryProvider } from "../../libs/knowledge-graph/provider.js";
import type {
  ManagedGraphView,
  ManagedMemoryPr,
  ManagedMemoryStatus,
  ManagedProposal,
} from "../../libs/managed/protocol.js";
import { createEmbedder } from "../../libs/knowledge-graph/graph-context/embedder.js";
import { renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
import { buildGraphFolderExport } from "../../libs/knowledge-graph/folder-export.js";
import { buildTranscriptBundle } from "../../libs/session-transcript/bundle.js";
import { installGreplica, platformDisplayName } from "../../libs/install/install.js";
import { allPlatformInstallers, platformInstaller } from "../../libs/install/platforms/index.js";
import { installPlatforms, installPlatformUsage } from "../../libs/install/paths.js";
import type { InstallEmbedding, InstallPlatform } from "../../libs/install/paths.js";
import { hookCwd, hookEventName, hookSessionId, hookTranscriptPath, readHookInput } from "../../libs/hooks/hook-input.js";
import { greplicaHookGuidance } from "../../libs/hooks/guidance.js";
import { createLocalAgentRuntimeStore, type LocalAgentRuntimeStore } from "../../libs/hooks/runtime-store.js";
import { runHookWorker, shouldRunAutoMemoryUpdates, startHookWorker } from "../../libs/hooks/worker.js";
import { withLocalModelLock } from "../../libs/knowledge-graph/graph-context/local-model-lock.js";
import { defaultDatabasePath, openDatabase } from "../../libs/storage/sqlite/db.js";
import { RepoInstallationStore } from "../../libs/install/repo-installation-store.js";
import { detectRepoContext } from "./repo-context.js";
import {
  resolveManagedInstall,
  runInviteAccept,
  runInviteList,
  runInviteRevoke,
  runLogin,
  runLogout,
  runOrgCreate,
  runOrgInvite,
  runOrgLeave,
  runOrgList,
  runOrgMembers,
  runOrgRemoveMember,
  runOrgRole,
  runRepoAccessDecision,
  runRepoAccessList,
  runRepoAccessRequest,
  runRepoArchive,
  runRepoConnect,
  runRepoCreate,
  runRepoDiscovery,
  runRepoEnrollGithub,
  runRepoGithubInstall,
  runRepoGrantMemoryAdmin,
  runRepoGrantContributor,
  runRepoInviteContributor,
  runRepoInviteReader,
  runRepoInviteLinkCreate,
  runRepoInviteLinkList,
  runRepoInviteLinkRevoke,
  runRepoLinkGithub,
  runRepoList,
  runRepoPublish,
  runRepoRestore,
  runRepoRevokeMemoryAdmin,
  runRepoRevokeContributor,
  runWhoami,
} from "./managed-cli.js";
import { runMemoryReconcile } from "./reconcile-cli.js";

interface CommandContext {
  repo: RepoRef;
  env: LoadedRepoEnv;
  config: GreplicaConfig;
  service: GraphMemoryProvider;
}

type CommandContextProvider = () => CommandContext;
type CommandContextHandler = (args: string[], getContext: CommandContextProvider) => void | Promise<void>;

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
    usage: `install [--mode local|managed] [--platform ${installPlatformUsage}] [--embedding local|openai] [--managed-repo <id> | --invite-link <url>] [--hooks enabled|disabled] [--auto-memory enabled|disabled]`,
    handler: runInstallCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "uninstall",
    path: ["uninstall"],
    usage: "uninstall",
    handler: runUninstallCommand,
    showInTopLevelHelp: true,
  },
  {
    key: "repoStatus",
    path: ["repo", "status"],
    usage: "repo status",
    handler: runRepoStatusCommand,
    showInTopLevelHelp: true,
  },
  { key: "login", path: ["login"], usage: "login [--api-url <url>]", handler: runLogin, showInTopLevelHelp: true },
  { key: "logout", path: ["logout"], usage: "logout", handler: runLogout, showInTopLevelHelp: true },
  { key: "whoami", path: ["whoami"], usage: "whoami", handler: runWhoami, showInTopLevelHelp: true },
  { key: "orgCreate", path: ["org", "create"], usage: "org create --name <name> [--slug <slug>]", handler: runOrgCreate, showInTopLevelHelp: true },
  { key: "orgList", path: ["org", "list"], usage: "org list", handler: runOrgList, showInTopLevelHelp: true },
  { key: "orgInvite", path: ["org", "invite"], usage: "org invite --org <id> --github-user <login>", handler: runOrgInvite, showInTopLevelHelp: true },
  { key: "orgMembers", path: ["org", "members"], usage: "org members --org <id>", handler: runOrgMembers, showInTopLevelHelp: true },
  { key: "orgRole", path: ["org", "role"], usage: "org role --org <id> --user <id> --role admin|member|guest", handler: runOrgRole, showInTopLevelHelp: true },
  { key: "orgRemoveMember", path: ["org", "remove-member"], usage: "org remove-member --org <id> --user <id>", handler: runOrgRemoveMember, showInTopLevelHelp: true },
  { key: "orgLeave", path: ["org", "leave"], usage: "org leave --org <id>", handler: runOrgLeave, showInTopLevelHelp: true },
  { key: "inviteList", path: ["invite", "list"], usage: "invite list", handler: runInviteList, showInTopLevelHelp: true },
  { key: "inviteAccept", path: ["invite", "accept"], usage: "invite accept <id>", handler: runInviteAccept, showInTopLevelHelp: true },
  { key: "inviteRevoke", path: ["invite", "revoke"], usage: "invite revoke <id>", handler: runInviteRevoke, showInTopLevelHelp: true },
  { key: "repoCreate", path: ["repo", "create"], usage: "repo create --org <id> --name <name>", handler: runRepoCreate, showInTopLevelHelp: true },
  { key: "repoList", path: ["repo", "list"], usage: "repo list", handler: runRepoList, showInTopLevelHelp: true },
  { key: "repoConnect", path: ["repo", "connect"], usage: "repo connect --managed-repo <id> [--confirm-mode-switch] [--confirm-rebind]", handler: runRepoConnect, showInTopLevelHelp: true },
  { key: "repoRebind", path: ["repo", "rebind"], usage: "repo rebind --managed-repo <id> --confirm-rebind", handler: runRepoConnect, showInTopLevelHelp: true },
  { key: "repoGithubInstall", path: ["repo", "github-install"], usage: "repo github-install", handler: runRepoGithubInstall, showInTopLevelHelp: true },
  { key: "repoEnrollGithub", path: ["repo", "enroll-github"], usage: "repo enroll-github --org <id> --installation <id> --github-repo <id> [--name <name>]", handler: runRepoEnrollGithub, showInTopLevelHelp: true },
  { key: "repoLinkGithub", path: ["repo", "link-github"], usage: "repo link-github --installation <id> --github-repo <id>", handler: runRepoLinkGithub, showInTopLevelHelp: true },
  { key: "repoArchive", path: ["repo", "archive"], usage: "repo archive", handler: runRepoArchive, showInTopLevelHelp: true },
  { key: "repoRestore", path: ["repo", "restore"], usage: "repo restore", handler: runRepoRestore, showInTopLevelHelp: true },
  { key: "repoDiscovery", path: ["repo", "discovery"], usage: "repo discovery --discovery listed|unlisted", handler: runRepoDiscovery, showInTopLevelHelp: true },
  { key: "repoInviteReader", path: ["repo", "invite-reader"], usage: "repo invite-reader --github-user <login>", handler: runRepoInviteReader, showInTopLevelHelp: true },
  { key: "repoInviteContributor", path: ["repo", "invite-contributor"], usage: "repo invite-contributor --github-user <login>", handler: runRepoInviteContributor, showInTopLevelHelp: true },
  { key: "repoInviteLinkCreate", path: ["repo", "invite-link", "create"], usage: "repo invite-link create", handler: runRepoInviteLinkCreate, showInTopLevelHelp: true },
  { key: "repoInviteLinkList", path: ["repo", "invite-link", "list"], usage: "repo invite-link list", handler: runRepoInviteLinkList, showInTopLevelHelp: true },
  { key: "repoInviteLinkRevoke", path: ["repo", "invite-link", "revoke"], usage: "repo invite-link revoke --link <id>", handler: runRepoInviteLinkRevoke, showInTopLevelHelp: true },
  { key: "repoGrantMemoryAdmin", path: ["repo", "grant-memory-admin"], usage: "repo grant-memory-admin --user <id>", handler: runRepoGrantMemoryAdmin, showInTopLevelHelp: true },
  { key: "repoGrantContributor", path: ["repo", "grant-contributor"], usage: "repo grant-contributor --user <id>", handler: runRepoGrantContributor, showInTopLevelHelp: true },
  { key: "repoRevokeMemoryAdmin", path: ["repo", "revoke-memory-admin"], usage: "repo revoke-memory-admin --user <id>", handler: runRepoRevokeMemoryAdmin, showInTopLevelHelp: true },
  { key: "repoRevokeContributor", path: ["repo", "revoke-contributor"], usage: "repo revoke-contributor --user <id>", handler: runRepoRevokeContributor, showInTopLevelHelp: true },
  { key: "repoAccessRequest", path: ["repo", "request-access"], usage: "repo request-access --managed-repo <id>", handler: runRepoAccessRequest, showInTopLevelHelp: true },
  { key: "repoAccessList", path: ["repo", "access-requests"], usage: "repo access-requests", handler: runRepoAccessList, showInTopLevelHelp: true },
  { key: "repoAccessApprove", path: ["repo", "approve-access"], usage: "repo approve-access --request <id>", handler: (args) => runRepoAccessDecision(args, "approve"), showInTopLevelHelp: true },
  { key: "repoAccessDeny", path: ["repo", "deny-access"], usage: "repo deny-access --request <id>", handler: (args) => runRepoAccessDecision(args, "deny"), showInTopLevelHelp: true },
  { key: "repoPublish", path: ["repo", "publish"], usage: "repo publish --from-local", handler: runRepoPublish, showInTopLevelHelp: true },
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
    handler: withCommandContext(runDoctor),
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
    usage: "graph read [--with-working <login>...] [--memory-pr <id>] [--main-only] [--include-quarantined] [--json]",
    handler: withCommandContext(runGraphReadCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "graphContext",
    path: ["graph", "context"],
    usage: "graph context <query> [--with-working <login>...] [--memory-pr <id>] [--main-only] [--include-quarantined] [--json|--debug]",
    handler: withCommandContext(runGraphContextCommand),
    showInTopLevelHelp: true,
    helpMode: "query-aware",
  },
  {
    key: "graphAuditAnchors",
    path: ["graph", "audit", "anchors"],
    usage: "graph audit anchors",
    handler: withCommandContext(runGraphAuditAnchorsCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "graphExport",
    path: ["graph", "export"],
    usage: "graph export <dir>",
    handler: withCommandContext(runGraphExportCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "graphView",
    path: ["graph", "view"],
    usage: "graph view [--with-working <login>...] [--memory-pr <id>] [--main-only] [--include-quarantined] [--json] [--out <file>] [--no-open]",
    handler: withCommandContext(runGraphViewCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "proposalValidate",
    path: ["proposal", "validate"],
    usage: "proposal validate <file>",
    handler: withCommandContext(runProposalValidateCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "proposalApply",
    path: ["proposal", "apply"],
    usage: "proposal apply <file>",
    handler: withCommandContext(runProposalApplyCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "proposalList",
    path: ["proposal", "list"],
    usage: "proposal list [--json]",
    handler: withCommandContext(runProposalListCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "proposalShow",
    path: ["proposal", "show"],
    usage: "proposal show <id> [--json]",
    handler: withCommandContext(runProposalShowCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "memoryPrList",
    path: ["memory", "pr", "list"],
    usage: "memory pr list [--json]",
    handler: withCommandContext(runMemoryPrListCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "memoryPrShow",
    path: ["memory", "pr", "show"],
    usage: "memory pr show <id> [--json]",
    handler: withCommandContext(runMemoryPrShowCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "memoryPrContext",
    path: ["memory", "pr", "context"],
    usage: "memory pr context <id> <query> [--json]",
    handler: withCommandContext(runMemoryPrContextCommand),
    showInTopLevelHelp: true,
    helpMode: "query-aware",
  },
  {
    key: "memoryPrRetry",
    path: ["memory", "pr", "retry"],
    usage: "memory pr retry <id> [--json]",
    handler: withCommandContext(runMemoryPrRetryCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "memoryStatus",
    path: ["memory", "status"],
    usage: "memory status [--json]",
    handler: withCommandContext(runMemoryStatusCommand),
    showInTopLevelHelp: true,
  },
  {
    key: "memoryReconcile",
    path: ["memory", "reconcile"],
    usage: "memory reconcile --managed-repo <id> --merge-sha <sha> [--api-url <url>] [--oidc-audience <audience>]",
    handler: runMemoryReconcile,
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
    usage: "transcript bundle --platform codex|claude|copilot|opencode --file <path> [--file <path>...] --out <bundle.md>",
    handler: runTranscriptBundle,
    showInTopLevelHelp: true,
  },
  {
    key: "hookIngest",
    path: ["hook", "ingest"],
    usage: "hook ingest --platform codex|claude|copilot|cursor|opencode|openhands|factory-droid",
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
  const repo = detectRepoContext();
  const managed = options.mode === "managed"
    ? await resolveManagedInstall(repo, options.managedRepoId, options.inviteLink)
    : undefined;
  if (managed?.pending === true) return;
  if (options.mode === "managed" && managed?.repository === undefined) {
    throw new Error("Managed installation did not resolve a repository.");
  }
  const result = await installGreplica({
    ...options,
    repo,
    managedRepoId: managed?.repository?.id,
    managedRole: managed?.repository?.effective_role,
    managedAccessStatus: managed?.repository?.access_status,
  });
  printInstallResult(result);
}

function runUninstallCommand(args: string[]): void {
  if (args.length > 0) throw new Error(usage("uninstall"));
  const repo = detectRepoContext();
  const db = openDatabase();
  try {
    const installation = new RepoInstallationStore(db).deactivate(repo);
    console.log(`Deactivated Greplica for ${installation.repoName}.`);
    console.log("Local graph, sessions, and managed binding were preserved.");
  } finally {
    db.close();
  }
}

function runRepoStatusCommand(args: string[]): void {
  if (args.length > 0) throw new Error(usage("repoStatus"));
  const repo = detectRepoContext();
  const db = openDatabase();
  try {
    const installation = new RepoInstallationStore(db).find(repo);
    if (installation === undefined) {
      console.log("Greplica is not installed for this repository.");
      return;
    }
    console.log(`Repository: ${installation.repoName}`);
    console.log(`Key: ${installation.repoKey}`);
    console.log(`Status: ${installation.status}`);
    console.log(`Mode: ${installation.activeMode}`);
    console.log(`Hooks: ${installation.hooksEnabled ? "enabled" : "disabled"}`);
    console.log(`Automatic memory updates: ${installation.autoMemoryUpdates ? "enabled" : "disabled"}`);
    if (installation.managedRepoId !== undefined) console.log(`Managed repository: ${installation.managedRepoId}`);
    if (installation.managedRole !== undefined) console.log(`Managed role: ${installation.managedRole}`);
    if (installation.managedAccessStatus !== undefined) console.log(`Managed access: ${installation.managedAccessStatus}`);
    if (installation.managedAccessRefreshedAt !== undefined) {
      console.log(`Managed access refreshed: ${installation.managedAccessRefreshedAt}`);
    }
  } finally {
    db.close();
  }
}

async function runGraphReadCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const options = parseGraphSelectionArgs(args, new Set(["--json"]));
  if (options.remaining.length > 0) throw new Error(usage("graphRead"));
  const { service } = getContext();
  const graph = await service.readGraph(options.view);
  if (options.json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }
  console.log(`Current graph view: ${graphViewLabel(options.view)}`);
  printSection("Components", graph.components, (item) => `${named(item)} ${anchor(item)}`.trim());
  printSection("Flows", graph.flows, named);
  printSection("Claims", graph.claims, (item) => `${field(item, "kind")}: ${field(item, "text")}`);
  printSection("Sources", graph.sources, (item) => `${field(item, "kind")}: ${field(item, "title") || field(item, "ref")}`);
  printSection("Edges", graph.edges, (item) => `${field(item, "from_type")}:${field(item, "from_id")} -[${field(item, "kind")}]-> ${field(item, "to_type")}:${field(item, "to_id")}`);
}

async function runGraphContextCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const options = parseGraphSelectionArgs(args, new Set(["--json", "--debug"]));
  const output = options.json || args.includes("--debug") ? "json" : "markdown";
  const query = options.remaining.filter((arg) => arg !== "--debug").join(" ").trim();
  if (query.length === 0) throw new Error(usage("graphContext"));
  const { service } = getContext();
  const result = await service.contextGraph(query, options.view);
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderGraphContextMarkdown(result));
  }
}

async function runGraphAuditAnchorsCommand(_args: string[], getContext: CommandContextProvider): Promise<void> {
  const { service } = getContext();
  const result = await service.auditCodeAnchors();
  printAnchorAudit(result);
  if (anchorAuditIssueCount(result) > 0) process.exitCode = 1;
}

async function runGraphExportCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const outputDir = requireFile(args[0], usage("graphExport"));
  const { service } = getContext();
  const files = buildGraphFolderExport(await service.readGraph());
  writeGraphFolderExport(outputDir, files);
  console.log(`Exported current graph view to ${outputDir}`);
  console.log(`Files: ${files.length}`);
}

async function runGraphViewCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const options = parseGraphViewArgs(args);
  const { repo, service } = getContext();
  if (options.json) {
    const json = `${JSON.stringify(await service.viewData(options.view), null, 2)}\n`;
    if (options.outputPath === undefined) {
      console.log(json.trimEnd());
    } else {
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, json, "utf8");
      console.log(`Wrote graph view data to ${options.outputPath}`);
    }
    return;
  }
  const graph = await service.readGraph(options.view);
  if (graph.components.length === 0) {
    console.log("No components to visualize. Bootstrap memory first.");
    process.exitCode = 1;
    return;
  }

  const outputPath = options.outputPath ?? defaultGraphViewOutputPath(repo.repo_name);
  mkdirSync(dirname(outputPath), { recursive: true });
  const html = await service.buildGraphView(options.view);
  writeFileSync(outputPath, html, "utf8");
  console.log(`Wrote graph view to ${outputPath}`);

  if (!options.noOpen) {
    openInBrowser(outputPath);
  }
}

async function runProposalValidateCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const file = requireFile(args[0], usage("proposalValidate"));
  const { service } = getContext();
  const proposal = readProposal(file);
  const result = await service.reviewProposal(proposal);
  if (result.valid) {
    console.log("Proposal is valid.");
    for (const [claimId, matches] of Object.entries(result.duplicate_warnings)) {
      for (const match of matches) {
        console.log(
          `Warning: claim "${claimId}" is similar to existing claim "${match.claim_id}" (similarity: ${match.similarity.toFixed(4)}). Consider using supersedes instead.`,
        );
      }
    }
    return;
  }
  console.log("Proposal is invalid:");
  for (const error of result.errors) console.log(`- ${error}`);
  process.exitCode = 1;
}

async function runProposalApplyCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const file = requireFile(args[0], usage("proposalApply"));
  const { repo, service } = getContext();
  const proposal = readProposal(file);
  const result = await service.applyProposal(proposal);
  console.log("Applied proposal to working memory.");
  if (result.author !== undefined) console.log(`Author: ${result.author.github_login} (${result.author.id})`);
  if (result.proposal_id !== undefined) console.log(`Proposal: ${result.proposal_id}`);
  console.log(`Memory commit: ${result.memory_commit_id}`);
  console.log(`Scope: ${result.scope_id}`);
  if (result.working_scope_revision !== undefined) {
    console.log(`Working revision: ${result.working_scope_revision}`);
  }
  if (result.memory_commit_state !== undefined) console.log(`State: ${result.memory_commit_state}`);
  if (result.memory_pr_id !== undefined) console.log(`Memory PR: ${result.memory_pr_id}`);
  console.log(`Components: ${result.created.components}`);
  console.log(`Flows: ${result.created.flows}`);
  console.log(`Claims: ${result.created.claims}`);
  console.log(`Sources: ${result.created.sources}`);
  console.log(`Edges: ${result.created.edges}`);
  console.log(`Embeddings checked: ${result.embedding_status.checked_objects}`);
  console.log(`Embeddings created: ${result.embedding_status.created}`);
  console.log(`Embeddings reused: ${result.embedding_status.reused}`);
  markProposalApplyMemoryUpdated(repo, proposal);
}

async function runProposalListCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const json = onlyJsonFlag(args, "proposalList");
  const proposals = await getContext().service.listProposals();
  if (json) {
    console.log(JSON.stringify(proposals, null, 2));
    return;
  }
  for (const proposal of proposals) printProposalSummary(proposal);
}

async function runProposalShowCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const { positional, json } = positionalWithJson(args, "proposalShow");
  const proposal = await getContext().service.showProposal(positional);
  if (json) {
    console.log(JSON.stringify(proposal, null, 2));
    return;
  }
  printProposalSummary(proposal);
  console.log(JSON.stringify(proposal.proposal, null, 2));
}

async function runMemoryPrListCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const json = onlyJsonFlag(args, "memoryPrList");
  const memoryPrs = await getContext().service.listMemoryPrs();
  if (json) {
    console.log(JSON.stringify(memoryPrs, null, 2));
    return;
  }
  for (const memoryPr of memoryPrs) printMemoryPrSummary(memoryPr);
}

async function runMemoryPrShowCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const { positional, json } = positionalWithJson(args, "memoryPrShow");
  const memoryPr = await getContext().service.showMemoryPr(positional);
  if (json) {
    console.log(JSON.stringify(memoryPr, null, 2));
    return;
  }
  printMemoryPrSummary(memoryPr);
  printPromotionCleanup(memoryPr);
}

async function runMemoryPrContextCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const memoryPrId = positional.shift();
  const query = positional.join(" ").trim();
  if (memoryPrId === undefined || query.length === 0) throw new Error(usage("memoryPrContext"));
  const result = await getContext().service.contextGraph(query, { base: "main", memory_pr_id: memoryPrId });
  console.log(json ? JSON.stringify(result, null, 2) : renderGraphContextMarkdown(result));
}

async function runMemoryPrRetryCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const { positional, json } = positionalWithJson(args, "memoryPrRetry");
  const memoryPr = await getContext().service.retryMemoryPr(positional);
  if (json) console.log(JSON.stringify(memoryPr, null, 2));
  else {
    console.log(`Queued Memory PR ${memoryPr.id} for reconciliation.`);
    printMemoryPrSummary(memoryPr);
  }
}

async function runMemoryStatusCommand(args: string[], getContext: CommandContextProvider): Promise<void> {
  const json = onlyJsonFlag(args, "memoryStatus");
  const status = await getContext().service.memoryStatus();
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printMemoryStatus(status);
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
  const service = createGraphMemoryProvider(repo, config);
  return { repo, env, config, service };
}

function withCommandContext(handler: CommandContextHandler): CliCommand["handler"] {
  return async (args: string[]): Promise<void> => {
    let context: CommandContext | undefined;
    const getContext = (): CommandContext => {
      context ??= createCommandContext();
      return context;
    };

    try {
      await handler(args, getContext);
    } finally {
      context?.service.close();
    }
  };
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
  const config = ensureGreplicaConfig();
  const runtimeStore = createLocalAgentRuntimeStore(config.session);
  try {
    const result = runtimeStore.recordHook({
      repo,
      platform,
      sessionId: hookSessionId(hook),
      transcriptPath,
      cwd,
      eventName,
    });
    if (result === undefined) return;
    if (shouldRunAutoMemoryUpdates(result.installation)) startHookWorker();

    if (!result.shouldInjectGuidance) return;
    console.log(JSON.stringify(hookGuidanceOutput(platform, greplicaHookGuidance)));
  } finally {
    runtimeStore.close();
  }
}

// OpenHands and Copilot inject via top-level additionalContext; Claude/Codex use hookSpecificOutput.
function hookGuidanceOutput(platform: InstallPlatform, additionalContext: string): Record<string, unknown> {
  if (platform === "openhands" || platform === "copilot") return { additionalContext };
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

function runSessionMarkMemoryCurrent(args: string[]): void {
  const sessionRef = parseRequiredOption(args, "--session-ref", usage("sessionMarkMemoryCurrent"));
  const repo = detectRepoContext();
  const config = ensureGreplicaConfig();
  const runtimeStore = createLocalAgentRuntimeStore(config.session);
  try {
    const marked = markMemoryCurrentFromSessionRef(runtimeStore, repo, sessionRef);
    if (marked) {
      console.log("Marked session memory current.");
      return;
    }
    console.log(`No tracked session matched ${sessionRef}`);
    process.exitCode = 1;
  } finally {
    runtimeStore.close();
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

function markProposalApplyMemoryUpdated(repo: RepoRef, proposal: unknown): void {
  const sessionRefs = sessionRefsFromProposal(proposal);
  if (sessionRefs.length === 0) return;

  const runtimeStore = createLocalAgentRuntimeStore(ensureGreplicaConfig().session);
  try {
    for (const sessionRef of sessionRefs) markMemoryCurrentFromSessionRef(runtimeStore, repo, sessionRef);
  } finally {
    runtimeStore.close();
  }
}

function markMemoryCurrentFromSessionRef(runtimeStore: LocalAgentRuntimeStore, repo: RepoRef, sessionRef: string): boolean {
  const identity = sessionIdentityFromSourceRef(sessionRef);
  if (identity === undefined) return false;
  return runtimeStore.markMemoryCurrent(repo, identity.platform, identity.sessionId);
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
  if (value === "codex" || value === "claude" || value === "copilot" || value === "cursor" || value === "opencode" || value === "openhands" || value === "factory-droid") return value;
  throw new Error(usage("hookIngest"));
}

async function runDoctor(args: string[], getContext: CommandContextProvider): Promise<void> {
  let context: CommandContext;
  try {
    context = getContext();
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

  const installation = context.service.installation;
  console.log(`Database: ${resolve(defaultDatabasePath())}`);
  console.log("Memory state: ready");
  console.log(`Mode: ${installation.activeMode}`);
  if (installation.managedRepoId !== undefined) console.log(`Managed repository: ${installation.managedRepoId}`);
  if (installation.managedRole !== undefined) console.log(`Managed role: ${installation.managedRole}`);

  console.log(`Config: ${displayConfigPath()}`);
  if (installation.activeMode === "local") printEmbeddingConfig(context.config.embedding);
  printSessionConfig(context.config.session);

  if (installation.activeMode === "local" && context.config.embedding.provider === "openai") {
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

  if (installation.activeMode === "local" && (args.includes("--check-embeddings") || args.includes("--check-openai"))) {
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
  console.log("- hooks and automatic memory updates are configured per repository.");
  console.log(`Managed API: ${config.managed.apiUrl}`);
  console.log("");
  console.log("Common embedding examples:");
  console.log("- local MPNet base: provider=local, model=all-mpnet-base-v2, dimensions=768, batchSize=16");
  console.log("- local MiniLM: provider=local, model=all-MiniLM-L6-v2, dimensions=384, batchSize=32");
  console.log("- OpenAI small: provider=openai, model=text-embedding-3-small, dimensions=1536, batchSize=100");
}

function parseInstallArgs(args: string[]): {
  mode: "local" | "managed";
  platform?: InstallPlatform;
  embedding?: InstallEmbedding;
  managedRepoId?: string;
  inviteLink?: string;
  hooks: boolean;
  autoMemoryUpdates: boolean;
  allowModeSwitch: boolean;
  allowRebind: boolean;
} {
  let mode: "local" | "managed" = "local";
  let modeSeen = false;
  let platform: InstallPlatform | undefined;
  let embedding: InstallEmbedding | undefined;
  let managedRepoId: string | undefined;
  let inviteLink: string | undefined;
  let hooks: boolean | undefined;
  let autoMemoryUpdates: boolean | undefined;
  let allowModeSwitch = false;
  let allowRebind = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      if (modeSeen) throw new Error(`Specify --mode only once.\n${usage("install")}`);
      const value = arg === "--mode" ? requireFlagValue(args, index, "--mode") : arg.slice("--mode=".length);
      if (value !== "local" && value !== "managed") throw new Error(`Invalid --mode ${value}.\n${usage("install")}`);
      mode = value;
      modeSeen = true;
      if (arg === "--mode") index += 1;
      continue;
    }
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
    if (arg === "--managed-repo" || arg.startsWith("--managed-repo=")) {
      if (managedRepoId !== undefined) throw new Error(`Specify --managed-repo only once.\n${usage("install")}`);
      managedRepoId = arg === "--managed-repo"
        ? requireFlagValue(args, index, "--managed-repo")
        : arg.slice("--managed-repo=".length);
      if (arg === "--managed-repo") index += 1;
      continue;
    }
    if (arg === "--invite-link" || arg.startsWith("--invite-link=")) {
      if (inviteLink !== undefined) throw new Error(`Specify --invite-link only once.\n${usage("install")}`);
      inviteLink = arg === "--invite-link"
        ? requireFlagValue(args, index, "--invite-link")
        : arg.slice("--invite-link=".length);
      if (arg === "--invite-link") index += 1;
      continue;
    }
    if (arg === "--confirm-mode-switch") {
      allowModeSwitch = true;
      continue;
    }
    if (arg === "--confirm-rebind") {
      allowRebind = true;
      continue;
    }
    if (arg === "--hooks") {
      if (hooks !== undefined) throw new Error(`Specify --hooks only once.\n${usage("install")}`);
      hooks = parseEnabledFlag(requireFlagValue(args, index, "--hooks"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--hooks=")) {
      if (hooks !== undefined) throw new Error(`Specify --hooks only once.\n${usage("install")}`);
      hooks = parseEnabledFlag(arg.slice("--hooks=".length));
      continue;
    }
    if (arg === "--auto-memory") {
      if (autoMemoryUpdates !== undefined) throw new Error(`Specify --auto-memory only once.\n${usage("install")}`);
      autoMemoryUpdates = parseEnabledFlag(requireFlagValue(args, index, "--auto-memory"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--auto-memory=")) {
      if (autoMemoryUpdates !== undefined) throw new Error(`Specify --auto-memory only once.\n${usage("install")}`);
      autoMemoryUpdates = parseEnabledFlag(arg.slice("--auto-memory=".length));
      continue;
    }
    throw new Error(usage("install"));
  }

  if (inviteLink !== undefined && modeSeen && mode === "local") {
    throw new Error(`--invite-link cannot be used with --mode local.\n${usage("install")}`);
  }
  if (inviteLink !== undefined) mode = "managed";
  if (managedRepoId !== undefined && inviteLink !== undefined) {
    throw new Error(`--invite-link and --managed-repo are mutually exclusive.\n${usage("install")}`);
  }
  if (mode === "managed" && embedding !== undefined) {
    throw new Error(`Managed installations do not accept --embedding.\n${usage("install")}`);
  }
  if (mode === "local" && managedRepoId !== undefined) {
    throw new Error(`--managed-repo requires --mode managed.\n${usage("install")}`);
  }
  if (hooks === false && autoMemoryUpdates === true) {
    throw new Error(`--auto-memory enabled requires --hooks enabled.\n${usage("install")}`);
  }
  return {
    mode,
    platform,
    embedding: mode === "local" ? (embedding ?? "local") : undefined,
    managedRepoId,
    inviteLink,
    hooks: hooks ?? true,
    autoMemoryUpdates: hooks === false ? false : autoMemoryUpdates ?? true,
    allowModeSwitch: allowModeSwitch || inviteLink !== undefined,
    allowRebind,
  };
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
  if (value === "codex" || value === "claude" || value === "copilot" || value === "opencode") return value;
  throw new Error(`Invalid --platform ${value}.\n${usage("transcriptBundle")}`);
}

function requireFlagValue(args: string[], index: number, flag: string, usageText = usage("install")): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${usageText}`);
  return value;
}

function parseInstallPlatform(value: string): InstallPlatform {
  if ((installPlatforms as readonly string[]).includes(value)) return value as InstallPlatform;
  throw new Error(`Invalid --platform ${value}.\n${usage("install")}`);
}

function parseInstallEmbedding(value: string): InstallEmbedding {
  if (value === "local" || value === "openai") return value;
  throw new Error(`Invalid --embedding ${value}.\n${usage("install")}`);
}

function parseEnabledFlag(value: string): boolean {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  throw new Error(`Invalid flag value ${value}; expected enabled or disabled.\n${usage("install")}`);
}

function printInstallResult(result: Awaited<ReturnType<typeof installGreplica>>): void {
  console.log(`Installed Greplica for ${platformDisplayName(result.platform)}.`);
  console.log(`Mode: ${result.mode}.`);
  console.log(`Skills: ${result.skills.length} installed.`);
  if (result.hooks !== undefined) {
    console.log(`Hooks: installed for ${result.hooks.events.join(", ")}.`);
  } else if (result.hooksRequested) {
    console.log("Hooks: not installed for this platform.");
  } else {
    console.log("Hooks: not installed.");
  }
  if (result.rules !== undefined) {
    console.log(`Project rules: ${result.rules.configFiles.join(", ")}`);
    console.log("- note: reload your editor if the new project rule does not appear immediately.");
  }
  if (result.mode === "managed" && result.autoMemoryUpdates && result.installation.managedRole === "reader") {
    console.log("Automatic memory updates: enabled when contributor access is granted.");
  } else {
    console.log(`Automatic memory updates: ${result.autoMemoryUpdates ? "enabled" : "disabled"}.`);
  }
  if (result.embedding !== undefined) console.log(`Embedding: ${result.embedding}.`);
  if (result.installation.managedRepoId !== undefined) console.log(`Managed repository: ${result.installation.managedRepoId}.`);
  console.log(`Config: ${result.configFile}`);
  console.log(`Database: ${result.databasePath}`);
  console.log("");
  console.log("Next steps:");
  console.log("- Restart your coding agent if the new skills or hooks do not appear immediately.");
  if (result.hooks !== undefined) {
    console.log("- Accept or trust the installed hooks if your agent asks.");
  } else {
    console.log("- Ask the agent to use greplica-update-working-memory near the end of useful sessions.");
    console.log("- To give future agents Greplica guidance without hooks, add this snippet to your agent instruction file:");
    console.log("");
    console.log(greplicaHookGuidance);
    console.log("");
  }
  console.log("- Ask the agent to use greplica-bootstrap once for repos that do not have memory yet.");
  if (result.mode === "local" && result.embedding === "local") {
    console.log(`- Optional later: greplica install --platform ${result.platform} --embedding openai`);
  } else if (result.mode === "local") {
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

interface GraphViewOptions {
  outputPath?: string;
  noOpen: boolean;
  json: boolean;
  view?: ManagedGraphView;
}

function parseGraphViewArgs(args: string[]): GraphViewOptions {
  let outputPath: string | undefined;
  let noOpen = false;
  const selectionArgs: string[] = [];

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
    selectionArgs.push(arg);
  }

  const selection = parseGraphSelectionArgs(selectionArgs, new Set(["--json"]));
  if (selection.remaining.length > 0) throw new Error(usage("graphView"));
  return { outputPath, noOpen, json: selection.json, view: selection.view };
}

interface GraphSelectionArgs {
  view?: ManagedGraphView;
  json: boolean;
  remaining: string[];
}

function parseGraphSelectionArgs(args: string[], passthroughFlags: ReadonlySet<string>): GraphSelectionArgs {
  const workingUsers: string[] = [];
  let memoryPrId: string | undefined;
  let mainOnly = false;
  let includeQuarantined = false;
  let json = false;
  const remaining: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--main-only") {
      mainOnly = true;
      continue;
    }
    if (arg === "--include-quarantined") {
      includeQuarantined = true;
      continue;
    }
    if (arg === "--with-working") {
      workingUsers.push(requireFlagValue(args, index, "--with-working"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--with-working=")) {
      workingUsers.push(requireFile(arg.slice("--with-working=".length), "Missing value for --with-working."));
      continue;
    }
    if (arg === "--memory-pr") {
      if (memoryPrId !== undefined) throw new Error("Specify --memory-pr only once.");
      memoryPrId = requireFlagValue(args, index, "--memory-pr");
      index += 1;
      continue;
    }
    if (arg.startsWith("--memory-pr=")) {
      if (memoryPrId !== undefined) throw new Error("Specify --memory-pr only once.");
      memoryPrId = requireFile(arg.slice("--memory-pr=".length), "Missing value for --memory-pr.");
      continue;
    }
    if (passthroughFlags.has(arg)) {
      remaining.push(arg);
      continue;
    }
    remaining.push(arg);
  }

  if (mainOnly && (workingUsers.length > 0 || memoryPrId !== undefined || includeQuarantined)) {
    throw new Error("--main-only cannot be combined with working, Memory PR, or quarantine overlays.");
  }
  const uniqueWorkingUsers = [...new Set(workingUsers)];
  const hasView = mainOnly || uniqueWorkingUsers.length > 0 || memoryPrId !== undefined || includeQuarantined;
  const view = hasView
    ? {
        base: "main" as const,
        ...(mainOnly ? { working_users: [] } : {}),
        ...(uniqueWorkingUsers.length === 0 ? {} : { working_users: uniqueWorkingUsers }),
        ...(memoryPrId === undefined ? {} : { memory_pr_id: memoryPrId }),
        ...(includeQuarantined ? { include_quarantined: true } : {}),
      }
    : undefined;
  return { view, json, remaining };
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

function graphViewLabel(view: ManagedGraphView | undefined): string {
  if (view === undefined) return "main + working (mine)";
  const layers = ["main"];
  if (view.working_users !== undefined) {
    if (view.working_users.length > 0) layers.push("working (mine)");
    for (const user of view.working_users) layers.push(`working/${user}`);
  } else {
    layers.push("working (mine)");
  }
  if (view.memory_pr_id !== undefined) layers.push(`Memory PR ${view.memory_pr_id}`);
  if (view.include_quarantined === true) layers.push("quarantine");
  return layers.join(" + ");
}

function onlyJsonFlag(args: string[], command: CommandKey): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--json") return true;
  throw new Error(usage(command));
}

function positionalWithJson(args: string[], command: CommandKey): { positional: string; json: boolean } {
  const json = args.includes("--json");
  const positionals = args.filter((arg) => arg !== "--json");
  if (positionals.length !== 1 || positionals[0].startsWith("--")) throw new Error(usage(command));
  return { positional: positionals[0], json };
}

function printProposalSummary(proposal: ManagedProposal): void {
  const commit = proposal.memory_commit;
  const sessions = commit.session_refs.map((session) => session.id).join(",") || "-";
  console.log([
    proposal.id,
    commit.state,
    commit.author.github_login,
    commit.git?.branch ?? "-",
    commit.code_pr?.number === undefined ? "-" : `#${commit.code_pr.number}`,
    commit.memory_pr_id ?? "-",
    sessions,
  ].join("\t"));
}

function printMemoryPrSummary(memoryPr: ManagedMemoryPr): void {
  console.log([
    memoryPr.id,
    memoryPr.state,
    `code-pr:#${memoryPr.code_pr.number}`,
    memoryPr.contributor_logins.join(",") || "-",
    `${memoryPr.direct_commit_ids.length} direct`,
    `${memoryPr.dependency_commit_ids.length} dependencies`,
    memoryPr.latest_job_state ?? "-",
  ].join("\t"));
}

function printPromotionCleanup(memoryPr: ManagedMemoryPr): void {
  const promotion = memoryPr.promotion;
  if (promotion === undefined) return;
  console.log(`Main head: ${promotion.new_main_head}`);
  console.log(`Cleared commits: ${promotion.cleared_commit_ids.join(", ") || "none"}`);
  console.log(`Already canonical: ${promotion.already_canonical_commit_ids.join(", ") || "none"}`);
  console.log(`Quarantined: ${promotion.quarantined_commit_ids.join(", ") || "none"}`);
  for (const [login, cleanup] of Object.entries(promotion.cleared_by_user)) {
    console.log(
      `${login}: cleared ${cleanup.cleared_objects} objects; ${cleanup.remaining_active_objects} active working objects remain`,
    );
  }
}

function printMemoryStatus(status: ManagedMemoryStatus): void {
  console.log(`Reconciliation jobs: ${status.queued} queued, ${status.running} running, ${status.failed} failed`);
  console.log(`Last sweep: ${status.last_sweep_at ?? "never"}`);
  console.log(`Last promotion: ${status.last_promotion_at ?? "never"}`);
  console.log(`Repair attempts: ${status.repair_attempts}`);
  console.log(`Repaired commits: ${status.repaired_commits}`);
  console.log(`Promoted commits: ${status.promoted_commits}`);
  console.log(`Quarantined commits: ${status.quarantined_commits}`);
  console.log(`Cleared working commits: ${status.cleared_working_commits}`);
  console.log(`Active working commits: ${status.remaining_active_working_commits}`);
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
