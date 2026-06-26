import { join, resolve } from "node:path";
import { defaultGreplicaConfig } from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { KnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { SqliteRepository } from "../../libs/storage/sqlite/repository.js";
import {
  defaultWorkbenchDir,
  option,
  parseArgs,
  readJson,
  readTask,
  repoRawDirFor,
  taskDirFor,
  writeJson,
} from "./lib.js";

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const task = readTask(taskDir);
  const repoManifest = readJson<{ checkout_dir: string }>(join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit, "manifest.json"));
  const dbPath = join(taskDir, "runtime", "greplica-home", "graph.db");
  const db = openDatabase(dbPath);
  try {
    const service = new KnowledgeGraphService(new SqliteRepository(db), graphContextConfigFromGreplicaConfig(defaultGreplicaConfig));
    const repoRef = {
      repo_root: repoManifest.checkout_dir,
      remote_url: task.memory_remote_url ?? task.repo_url,
      repo_name: task.repo.split("/").at(-1) ?? task.repo,
      default_branch: "main",
    };
    const graph = service.readGraph(repoRef);
    const audit = await service.auditCodeAnchors(repoRef);
    const warnings = {
      file_only_code_anchors: graph.claims.flatMap((claim) =>
        (claim.code_anchors ?? [])
          .filter((anchor) => anchor.symbol === undefined)
          .map((anchor) => ({ claim_id: claim.id, anchor })),
      ),
      claims_with_many_code_anchors: graph.claims
        .filter((claim) => (claim.code_anchors?.length ?? 0) > 3)
        .map((claim) => ({ claim_id: claim.id, count: claim.code_anchors?.length ?? 0 })),
    };
    const report = {
      strict: audit,
      warnings,
      counts: {
        code_verified_claims: graph.claims.filter((claim) => claim.truth === "code_verified").length,
        missing_anchors: audit.missing_anchors.length,
        missing_files: audit.missing_files.length,
        missing_symbols: audit.missing_symbols.length,
        ambiguous_symbols: audit.ambiguous_symbols.length,
        unsupported_languages: audit.unsupported_languages.length,
        file_only_code_anchors: warnings.file_only_code_anchors.length,
        claims_with_many_code_anchors: warnings.claims_with_many_code_anchors.length,
      },
      audited_at: new Date().toISOString(),
    };
    writeJson(join(taskDir, "runtime", "audit.json"), report);
    const strictFailures =
      audit.missing_anchors.length +
      audit.missing_files.length +
      audit.missing_symbols.length +
      audit.ambiguous_symbols.length +
      audit.unsupported_languages.length;
    console.log(`Anchor audit strict failures: ${strictFailures}`);
    console.log(`File-only anchors: ${warnings.file_only_code_anchors.length}`);
    if (strictFailures > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: audit-anchors --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}
