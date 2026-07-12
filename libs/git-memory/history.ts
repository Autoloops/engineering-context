import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClaimKind } from "../knowledge-graph/claim.js";
import type { Edge } from "../knowledge-graph/edge.js";
import type { MemoryCommitProposal } from "../knowledge-graph/proposal.js";
import type { GraphReadResult } from "../knowledge-graph/service.js";

export interface GitHistoryOptions {
  maxCommits: number;
  maxAgeDays?: number;
}

export interface GitChangedFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitPullRequestMetadata {
  number: number;
  title: string;
  body?: string;
  html_url?: string;
}

export interface GitCommitRecord {
  sha: string;
  authored_at: string;
  subject: string;
  body: string;
  files: GitChangedFile[];
  pull_request?: GitPullRequestMetadata;
}

export interface GitIngestStats {
  commits_analyzed: number;
  claims: number;
  components: number;
  flows: number;
  sources: number;
  edges: number;
}

export interface GitIngestPlan {
  proposal: MemoryCommitProposal;
  stats: GitIngestStats;
}

const conventionalCommit = /^(feat|fix|refactor|perf|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i;
const decisionPattern = /\b(decided?|chose|chosen|adopt(?:ed)?|migrat(?:e|ed)|replac(?:e|ed)|standardiz(?:e|ed))\b/i;
const requirementPattern = /\b(must|should|required?|ensure[sd]?)\b/i;

export function collectGitHistory(repoRoot: string, options: GitHistoryOptions): GitCommitRecord[] {
  const args = [
    "log",
    `--max-count=${options.maxCommits}`,
    "--date=iso-strict",
    "--no-renames",
    "--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1d",
    "--numstat",
  ];
  if (options.maxAgeDays !== undefined) args.splice(2, 0, `--since=${options.maxAgeDays} days ago`);
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseGitHistory(output);
}

export function parseGitHistory(output: string): GitCommitRecord[] {
  const commits: GitCommitRecord[] = [];
  for (const rawChunk of output.split("\x1e")) {
    const chunk = rawChunk.trim();
    if (chunk.length === 0) continue;
    const separator = chunk.indexOf("\x1d");
    if (separator === -1) continue;
    const metadata = chunk.slice(0, separator);
    const numstat = chunk.slice(separator + 1);
    const [sha, authoredAt, subject, ...bodyParts] = metadata.split("\x1f");
    if (!sha || !authoredAt || !subject) continue;
    const files = numstat
      .split(/\r?\n/)
      .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        path: match[3] ?? "",
        additions: match[1] === "-" ? null : Number(match[1]),
        deletions: match[2] === "-" ? null : Number(match[2]),
      }))
      .filter((file) => file.path.length > 0);
    commits.push({
      sha,
      authored_at: authoredAt,
      subject: subject.trim(),
      body: bodyParts.join("\x1f").trim(),
      files,
    });
  }
  return commits;
}

