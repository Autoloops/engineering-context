import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultWorkbenchDir,
  option,
  parseArgs,
  readJson,
  readTask,
  repoRawDirFor,
  stableId,
  taskDirFor,
  titleCase,
  writeJson,
} from "./lib.js";

interface SymbolRecord {
  file: string;
  name: string;
  symbol: string;
  start_line: number;
  end_line: number;
}

interface SymbolsFile {
  symbols: SymbolRecord[];
}

interface FileList {
  files: Array<{ path: string; bytes: number }>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const task = readTask(taskDir);
  const rawRepoDir = join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit);
  const symbols = readJson<SymbolsFile>(join(rawRepoDir, "symbols.json")).symbols;
  const fileList = readJson<FileList>(join(rawRepoDir, "file-list.json")).files;
  const symbolIndex = new SymbolIndex(symbols);

  const topDirs = new Set(
    fileList
      .map((file) => file.path.split("/"))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0])
      .filter((part): part is string => part !== undefined),
  );
  const componentDefs = [
    ["component.command_layer", "Command layer", "command"],
    ["component.api_layer", "API layer", "api"],
    ["component.repo_context", "Repository context", "context"],
    ["component.git_integration", "Git integration", "git"],
    ["component.output_utils", "Output utilities", "utils"],
    ["component.auth", "Authentication", "auth"],
    ["component.update", "Update checks", "update"],
  ] as const;
  const components = componentDefs
    .filter(([, , dir]) => topDirs.has(dir))
    .map(([id, name, dir]) => ({ id, name, code_anchor: dir }));

  const fallbackComponents = [...topDirs]
    .filter((dir) => !components.some((component) => component.code_anchor === dir))
    .filter((dir) => !dir.startsWith(".") && dir !== "test" && dir !== "script")
    .slice(0, Math.max(0, 8 - components.length))
    .map((dir) => ({ id: stableId("component", dir), name: titleCase(dir), code_anchor: dir }));

  const allComponents = [...components, ...fallbackComponents];
  const flows = [
    { id: "flow.command_dispatch", name: "Command dispatch", touches: presentIds(allComponents, ["component.command_layer"]) },
    { id: "flow.pull_request_commands", name: "Pull request commands", touches: presentIds(allComponents, ["component.command_layer", "component.api_layer", "component.output_utils"]) },
    { id: "flow.issue_commands", name: "Issue commands", touches: presentIds(allComponents, ["component.command_layer", "component.api_layer", "component.output_utils"]) },
    { id: "flow.repository_resolution", name: "Repository resolution", touches: presentIds(allComponents, ["component.repo_context", "component.git_integration"]) },
  ].filter((flow) => flow.touches.length > 0);

  const claims = [
    claim(
      "claim.command_root_entrypoint",
      "The command layer defines the root gh command, global flags, API client setup, and base repository resolution.",
      ["component.command_layer", "flow.command_dispatch", "flow.repository_resolution"],
      symbolIndex.anchors([
        ["command/root.go", "BasicClient"],
        ["command/root.go", "determineBaseRepo"],
      ]),
    ),
    claim(
      "claim.pull_request_status_and_list_commands",
      "Pull request status and list behavior are implemented by separate command handlers in the pull request command module.",
      ["component.command_layer", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["command/pr.go", "prStatus"],
        ["command/pr.go", "prList"],
      ]),
    ),
    claim(
      "claim.pull_request_view_and_selector",
      "Pull request view resolves user selectors through the pull request argument parser before opening or rendering a pull request.",
      ["component.command_layer", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["command/pr.go", "prView"],
        ["command/pr.go", "prFromArg"],
      ]),
    ),
    claim(
      "claim.pull_request_terminal_rendering",
      "Pull request terminal rendering is implemented by the pull request table printing helper.",
      ["component.command_layer", "component.output_utils", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["command/pr.go", "printPrs"],
      ]),
    ),
    claim(
      "claim.issue_status_and_list_commands",
      "Issue status and list behavior are implemented by separate command handlers in the issue command module.",
      ["component.command_layer", "flow.issue_commands"],
      symbolIndex.anchors([
        ["command/issue.go", "issueList"],
        ["command/issue.go", "issueStatus"],
      ]),
    ),
    claim(
      "claim.issue_view_and_selector",
      "Issue view resolves user selectors through the issue argument parser before opening or rendering an issue.",
      ["component.command_layer", "flow.issue_commands"],
      symbolIndex.anchors([
        ["command/issue.go", "issueView"],
        ["command/issue.go", "issueFromArg"],
      ]),
    ),
    claim(
      "claim.issue_creation_command",
      "Issue creation has a dedicated command handler separate from issue list, status, and view.",
      ["component.command_layer", "flow.issue_commands"],
      symbolIndex.anchors([
        ["command/issue.go", "issueCreate"],
      ]),
    ),
    claim(
      "claim.issue_terminal_rendering",
      "Issue terminal rendering is implemented by the issue table printing helper.",
      ["component.command_layer", "component.output_utils", "flow.issue_commands"],
      symbolIndex.anchors([
        ["command/issue.go", "printIssues"],
      ]),
    ),
    claim(
      "claim.pull_request_api_queries",
      "Pull request API models and GraphQL query helpers live in the pull request API query module.",
      ["component.api_layer", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["api/queries_pr.go", "PullRequests"],
        ["api/queries_pr.go", "PullRequestByNumber"],
        ["api/queries_pr.go", "PullRequestList"],
      ]),
    ),
    claim(
      "claim.issue_api_queries",
      "Issue API models and GraphQL query helpers live in the issue API query module.",
      ["component.api_layer", "flow.issue_commands"],
      symbolIndex.anchors([
        ["api/queries_issue.go", "IssueList"],
        ["api/queries_issue.go", "IssueByNumber"],
      ]),
    ),
    claim(
      "claim.table_output_rendering",
      "Tabular terminal and TSV output are centralized in the table printer utility, including field rendering and truncation behavior.",
      ["component.output_utils", "flow.pull_request_commands", "flow.issue_commands"],
      symbolIndex.anchors([
        ["utils/table_printer.go", "NewTablePrinter"],
        ["utils/table_printer.go", "truncate"],
      ]),
    ),
    claim(
      "claim.pr_create_flow",
      "Pull request creation has a dedicated command path for collecting title/body input, validating repository state, and creating a PR through the API layer.",
      ["component.command_layer", "component.api_layer", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["command/pr_create.go", "prCreate"],
        ["api/queries_pr.go", "CreatePullRequest"],
      ]),
    ),
    claim(
      "claim.pr_checkout_flow",
      "Pull request checkout is implemented separately from PR list/view/status and handles branch and remote checkout behavior.",
      ["component.command_layer", "component.git_integration", "flow.pull_request_commands"],
      symbolIndex.anchors([
        ["command/pr_checkout.go", "prCheckout"],
      ]),
    ),
  ].filter((item) => item.code_anchors.length > 0 && item.about.length > 0);

  const proposal = {
    title: `Bootstrap ${task.repo} at ${task.base_commit.slice(0, 7)}`,
    summary: "Deterministic repo bootstrap generated from the base checkout file layout and symbol table.",
    creates: {
      components: allComponents,
      flows,
      claims,
    },
  };

  const proposalPath = join(taskDir, "proposals", "010-bootstrap.proposal.json");
  writeJson(proposalPath, proposal);
  writeProposalManifest(taskDir);
  console.log(`Generated bootstrap proposal: ${proposalPath}`);
  console.log(`Components: ${allComponents.length}`);
  console.log(`Flows: ${flows.length}`);
  console.log(`Claims: ${claims.length}`);
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: generate-bootstrap-proposal --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

