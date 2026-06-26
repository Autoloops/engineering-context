import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultGreplicaConfig } from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
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
  writeText,
} from "./lib.js";

const defaultQueries = [
  "where are pull request list filters and rendering implemented?",
  "where is issue selector parsing implemented?",
  "where is table output truncation implemented?",
  "where are pull request API query helpers implemented?",
];

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
  const query = option(args, "--query");
  const queries = query === undefined ? defaultQueries : [query];
  const smokeDir = join(taskDir, "runtime", "retrieval-smoke");
  mkdirSync(smokeDir, { recursive: true });

  const db = openDatabase(join(taskDir, "runtime", "greplica-home", "graph.db"));
  try {
    const service = new KnowledgeGraphService(new SqliteRepository(db), graphContextConfigFromGreplicaConfig(defaultGreplicaConfig));
    const repoRef = {
      repo_root: repoManifest.checkout_dir,
      remote_url: task.memory_remote_url ?? task.repo_url,
      repo_name: task.repo.split("/").at(-1) ?? task.repo,
      default_branch: "main",
    };
    const results = [];
    for (let index = 0; index < queries.length; index += 1) {
      const result = await service.contextGraph(repoRef, queries[index] ?? "");
      const markdown = renderGraphContextMarkdown(result);
      const stem = `${String(index + 1).padStart(2, "0")}`;
      writeText(join(smokeDir, `${stem}.md`), markdown);
      writeJson(join(smokeDir, `${stem}.debug.json`), result);
      results.push({
        query: queries[index],
        claims: result.ranked_results.filter((item) => item.type === "claim").length,
        components: result.ranked_results.filter((item) => item.type === "component").length,
        flows: result.ranked_results.filter((item) => item.type === "flow").length,
        markdown_bytes: Buffer.byteLength(markdown),
      });
    }
    writeJson(join(taskDir, "runtime", "retrieval-smoke.json"), {
      queries: results,
      generated_at: new Date().toISOString(),
    });
    console.log(`Wrote retrieval smoke: ${smokeDir}`);
    for (const result of results) {
      console.log(`${result.query}: ${result.markdown_bytes} bytes, ${result.claims} claims`);
    }
  } finally {
    db.close();
  }
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: run-retrieval-smoke --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}