export async function attachPullRequestMetadata(
  commits: GitCommitRecord[],
  remoteUrl: string | undefined,
  token?: string,
): Promise<GitCommitRecord[]> {
  const repository = githubRepository(remoteUrl);
  if (repository === undefined) throw new Error("--prs requires a GitHub origin remote.");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "greplica-git-ingest",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;

  const enriched: GitCommitRecord[] = [];
  for (const commit of commits) {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${commit.sha}/pulls`, { headers });
    if (!response.ok) throw new Error(`GitHub PR lookup failed for ${commit.sha.slice(0, 8)}: ${response.status} ${response.statusText}`);
    const payload = await response.json() as unknown;
    const first = Array.isArray(payload) ? payload[0] : undefined;
    const pullRequest = pullRequestMetadata(first);
    enriched.push(pullRequest === undefined ? commit : { ...commit, pull_request: pullRequest });
  }
  return enriched;
}

export function generateGitHistoryProposal(
  repoRoot: string,
  commits: GitCommitRecord[],
  graph: GraphReadResult,
): GitIngestPlan {
  const existingIds = new Set([
    ...graph.components.map((item) => item.id),
    ...graph.flows.map((item) => item.id),
    ...graph.claims.map((item) => item.id),
    ...graph.sources.map((item) => item.id),
    ...graph.edges.map((item) => item.id),
  ]);
  const existingClaimTexts = new Set(graph.claims.map((claim) => normalizeText(claim.text)));
  const components = new Map<string, { id: string; name: string; code_anchor: string }>();
  const claims: NonNullable<MemoryCommitProposal["creates"]["claims"]> = [];
  const sources: NonNullable<MemoryCommitProposal["creates"]["sources"]> = [];
  const edges: Edge[] = [];
  const modulesByCommit = new Map<string, string[]>();

  for (const commit of commits) {
    const modules = [...new Set(commit.files.map((file) => moduleForPath(file.path)).filter((value): value is string => value !== undefined))].sort();
    modulesByCommit.set(commit.sha, modules);
    for (const module of modules) {
      const id = stableId("component.git", module);
      if (existingIds.has(id) || components.has(id)) continue;
      components.set(id, { id, name: `${module} module`, code_anchor: `${module}/` });
    }

    const extracted = extractedClaims(commit);
    const sourceId = stableId("source.git", commit.sha);
    if (!existingIds.has(sourceId)) {
      const pr = commit.pull_request;
      sources.push({
        id: sourceId,
        kind: "git_history",
        ref: `git:${commit.sha}`,
        title: pr === undefined
          ? `${commit.sha.slice(0, 8)} ${commit.subject}`
          : `#${pr.number} ${pr.title} (${commit.sha.slice(0, 8)})`,
      });
    }

    for (const extractedClaim of extracted) {
      const claimId = stableId("claim.git", `${commit.sha}:${extractedClaim.kind}:${extractedClaim.text}`);
      const normalizedText = normalizeText(extractedClaim.text);
      if (existingIds.has(claimId) || existingClaimTexts.has(normalizedText)) continue;
      const codeAnchors = commit.files
        .map((file) => file.path)
        .filter((file) => existsSync(join(repoRoot, file)))
        .slice(0, 3)
        .map((file) => ({ file }));
      claims.push({
        id: claimId,
        kind: extractedClaim.kind,
        text: extractedClaim.text,
        truth: "source_verified",
        intent: "intended",
        code_anchors: codeAnchors.length === 0 ? undefined : codeAnchors,
      });
      existingClaimTexts.add(normalizedText);
      edges.push(makeEdge("evidenced_by", "claim", claimId, "source", sourceId, {
        reason: `Extracted deterministically from git commit ${commit.sha.slice(0, 12)}.`,
      }));
      for (const module of modules) {
        const componentId = stableId("component.git", module);
        if (!existingIds.has(componentId) && !components.has(componentId)) continue;
        edges.push(makeEdge("about", "claim", claimId, "component", componentId));
      }
    }

  }

  const flows = coChangeFlows(commits, modulesByCommit, existingIds, components, edges);
  const dedupedEdges = dedupeEdges(edges).filter((edge) => !existingIds.has(edge.id));
  const proposal: MemoryCommitProposal = {
    title: `Ingest ${commits.length} git commit${commits.length === 1 ? "" : "s"}`,
    summary: "Deterministic components, claims, flows, and provenance extracted from git history.",
    creates: {
      components: [...components.values()].sort((left, right) => left.id.localeCompare(right.id)),
      flows,
      claims,
      sources,
      edges: dedupedEdges,
    },
  };
  return {
    proposal,
    stats: {
      commits_analyzed: commits.length,
      claims: claims.length,
      components: components.size,
      flows: flows.length,
      sources: sources.length,
      edges: dedupedEdges.length,
    },
  };
}

