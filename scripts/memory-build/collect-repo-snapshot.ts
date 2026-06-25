import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  copyRequiredFile,
  defaultWorkbenchDir,
  ensureCleanDir,
  ensureBenchmarkRepoIdentity,
  option,
  parseArgs,
  readTask,
  relativeTo,
  repoRawDirFor,
  run,
  sha256File,
  taskDirFor,
  walkFiles,
  writeJson,
  type RepoSnapshotManifest,
} from "./lib.js";

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args, workbenchDir), workbenchDir));
  const task = readTask(taskDir);
  const rawRepoDir = join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit);
  const checkoutDir = join(rawRepoDir, "checkout");
  const tarPath = join(rawRepoDir, "base-source.tar.gz");

  mkdirSync(rawRepoDir, { recursive: true });
  if (task.source_base_source_tar !== undefined && existsSync(task.source_base_source_tar)) {
    copyRequiredFile(task.source_base_source_tar, tarPath);
    extractTar(tarPath, checkoutDir);
  } else {
    cloneAtCommit(task.repo_url, task.base_commit, checkoutDir);
  }
  ensureBenchmarkRepoIdentity(checkoutDir, task);

  const files = walkFiles(checkoutDir, { maxBytes: 1_000_000 }).map((file) => {
    const stat = statSync(file);
    return {
      path: relativeTo(checkoutDir, file),
      bytes: stat.size,
    };
  });

  const fileListPath = join(rawRepoDir, "file-list.json");
  writeJson(fileListPath, {
    repo: task.repo,
    base_commit: task.base_commit,
    files,
  });

  const manifest: RepoSnapshotManifest = {
    repo: task.repo,
    repo_url: task.repo_url,
    base_commit: task.base_commit,
    checkout_dir: checkoutDir,
    source_tar: existsSync(tarPath) ? tarPath : undefined,
    file_list_path: fileListPath,
    file_count: files.length,
    collected_at: new Date().toISOString(),
  };
  writeJson(join(rawRepoDir, "manifest.json"), manifest);
  writeJson(join(taskDir, "evidence", "repo-snapshot.manifest.json"), {
    ...manifest,
    source_tar_sha256: existsSync(tarPath) ? sha256File(tarPath) : undefined,
  });

  console.log(`Collected repo snapshot: ${checkoutDir}`);
  console.log(`Files: ${files.length}`);
}

function readTaskFromArgs(args: Map<string, string | true>, workbenchDir: string) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: collect-repo-snapshot --task-dir <dir> or --task <task-id>");
  const repo = option(args, "--repo") ?? "cli/cli";
  return {
    task_id: taskId,
    repo,
    repo_url: `https://github.com/${repo}.git`,
    base_commit: "",
    cutoff: "",
  };
}

function extractTar(tarPath: string, checkoutDir: string): void {
  const extractRoot = join(dirname(checkoutDir), "extract-tmp");
  ensureCleanDir(extractRoot);
  ensureCleanDir(checkoutDir);
  run(["tar", "-xzf", tarPath, "-C", extractRoot]);
  const entries = readdirSync(extractRoot).filter((entry) => statSync(join(extractRoot, entry)).isDirectory());
  if (entries.length !== 1) throw new Error(`Expected one top-level directory in ${basename(tarPath)}, found ${entries.length}`);
  const extracted = join(extractRoot, entries[0] ?? "");
  run(["cp", "-R", `${extracted}/.`, checkoutDir]);
  ensureCleanDir(extractRoot);
}

function cloneAtCommit(repoUrl: string, commit: string, checkoutDir: string): void {
  ensureCleanDir(checkoutDir);
  run(["git", "clone", "--no-checkout", "--filter=blob:none", repoUrl, checkoutDir]);
  run(["git", "checkout", commit], checkoutDir);
}
