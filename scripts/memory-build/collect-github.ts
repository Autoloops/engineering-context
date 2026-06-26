import { join, resolve } from "node:path";
import {
  appendJsonl,
  defaultWorkbenchDir,
  ensureCleanDir,
  flag,
  excludedGithubNumbers,
  isAfterCutoff,
  isBeforeCutoff,
  isExcludedGithubNumber,
  option,
  optionalRun,
  parseArgs,
  readTask,
  repoRawDirFor,
  taskDirFor,
  writeJson,
} from "./lib.js";

interface GitHubItem {
  number: number;
  html_url?: string;
  comments_url?: string;
  pull_request?: unknown;
  comments?: number;
  review_comments?: number;
  created_at?: string;
  updated_at?: string;
  title?: string;
  body?: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const task = readTask(taskDir);
  const sinceCutoff = option(args, "--since-cutoff");
  const outDirName = sinceCutoff === undefined
    ? `before-${safeTimestamp(task.cutoff)}`
    : `between-${safeTimestamp(sinceCutoff)}-and-${safeTimestamp(task.cutoff)}`;
  const outDir = join(repoRawDirFor(task, workbenchDir), "github", outDirName);
  ensureCleanDir(outDir);
  const includeComments = !flag(args, "--skip-comments");
  const maxItems = parseOptionalIntOption(option(args, "--max-items"));
  const ghToken = optionalRun(["gh", "auth", "token"]).stdout.trim();
  const token = process.env.GITHUB_TOKEN ?? (ghToken.length > 0 ? ghToken : undefined);
  const client = new GitHubClient(token);

  const inWindow = (item: GitHubItem) => isInWindow(item.created_at, sinceCutoff, task.cutoff);
  const issueSource = sinceCutoff === undefined
    ? await client.paginate<GitHubItem>(`/repos/${task.repo}/issues`, {
      state: "all",
      sort: "created",
      direction: "asc",
      per_page: "100",
    }, stopAtCutoff(task.cutoff))
    : await client.searchIssues(task.repo, "issue", sinceCutoff, task.cutoff);
  const issues = issueSource
    .filter(inWindow)
    .filter((item) => !isExcludedGithubNumber(task, item.number));
  const limitedIssues = maxItems === undefined ? issues : issues.slice(0, maxItems);

  const plainIssues = limitedIssues.filter((item) => item.pull_request === undefined);
  const issuePullRefs = limitedIssues.filter((item) => item.pull_request !== undefined);
  const pullSource = sinceCutoff === undefined
    ? await client.paginate<GitHubItem>(`/repos/${task.repo}/pulls`, {
      state: "all",
      sort: "created",
      direction: "asc",
      per_page: "100",
    }, stopAtCutoff(task.cutoff))
    : await client.searchIssues(task.repo, "pr", sinceCutoff, task.cutoff);
  const pulls = pullSource
    .filter(inWindow)
    .filter((item) => !isExcludedGithubNumber(task, item.number));
  const limitedPulls = maxItems === undefined ? pulls : pulls.slice(0, maxItems);

  const issuePath = join(outDir, "issues.jsonl");
  const pullPath = join(outDir, "pulls.jsonl");
  await BunlessTruncate(issuePath);
  await BunlessTruncate(pullPath);
  appendJsonl(issuePath, plainIssues);
  appendJsonl(pullPath, limitedPulls);

  let issueCommentCount = 0;
  let pullCommentCount = 0;
  let reviewCount = 0;
  let reviewCommentCount = 0;
  const warnings: string[] = [];