export function githubRepository(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

function extractedClaims(commit: GitCommitRecord): Array<{ kind: ClaimKind; text: string }> {
  const match = conventionalCommit.exec(commit.subject);
  const context = [commit.subject, commit.body, commit.pull_request?.title, commit.pull_request?.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  const extracted: Array<{ kind: ClaimKind; text: string }> = [];
  if (match) {
    const type = match[1]?.toLowerCase() ?? "";
    const scope = match[2]?.trim();
    const description = match[3]?.trim() ?? commit.subject;
    const kind: ClaimKind = type === "fix" || type === "perf" ? "fact" : type === "build" || type === "ci" ? "requirement" : "insight";
    extracted.push({
      kind,
      text: scope ? `Git history records ${scope}: ${description}.` : `Git history records: ${description}.`,
    });
  }
  for (const sentence of sentences(context)) {
    if (decisionPattern.test(sentence)) extracted.push({ kind: "decision", text: sentence });
    else if (requirementPattern.test(sentence)) extracted.push({ kind: "requirement", text: sentence });
  }
  return dedupeClaims(extracted).slice(0, 3);
}

function sentences(value: string): string[] {
  return value
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/^[-*]\s*/, "").trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 320);
}

function dedupeClaims(claims: Array<{ kind: ClaimKind; text: string }>): Array<{ kind: ClaimKind; text: string }> {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.kind}:${normalizeText(claim.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coChangeFlows(
  commits: GitCommitRecord[],
  modulesByCommit: Map<string, string[]>,
  existingIds: Set<string>,
  components: Map<string, { id: string }>,
  edges: Edge[],
): NonNullable<MemoryCommitProposal["creates"]["flows"]> {
  const moduleCounts = new Map<string, number>();
  const pairCounts = new Map<string, { left: string; right: string; count: number }>();
  for (const commit of commits) {
    const modules = modulesByCommit.get(commit.sha) ?? [];
    for (const module of modules) moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1);
    for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < modules.length; rightIndex += 1) {
        const left = modules[leftIndex];
        const right = modules[rightIndex];
        if (!left || !right) continue;
        const key = `${left}\0${right}`;
        const pair = pairCounts.get(key) ?? { left, right, count: 0 };
        pair.count += 1;
        pairCounts.set(key, pair);
      }
    }
  }

  const flows: NonNullable<MemoryCommitProposal["creates"]["flows"]> = [];
  for (const pair of [...pairCounts.values()].sort((left, right) => left.left.localeCompare(right.left) || left.right.localeCompare(right.right))) {
    const leftCount = moduleCounts.get(pair.left) ?? 0;
    const rightCount = moduleCounts.get(pair.right) ?? 0;
    const lift = commits.length === 0 ? 0 : (pair.count * commits.length) / Math.max(1, leftCount * rightCount);
    if (pair.count < 2 || lift < 1.2) continue;
    const id = stableId("flow.git", `${pair.left}:${pair.right}`);
    if (existingIds.has(id)) continue;
    const leftId = stableId("component.git", pair.left);
    const rightId = stableId("component.git", pair.right);
    if ((!existingIds.has(leftId) && !components.has(leftId)) || (!existingIds.has(rightId) && !components.has(rightId))) continue;
    flows.push({ id, name: `${pair.left} and ${pair.right} co-change flow` });
    edges.push(makeEdge("touches", "flow", id, "component", leftId, { commits: pair.count, lift: round(lift) }));
    edges.push(makeEdge("touches", "flow", id, "component", rightId, { commits: pair.count, lift: round(lift) }));
  }
  return flows;
}

function moduleForPath(path: string): string | undefined {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  if (["apps", "libs", "packages", "services", "src"].includes(parts[0] ?? "") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function makeEdge(
  kind: Edge["kind"],
  fromType: Edge["from_type"],
  fromId: string,
  toType: Edge["to_type"],
  toId: string,
  metadata?: Record<string, unknown>,
): Edge {
  return {
    id: stableId("edge.git", `${kind}:${fromType}:${fromId}:${toType}:${toId}`),
    from_type: fromType,
    from_id: fromId,
    to_type: toType,
    to_id: toId,
    kind,
    metadata,
  };
}

function stableId(prefix: string, value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "item";
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${prefix}.${slug}.${hash}`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function pullRequestMetadata(value: unknown): GitPullRequestMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number" || typeof record.title !== "string") return undefined;
  return {
    number: record.number,
    title: record.title,
    body: typeof record.body === "string" ? record.body : undefined,
    html_url: typeof record.html_url === "string" ? record.html_url : undefined,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