function claim(id: string, text: string, about: string[], code_anchors: Array<{ file: string; symbol?: string }>) {
  return {
    id,
    kind: "fact",
    text,
    truth: "code_verified",
    intent: "intended",
    about,
    code_anchors,
  };
}

function presentIds(components: Array<{ id: string }>, ids: string[]): string[] {
  const present = new Set(components.map((component) => component.id));
  return ids.filter((id) => present.has(id));
}

class SymbolIndex {
  private readonly byFileAndName = new Set<string>();

  constructor(symbols: SymbolRecord[]) {
    for (const symbol of symbols) {
      this.byFileAndName.add(`${symbol.file}#${symbol.name}`);
      this.byFileAndName.add(`${symbol.file}#${symbol.symbol}`);
    }
  }

  anchors(input: Array<[string, string]>): Array<{ file: string; symbol: string }> {
    return input
      .filter(([file, symbol]) => this.byFileAndName.has(`${file}#${symbol}`))
      .map(([file, symbol]) => ({ file, symbol }));
  }
}

function writeProposalManifest(taskDir: string): void {
  const proposalsDir = join(taskDir, "proposals");
  const files = ["010-bootstrap.proposal.json"].filter((file) => existsSync(join(proposalsDir, file)));
  writeJson(join(proposalsDir, "manifest.json"), {
    apply_order: files,
    generated_at: new Date().toISOString(),
  });
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