  if (includeComments) {
    const issueCommentsPath = join(outDir, "issue-comments.jsonl");
    const pullCommentsPath = join(outDir, "pull-comments.jsonl");
    const pullReviewsPath = join(outDir, "pull-reviews.jsonl");
    const pullReviewCommentsPath = join(outDir, "pull-review-comments.jsonl");
    await BunlessTruncate(issueCommentsPath);
    await BunlessTruncate(pullCommentsPath);
    await BunlessTruncate(pullReviewsPath);
    await BunlessTruncate(pullReviewCommentsPath);
    try {
      for (const issue of plainIssues) {
        if ((issue.comments ?? 0) <= 0) continue;
        const comments = await client.paginate<unknown>(`/repos/${task.repo}/issues/${issue.number}/comments`, { per_page: "100" });
        issueCommentCount += comments.length;
        appendJsonl(issueCommentsPath, comments);
      }
      for (const pull of limitedPulls) {
        if ((pull.comments ?? 0) > 0) {
          const comments = await client.paginate<unknown>(`/repos/${task.repo}/issues/${pull.number}/comments`, { per_page: "100" });
          pullCommentCount += comments.length;
          appendJsonl(pullCommentsPath, comments);
        }
        const reviews = await client.paginate<unknown>(`/repos/${task.repo}/pulls/${pull.number}/reviews`, { per_page: "100" });
        reviewCount += reviews.length;
        appendJsonl(pullReviewsPath, reviews);
        if ((pull.review_comments ?? 0) > 0) {
          const reviewComments = await client.paginate<unknown>(`/repos/${task.repo}/pulls/${pull.number}/comments`, { per_page: "100" });
          reviewCommentCount += reviewComments.length;
          appendJsonl(pullReviewCommentsPath, reviewComments);
        }
      }
    } catch (error: unknown) {
      warnings.push(`Comment/review collection skipped after partial fetch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const manifest = {
    repo: task.repo,
    since_cutoff: sinceCutoff,
    since_cutoff_is_exclusive: sinceCutoff === undefined ? undefined : true,
    cutoff: task.cutoff,
    cutoff_is_exclusive: true,
    collection_window: sinceCutoff === undefined
      ? `created_at < ${task.cutoff}`
      : `${sinceCutoff} < created_at < ${task.cutoff}`,
    raw_dir: outDir,
    auth: token === undefined ? "none" : "token",
    counts: {
      issues: plainIssues.length,
      pull_issue_refs: issuePullRefs.length,
      pulls: limitedPulls.length,
      uncapped_issue_records: issues.length,
      uncapped_pull_records: pulls.length,
      max_items_per_kind: maxItems,
      issue_comments: issueCommentCount,
      pull_comments: pullCommentCount,
      pull_reviews: reviewCount,
      pull_review_comments: reviewCommentCount,
      excluded_github_numbers: [...excludedGithubNumbers(task)].sort((left, right) => left - right),
    },
    warnings,
    collected_at: new Date().toISOString(),
  };
  writeJson(join(outDir, "manifest.json"), manifest);
  writeJson(join(taskDir, "evidence", "github.manifest.json"), manifest);

  console.log(`Collected GitHub evidence: ${outDir}`);
  console.log(`Issues: ${plainIssues.length}`);
  console.log(`Pulls: ${limitedPulls.length}`);
  console.log(`Comments/reviews: ${issueCommentCount + pullCommentCount + reviewCount + reviewCommentCount}`);
  for (const warning of warnings) console.log(`Warning: ${warning}`);
}

function isInWindow(value: string | undefined, sinceCutoff: string | undefined, cutoff: string): boolean {
  return isBeforeCutoff(value, cutoff) && (sinceCutoff === undefined || isAfterCutoff(value, sinceCutoff));
}

function stopAtCutoff(cutoff: string): (batch: GitHubItem[]) => boolean {
  return (batch) => batch.some((item) => !isBeforeCutoff(item.created_at, cutoff));
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: collect-github --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

class GitHubClient {
  constructor(private readonly token: string | undefined) {}

  async searchIssues(repo: string, kind: "issue" | "pr", sinceCutoff: string, cutoff: string): Promise<GitHubItem[]> {
    return this.paginateSearch<GitHubItem>({
      q: `repo:${repo} is:${kind} created:>${sinceCutoff} created:<${cutoff}`,
      sort: "created",
      order: "asc",
      per_page: "100",
    });
  }

  async paginate<T>(path: string, params: Record<string, string>, stopAfterBatch?: (batch: T[]) => boolean): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = new URL(`https://api.github.com${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    while (true) {
      const response = await this.get<T[]>(url);
      const batch = response.body;
      if (!Array.isArray(batch) || batch.length === 0) break;
      items.push(...batch);
      if (batch.length < Number(params.per_page ?? 100)) break;
      if (stopAfterBatch?.(batch) === true) break;
      url = nextLink(response.link);
      if (url === undefined) break;
    }
    return items;
  }

  private async paginateSearch<T>(params: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = new URL("https://api.github.com/search/issues");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    while (true) {
      const response = await this.get<{ items?: T[] }>(url);
      const batch = response.body.items ?? [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      items.push(...batch);
      if (batch.length < Number(params.per_page ?? 100)) break;
      url = nextLink(response.link);
      if (url === undefined) break;
    }
    return items;
  }

  private async get<T>(url: URL): Promise<{ body: T; link: string | null }> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "greplica-memory-build",
    };
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url.pathname}: ${body.slice(0, 500)}`);
    }
    return {
      body: await response.json() as T,
      link: response.headers.get("link"),
    };
  }
}

function nextLink(header: string | null): URL | undefined {
  if (header === null) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next" && match[1] !== undefined) return new URL(match[1]);
  }
  return undefined;
}

async function BunlessTruncate(path: string): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
}

function parseOptionalIntOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer option.");
  return parsed;
}

function safeTimestamp(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
