import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url);
let detectRepoContext;

beforeAll(async () => {
  const repoContext = await import(new URL("dist/apps/cli/repo-context.js", root));
  detectRepoContext = repoContext.detectRepoContext;
});

function initRepo(path) {
  mkdirSync(path);
  git(path, "init", "--quiet");
  return path;
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("repo context", () => {
  test("non-git folder falls back to folder name and main branch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));
    const nonGitFolder = join(tmp, "plain-folder");
    mkdirSync(nonGitFolder);

    const fallbackContext = detectRepoContext(nonGitFolder);
    expect(fallbackContext.repo_root).toBe(realpathSync(nonGitFolder));
    expect(fallbackContext.repo_name).toBe(basename(nonGitFolder));
    expect(fallbackContext.default_branch).toBe("main");
    expect(fallbackContext.remote_url).toBeUndefined();
  });

  test("SSH remote is parsed correctly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));
    const sshRepo = initRepo(join(tmp, "ssh-repo"));
    git(sshRepo, "remote", "add", "origin", "git@github.com:Autoloops/greplica.git");

    const sshContext = detectRepoContext(sshRepo);
    expect(sshContext.repo_root).toBe(realpathSync(sshRepo));
    expect(sshContext.remote_url).toBe("git@github.com:Autoloops/greplica.git");
    expect(sshContext.repo_name).toBe("greplica");
  });

  test("HTTPS remote is parsed correctly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));
    const httpsRepo = initRepo(join(tmp, "https-repo"));
    git(httpsRepo, "remote", "add", "origin", "https://github.com/Autoloops/greplica.git");

    const httpsContext = detectRepoContext(httpsRepo);
    expect(httpsContext.remote_url).toBe("https://github.com/Autoloops/greplica.git");
    expect(httpsContext.repo_name).toBe("greplica");
  });

  test("custom default branch is detected from remote HEAD", () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));
    const branchRepo = initRepo(join(tmp, "branch-repo"));
    git(branchRepo, "remote", "add", "origin", "https://github.com/Autoloops/greplica.git");
    git(branchRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    const branchContext = detectRepoContext(branchRepo);
    expect(branchContext.default_branch).toBe("trunk");
  });

  test("defaults to main when remote HEAD is not set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));
    const noRemoteHeadRepo = initRepo(join(tmp, "no-remote-head-repo"));
    git(noRemoteHeadRepo, "remote", "add", "origin", "https://github.com/Autoloops/greplica.git");

    const noRemoteHeadContext = detectRepoContext(noRemoteHeadRepo);
    expect(noRemoteHeadContext.default_branch).toBe("main");
  });
});
