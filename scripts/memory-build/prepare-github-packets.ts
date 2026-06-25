import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  defaultWorkbenchDir,
  ensureCleanDir,
  excludedGithubNumbers,
  isAfterCutoff,
  isBeforeCutoff,
  isExcludedGithubNumber,
  option,
  parseArgs,
  readTask,
  repoRawDirFor,
  taskDirFor,
  writeJson,
} from "./lib.js";

interface GitHubEvidenceManifest {
  raw_dir: string;
  since_cutoff?: string;
}

interface GitHubUser {
  login?: string;
}

interface GitHubItem {
  number: number;
  html_url?: string;
  title?: string;
  state?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  user?: GitHubUser | null;
}

interface GitHubComment {
  html_url?: string;
  issue_url?: string;
  pull_request_url?: string;
  path?: string;
  diff_hunk?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  user?: GitHubUser | null;
  state?: string;
}

interface PacketRecord {
  kind: "issue" | "pull_request";
  number: number;
  url?: string;
  title?: string;
  state?: string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  body?: string;
  comments?: PacketComment[];
  reviews?: PacketComment[];
  review_comments?: PacketComment[];
}

interface PacketComment {
  url?: string;
  author?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  path?: string;
  diff_hunk?: string;
  body: string;
}

const defaultMaxRecordsPerPacket = 60;
const defaultMaxCharsPerPacket = 1_500_000;

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const task = readTask(taskDir);
  const githubManifestPath = join(taskDir, "evidence", "github.manifest.json");
  if (!existsSync(githubManifestPath)) throw new Error(`GitHub evidence manifest missing: ${githubManifestPath}`);
  const github = readJson<GitHubEvidenceManifest>(githubManifestPath);
  const rawDir = github.raw_dir;
  const outDir = join(taskDir, "evidence", "github-packets");
  const sinceCutoff = option(args, "--since-cutoff") ?? github.since_cutoff;
  const maxRecords = parsePositiveInt(option(args, "--max-records"), defaultMaxRecordsPerPacket);
  const maxChars = parsePositiveInt(option(args, "--max-chars"), defaultMaxCharsPerPacket);
  const maxPackets = parseOptionalPositiveInt(option(args, "--max-packets"));
  const includeTitleOnly = args.get("--include-title-only") === true;

  const issueComments = groupByNumber(readJsonl<GitHubComment>(join(rawDir, "issue-comments.jsonl")), "issue_url");
  const pullComments = groupByNumber(readJsonl<GitHubComment>(join(rawDir, "pull-comments.jsonl")), "issue_url");
  const pullReviews = groupByNumber(readJsonl<GitHubComment>(join(rawDir, "pull-reviews.jsonl")), "pull_request_url");
  const pullReviewComments = groupByNumber(readJsonl<GitHubComment>(join(rawDir, "pull-review-comments.jsonl")), "pull_request_url");
  const issues = readJsonl<GitHubItem>(join(rawDir, "issues.jsonl")).map((item) => recordFromIssue(item, issueComments));
  const pulls = readJsonl<GitHubItem>(join(rawDir, "pulls.jsonl")).map((item) =>
    recordFromPull(item, pullComments, pullReviews, pullReviewComments)
  );

  const records = [...issues, ...pulls]
    .filter((record) => !isExcludedGithubNumber(task, record.number))
    .filter((record) => isInWindow(record.created_at, sinceCutoff, task.cutoff))
    .filter((record) => includeTitleOnly || hasSubstantiveBody(record))
    .sort((left, right) => (Date.parse(left.created_at ?? "") || 0) - (Date.parse(right.created_at ?? "") || 0));

  ensureCleanDir(outDir);
  const packets: string[] = [];
  let current: PacketRecord[] = [];
  let currentChars = 0;
  let droppedForLimit = 0;

  for (const record of records) {
    const recordChars = JSON.stringify(record).length;
    const shouldFlush = current.length > 0 && (current.length >= maxRecords || currentChars + recordChars > maxChars);
    if (shouldFlush) {
      if (maxPackets !== undefined && packets.length >= maxPackets) {
        droppedForLimit += 1;
        continue;
      }
      packets.push(writePacket(outDir, packets.length + 1, task, rawDir, current));
      current = [];
      currentChars = 0;
    }
    if (maxPackets !== undefined && packets.length >= maxPackets) {
      droppedForLimit += 1;
      continue;
    }
    current.push(record);
    currentChars += recordChars;
  }

  if (current.length > 0 && (maxPackets === undefined || packets.length < maxPackets)) {
    packets.push(writePacket(outDir, packets.length + 1, task, rawDir, current));
  } else {
    droppedForLimit += current.length;
  }

  const manifest = {
    repo: task.repo,
    base_commit: task.base_commit,
    since_cutoff: sinceCutoff,
    since_cutoff_is_exclusive: sinceCutoff === undefined ? undefined : true,
    cutoff: task.cutoff,
    cutoff_is_exclusive: true,
    packet_window: sinceCutoff === undefined
      ? `created_at < ${task.cutoff}`
      : `${sinceCutoff} < created_at < ${task.cutoff}`,
    excluded_github_numbers: [...excludedGithubNumbers(task)].sort((left, right) => left - right),
    packet_dir: outDir,
    packet_count: packets.length,
    record_count: packets.reduce((total, packetPath) => total + readJson<{ records: unknown[] }>(packetPath).records.length, 0),
    dropped_for_empty_body: issues.length + pulls.length - records.length,
    dropped_for_packet_limit: droppedForLimit,
    max_records_per_packet: maxRecords,
    max_chars_per_packet: maxChars,
    packets: packets.map((packetPath) => relative(taskDir, packetPath)),
    generated_at: new Date().toISOString(),
  };
  writeJson(join(outDir, "manifest.json"), manifest);
  writeJson(join(taskDir, "evidence", "github-packets.manifest.json"), manifest);
  console.log(`Prepared GitHub packets: ${outDir}`);
  console.log(`Packets: ${packets.length}`);
  console.log(`Records: ${manifest.record_count}`);
}

