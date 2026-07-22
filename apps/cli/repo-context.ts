import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RepoRef } from "../../libs/knowledge-graph/service.js";

export function detectRepoContext(cwd = process.cwd()): RepoRef {
  const repoRoot = canonicalPath(gitOptional(cwd, ["rev-parse", "--show-toplevel"]));
  if (repoRoot === undefined) return folderContext(cwd);

  const remoteUrl = gitOptional(repoRoot, ["config", "--get", "remote.origin.url"]);

  return {
    repo_root: repoRoot,
    remote_url: remoteUrl,
    repo_name: remoteUrl === undefined ? basename(repoRoot) : repoName(remoteUrl, repoRoot),
    default_branch: defaultBranch(repoRoot),
  };
}

function folderContext(cwd: string): RepoRef {
  const folderRoot = canonicalPath(cwd) ?? resolve(cwd);
  return {
    repo_root: folderRoot,
    repo_name: basename(folderRoot),
    default_branch: "main",
  };
}

function canonicalPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function defaultBranch(repoRoot: string): string {
  const remoteHead = gitOptional(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith("origin/")) return remoteHead.slice("origin/".length);

  const lsRemoteSymref = gitOptional(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"]);
  const fromLsRemote = parseLsRemoteSymrefHead(lsRemoteSymref);
  if (fromLsRemote !== undefined) return fromLsRemote;

  return "unknown";
}

function parseLsRemoteSymrefHead(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const match = output.match(/^ref:\s+refs\/heads\/([^\s\t]+)/m);
  return match?.[1];
}

function repoName(remoteUrl: string, repoRoot: string): string {
  const withoutGit = remoteUrl.endsWith(".git") ? remoteUrl.slice(0, -4) : remoteUrl;
  const lastPart = withoutGit.split(/[/:]/).filter(Boolean).at(-1);
  return lastPart ?? basename(repoRoot);
}

function gitOptional(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
