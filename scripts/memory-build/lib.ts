import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface TaskManifest {
  task_id: string;
  task_index?: number;
  instance_id?: string;
  repo: string;
  repo_url: string;
  memory_remote_url?: string;
  base_commit: string;
  cutoff: string;
  target_pr_number?: number;
  target_issue_number?: number;
  target_issue_numbers?: number[];
  task_pr_url?: string;
  task_issue_url?: string;
  linked_issue_numbers?: number[];
  linked_pr_numbers?: number[];
  linked_numbers_in_problem?: number[];
  benchmark_excluded_github_numbers?: number[];
  accepted_for_apples_to_apples?: boolean;
  source_dataset_task_dir?: string;
  source_base_source_tar?: string;
  inherits_from_task?: string;
  inherits_from_package_sha256?: string;
}

export interface RepoSnapshotManifest {
  repo: string;
  repo_url: string;
  base_commit: string;
  checkout_dir: string;
  source_tar?: string;
  file_list_path: string;
  symbols_path?: string;
  file_count: number;
  collected_at: string;
}

export interface ScriptResult {
  path: string;
  summary: Record<string, unknown>;
}

export const repoRoot = findRepoRoot();
export const defaultWorkbenchDir = resolve(repoRoot, "memory-workbench");
export const defaultContextBenchDatasetDir = resolve(
  repoRoot,
  "memory-workbench/datasets/contextbench-cli-cli-retrieval-v1",
);

export function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      args.set(arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(arg, true);
      continue;
    }
    args.set(arg, next);
    index += 1;
  }
  return args;
}