function recordFromIssue(item: GitHubItem, comments: Map<number, PacketComment[]>): PacketRecord {
  return compactRecord({
    kind: "issue",
    number: item.number,
    url: item.html_url,
    title: item.title,
    state: item.state,
    author: item.user?.login,
    created_at: item.created_at,
    updated_at: item.updated_at,
    body: cleanBody(item.body),
    comments: comments.get(item.number),
  });
}

function isInWindow(value: string | undefined, sinceCutoff: string | undefined, cutoff: string): boolean {
  return isBeforeCutoff(value, cutoff) && (sinceCutoff === undefined || isAfterCutoff(value, sinceCutoff));
}

function recordFromPull(
  item: GitHubItem,
  comments: Map<number, PacketComment[]>,
  reviews: Map<number, PacketComment[]>,
  reviewComments: Map<number, PacketComment[]>,
): PacketRecord {
  return compactRecord({
    kind: "pull_request",
    number: item.number,
    url: item.html_url,
    title: item.title,
    state: item.state,
    author: item.user?.login,
    created_at: item.created_at,
    updated_at: item.updated_at,
    body: cleanBody(item.body),
    comments: comments.get(item.number),
    reviews: reviews.get(item.number),
    review_comments: reviewComments.get(item.number),
  });
}

function compactRecord(record: PacketRecord): PacketRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => !isEmpty(value))) as PacketRecord;
}

function hasSubstantiveBody(record: PacketRecord): boolean {
  return Boolean(record.body) ||
    Boolean(record.comments?.length) ||
    Boolean(record.reviews?.length) ||
    Boolean(record.review_comments?.length);
}

function groupByNumber(comments: GitHubComment[], urlKey: "issue_url" | "pull_request_url"): Map<number, PacketComment[]> {
  const grouped = new Map<number, PacketComment[]>();
  for (const comment of comments) {
    const url = comment[urlKey];
    const number = url === undefined ? undefined : Number(basename(url));
    const body = cleanBody(comment.body);
    if (!Number.isInteger(number) || body === undefined) continue;
    const recordNumber = number as number;
    const values = grouped.get(recordNumber) ?? [];
    values.push(compactComment({
      url: comment.html_url,
      author: comment.user?.login,
      state: comment.state,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      path: comment.path,
      diff_hunk: cleanBody(comment.diff_hunk),
      body,
    }));
    grouped.set(recordNumber, values);
  }
  return grouped;
}

function compactComment(comment: PacketComment): PacketComment {
  return Object.fromEntries(Object.entries(comment).filter(([, value]) => !isEmpty(value))) as PacketComment;
}

function writePacket(outDir: string, index: number, task: ReturnType<typeof readTask>, rawDir: string, records: PacketRecord[]): string {
  const path = join(outDir, `packet-${String(index).padStart(3, "0")}.json`);
  writeJson(path, {
    packet_id: `github-packet-${String(index).padStart(3, "0")}`,
    repo: task.repo,
    base_commit: task.base_commit,
    cutoff: task.cutoff,
    cutoff_is_exclusive: true,
    packet_window: records.length === 0
      ? undefined
      : `${records[0]?.created_at ?? "unknown"} .. ${records.at(-1)?.created_at ?? "unknown"}`,
    excluded_github_numbers: [...excludedGithubNumbers(task)].sort((left, right) => left - right),
    raw_dir: rawDir,
    guidance: [
      "Use titles only for routing.",
      "Create memory only from bodies, comments, reviews, or code verified in the base checkout.",
      "Do not ingest excluded GitHub numbers or any record at or after the cutoff.",
    ],
    records,
  });
  return path;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function cleanBody(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: prepare-github-packets --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer option.");
  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parsePositiveInt(value, 1);
}
