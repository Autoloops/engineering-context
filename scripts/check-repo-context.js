import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url);
const { detectRepoContext } = await import(new URL("dist/apps/cli/repo-context.js", root));
const tmp = mkdtempSync(join(tmpdir(), "greplica-repo-context-test-"));

const nonGitFolder = join(tmp, "plain-folder");
mkdirSync(nonGitFolder);

const fallbackContext = detectRepoContext(nonGitFolder);
assert.equal(fallbackContext.repo_root, realpathSync(nonGitFolder));
assert.equal(fallbackContext.repo_name, basename(nonGitFolder));
assert.equal(fallbackContext.default_branch, "main");
assert.equal(fallbackContext.remote_url, undefined);

const sshRepo = initRepo(join(tmp, "ssh-repo"));
git(sshRepo, "remote", "add", "origin", "git@github.com:Autoloops/greplica.git");
const sshContext = detectRepoContext(sshRepo);
assert.equal(sshContext.repo_root, realpathSync(sshRepo));
assert.equal(sshContext.remote_url, "git@github.com:Autoloops/greplica.git");
assert.equal(sshContext.repo_name, "greplica");

const httpsRepo = initRepo(join(tmp, "https-repo"));
git(httpsRepo, "remote", "add", "origin", "https://github.com/Autoloops/greplica.git");
const httpsContext = detectRepoContext(httpsRepo);
assert.equal(httpsContext.remote_url, "https://github.com/Autoloops/greplica.git");
assert.equal(httpsContext.repo_name, "greplica");

const branchRepo = initRepo(join(tmp, "branch-repo"));
git(branchRepo, "remote", "add", "origin", "https://github.com/Autoloops/greplica.git");
git(branchRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
const branchContext = detectRepoContext(branchRepo);
assert.equal(branchContext.default_branch, "trunk");

const noRemoteHeadRepo = initRepo(join(tmp, "no-remote-head-repo"));
git(noRemoteHeadRepo, "remote", "add", "origin", `file://${join(tmp, "missing-remote.git")}`);
const noRemoteHeadContext = detectRepoContext(noRemoteHeadRepo);
assert.equal(noRemoteHeadContext.default_branch, "unknown");

const bareOrigin = join(tmp, "bare-origin.git");
git(tmp, "init", "--bare", "--quiet", bareOrigin);
git(bareOrigin, "symbolic-ref", "HEAD", "refs/heads/develop");
const commitRepo = initRepo(join(tmp, "commit-for-bare"));
writeFileSync(join(commitRepo, "README"), "develop tip\n");
git(commitRepo, "add", "README");
git(commitRepo, "-c", "user.name=Greplica Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
git(commitRepo, "branch", "-M", "develop");
git(commitRepo, "remote", "add", "origin", bareOrigin);
git(commitRepo, "push", "--quiet", "origin", "develop");
git(bareOrigin, "symbolic-ref", "HEAD", "refs/heads/develop");

const lsRemoteRepo = initRepo(join(tmp, "ls-remote-default-repo"));
git(lsRemoteRepo, "remote", "add", "origin", bareOrigin);
const lsRemoteContext = detectRepoContext(lsRemoteRepo);
assert.equal(
  lsRemoteContext.default_branch,
  "develop",
  "when origin/HEAD is missing, ls-remote --symref should resolve the remote default branch",
);

console.log("Repo context checks passed.");

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