export function option(args: Map<string, string | true>, name: string): string | undefined {
  const value = args.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

export function requiredOption(args: Map<string, string | true>, name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing required ${name}`);
  return value;
}

export function flag(args: Map<string, string | true>, name: string): boolean {
  return args.get(name) === true;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(path: string, values: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (values.length === 0) return;
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join("\n") + "\n", { encoding: "utf8", flag: "a" });
}

export function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

export function taskDirFor(task: TaskManifest, workbenchDir = defaultWorkbenchDir): string {
  return join(workbenchDir, "repos", repoSlug(task.repo), "tasks", task.task_id);
}

export function proposalLineageTaskDirs(taskDir: string, workbenchDir = defaultWorkbenchDir): string[] {
  const seen = new Set<string>();
  const walk = (currentTaskDir: string): string[] => {
    const resolved = resolve(currentTaskDir);
    if (seen.has(resolved)) throw new Error(`Cycle in task inheritance at ${resolved}`);
    seen.add(resolved);
    const task = readTask(resolved);
    const parentTaskId = task.inherits_from_task;
    if (parentTaskId === undefined || parentTaskId.trim().length === 0) return [resolved];
    const parentDir = taskDirFor({ ...task, task_id: parentTaskId }, workbenchDir);
    if (!existsSync(taskJsonPath(parentDir))) throw new Error(`Inherited parent task is missing: ${parentDir}`);
    return [...walk(parentDir), resolved];
  };
  return walk(taskDir);
}

export function repoRawDirFor(task: TaskManifest, workbenchDir = defaultWorkbenchDir): string {
  return join(workbenchDir, "repos", repoSlug(task.repo), "raw");
}

export function taskJsonPath(taskDir: string): string {
  return join(taskDir, "task.json");
}

export function readTask(taskDir: string): TaskManifest {
  return readJson<TaskManifest>(taskJsonPath(taskDir));
}

export function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  return readFileSync(path, "utf8");
}

export function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function packageChecksum(taskDir: string): string {
  const durableFiles = walkFiles(taskDir)
    .filter((file) => isDurableChecksumInput(taskDir, file))
    .sort();
  const hash = createHash("sha256");
  for (const file of durableFiles) {
    hash.update(relative(taskDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function copyRequiredFile(from: string, to: string): void {
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`Missing file: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export function copyRequiredDir(from: string, to: string): void {
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`Missing directory: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
}

export function memoryRemoteUrl(task: TaskManifest): string {
  return task.memory_remote_url ?? task.repo_url;
}

export function ensureBenchmarkRepoIdentity(checkoutDir: string, task: TaskManifest): void {
  if (!existsSync(join(checkoutDir, ".git"))) {
    run(["git", "init"], checkoutDir);
  }
  run(["git", "config", "remote.origin.url", memoryRemoteUrl(task)], checkoutDir);
}

export function ensureCleanDir(path: string): void {
  assertInsideWorkbench(path);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

export function run(command: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status ?? result.signal}): ${command.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

export function optionalRun(command: string[], cwd = repoRoot): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command[0] ?? "", command.slice(1), { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function walkFiles(root: string, options: { maxBytes?: number } = {}): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "vendor"]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (ignored.has(entry)) continue;
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (options.maxBytes !== undefined && stat.size > options.maxBytes) continue;
      files.push(path);
    }
  };
  walk(root);
  return files;
}

export function isBeforeCutoff(value: string | undefined, cutoff: string): boolean {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  const parsedCutoff = Date.parse(cutoff);
  return Number.isFinite(parsed) && Number.isFinite(parsedCutoff) && parsed < parsedCutoff;
}

export function isAfterCutoff(value: string | undefined, cutoff: string): boolean {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  const parsedCutoff = Date.parse(cutoff);
  return Number.isFinite(parsed) && Number.isFinite(parsedCutoff) && parsed > parsedCutoff;
}

export function excludedGithubNumbers(task: TaskManifest): Set<number> {
  const numbers = [
    task.target_pr_number,
    task.target_issue_number,
    ...(task.target_issue_numbers ?? []),
    ...(task.linked_issue_numbers ?? []),
    ...(task.linked_pr_numbers ?? []),
    ...(task.linked_numbers_in_problem ?? []),
    ...(task.benchmark_excluded_github_numbers ?? []),
    numberFromGithubUrl(task.task_pr_url),
    numberFromGithubUrl(task.task_issue_url),
  ];
  return new Set(numbers.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0));
}

export function isExcludedGithubNumber(task: TaskManifest, number: number): boolean {
  return excludedGithubNumbers(task).has(number);
}

export function excludedGithubSourceIds(task: TaskManifest): Set<string> {
  const ids = new Set<string>();
  for (const number of excludedGithubNumbers(task)) {
    ids.add(`source.github_issue_${number}`);
    ids.add(`source.github_pr_${number}`);
  }
  return ids;
}

export function proposalHasExcludedGithubSource(proposal: unknown, task: TaskManifest): boolean {
  const ids = excludedGithubSourceIds(task);
  if (ids.size === 0) return false;
  return objectContainsAnyString(proposal, ids);
}

export function extractLinkedGithubNumbersFromText(text: string): number[] {
  const numbers = new Set<number>();
  const linkedKeyword = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|address(?:e[sd])?|refs?|references?|see)`;
  const linkedPattern = new RegExp(String.raw`\b${linkedKeyword}\s+(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/)?#?(\d+)\b`, "gi");
  for (const match of text.matchAll(linkedPattern)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right);
}

function objectContainsAnyString(value: unknown, needles: Set<string>): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return needles.has(value) || [...needles].some((needle) => value.includes(needle));
  if (Array.isArray(value)) return value.some((entry) => objectContainsAnyString(entry, needles));
  if (typeof value !== "object") return false;
  return Object.values(value).some((entry) => objectContainsAnyString(entry, needles));
}

export function assertInsideWorkbench(path: string): void {
  const resolved = resolve(path);
  const workbench = resolve(defaultWorkbenchDir);
  if (resolved !== workbench && !resolved.startsWith(`${workbench}${sep}`)) {
    throw new Error(`Refusing to mutate path outside memory workbench: ${path}`);
  }
}

export function checksumManifest(taskDir: string): void {
  const files = walkFiles(taskDir)
    .filter((file) => isDurableChecksumInput(taskDir, file))
    .sort()
    .map((file) => ({
      path: relative(taskDir, file),
      sha256: sha256File(file),
      bytes: statSync(file).size,
    }));
  writeJson(join(taskDir, "checksums.json"), {
    generated_at: new Date().toISOString(),
    package_sha256: packageChecksum(taskDir),
    files,
  });
}

function isDurableChecksumInput(taskDir: string, file: string): boolean {
  const relativeParts = relative(taskDir, file).split(sep);
  if (relativeParts.includes("runtime")) return false;
  if (relativeParts.join("/") === "checksums.json") return false;
  return true;
}

function numberFromGithubUrl(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/\/(?:pull|issues)\/(\d+)(?:$|[/?#])/);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

export function writeBuildReport(taskDir: string, lines: string[]): void {
  writeText(join(taskDir, "reports", "build-summary.md"), `${lines.join("\n")}\n`);
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function findRepoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "libs"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not find repo root.");
    current = parent;
  }
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}.${value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96)}`;
}

export function basenameWithoutExt(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}
