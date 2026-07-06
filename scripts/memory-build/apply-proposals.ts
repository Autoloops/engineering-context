import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultGreplicaConfig, writeGreplicaConfig } from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { KnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import { normalizeProposal } from "../../libs/knowledge-graph/proposal.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { SqliteRepository } from "../../libs/storage/sqlite/repository.js";
import {
  assertInsideWorkbench,
  checksumManifest,
  defaultWorkbenchDir,
  ensureCleanDir,
  ensureBenchmarkRepoIdentity,
  memoryRemoteUrl,
  option,
  packageChecksum,
  parseArgs,
  proposalHasExcludedGithubSource,
  proposalLineageTaskDirs,
  readJson,
  readTask,
  repoRawDirFor,
  taskDirFor,
  writeJson,
} from "./lib.js";

interface ProposalManifest {
  apply_order: string[];
}

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
  const baseTaskDir = option(args, "--base-task-dir") === undefined ? undefined : resolve(option(args, "--base-task-dir") ?? "");
  const task = readTask(taskDir);
  const rawRepoDir = join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit);
  const repoManifest = readJson<{ checkout_dir: string }>(join(rawRepoDir, "manifest.json"));
  const runtimeDir = join(taskDir, "runtime");
  const homeDir = join(runtimeDir, "greplica-home");
  assertInsideWorkbench(homeDir);
  ensureBenchmarkRepoIdentity(repoManifest.checkout_dir, task);
  ensureCleanDir(homeDir);
  writeGreplicaConfig(defaultGreplicaConfig, join(homeDir, "config.json"));

  const dbPath = join(homeDir, "graph.db");
  const db = openDatabase(dbPath);
  try {
    const repository = new SqliteRepository(db);
    const service = new KnowledgeGraphService(repository, graphContextConfigFromGreplicaConfig(defaultGreplicaConfig));
    const repoRef = {
      repo_root: repoManifest.checkout_dir,
      remote_url: memoryRemoteUrl(task),
      repo_name: task.repo.split("/").at(-1) ?? task.repo,
      default_branch: "main",
    };
    const init = service.initRepo(repoRef);
    const applied = [];
    const lineageTaskDirs = baseTaskDir === undefined ? [] : proposalLineageTaskDirs(baseTaskDir, workbenchDir);
    const excludedClaimIds = collectExcludedClaimIds([...lineageTaskDirs, taskDir], task);
    if (baseTaskDir !== undefined) {
      for (const lineageTaskDir of lineageTaskDirs) {
        applied.push(...await applyManifest({
          currentTask: task,
          excludedClaimIds,
          label: `base:${readTask(lineageTaskDir).task_id}`,
          taskDir: lineageTaskDir,
          repository,
          service,
          repoRef,
        }));
      }
    }
    applied.push(...await applyManifest({
      currentTask: task,
      excludedClaimIds,
      label: "current",
      taskDir,
      repository,
      service,
      repoRef,
    }));

    const graph = service.readGraph(repoRef);
    const report = {
      task_id: task.task_id,
      base_task_dir: baseTaskDir,
      db_path: dbPath,
      home_dir: homeDir,
      package_sha256: packageChecksum(taskDir),
      repo: { ...init, database_path: dbPath },
      applied,
      graph_counts: {
        components: graph.components.length,
        flows: graph.flows.length,
        claims: graph.claims.length,
        code_verified_claims: graph.claims.filter((claim) => claim.truth === "code_verified").length,
        claims_with_code_anchors: graph.claims.filter((claim) => (claim.code_anchors?.length ?? 0) > 0).length,
        sources: graph.sources.length,
        edges: graph.edges.length,
      },
      materialized_at: new Date().toISOString(),
    };
    writeJson(join(runtimeDir, "apply-report.json"), report);
    checksumManifest(taskDir);
    console.log(`Materialized runtime DB: ${dbPath}`);
    console.log(`Claims: ${report.graph_counts.claims}`);
    console.log(`Code-anchored claims: ${report.graph_counts.claims_with_code_anchors}`);
  } finally {
    db.close();
  }
}

async function applyManifest(input: {
  currentTask: ReturnType<typeof readTask>;
  excludedClaimIds: Set<string>;
  label: string;
  taskDir: string;
  repository: SqliteRepository;
  service: KnowledgeGraphService;
  repoRef: {
    repo_root: string;
    remote_url: string;
    repo_name: string;
    default_branch: string;
  };
}): Promise<Array<{
  source: string;
  file: string;
  memory_commit_id: string;
  created?: Awaited<ReturnType<KnowledgeGraphService["applyProposal"]>>["created"];
  embeddings?: Awaited<ReturnType<KnowledgeGraphService["applyProposal"]>>["embedding_status"];
  skipped_reason?: string;
}>> {
  const manifest = readJson<ProposalManifest>(join(input.taskDir, "proposals", "manifest.json"));
  const initialized = input.service.requireRepo(input.repoRef);
  const subjectLookup = {
    subjectType: (id: string) => input.repository.subjectType(initialized.repo_id, id),
  };
  const applied = [];
  for (const file of manifest.apply_order) {
    const proposalPath = join(input.taskDir, "proposals", file);
    if (!existsSync(proposalPath)) throw new Error(`Proposal listed in manifest is missing: ${proposalPath}`);
    const proposal = readJson<unknown>(proposalPath);
    const sanitized = stripExcludedGithubEvidence(proposal, input.currentTask, input.excludedClaimIds);
    if (sanitized.skipped) {
      applied.push({
        source: input.label,
        file,
        memory_commit_id: "skipped",
        skipped_reason: sanitized.reason,
      });
      continue;
    }
    const normalized = normalizeProposal(sanitized.proposal, subjectLookup);
    const result = await input.service.applyProposal(input.repoRef, normalized);
    applied.push({
      source: input.label,
      file,
      memory_commit_id: result.memory_commit_id,
      created: result.created,
      embeddings: result.embedding_status,
    });
  }
  return applied;
}

function collectExcludedClaimIds(taskDirs: string[], task: ReturnType<typeof readTask>): Set<string> {
  const claimIds = new Set<string>();
  for (const taskDir of taskDirs) {
    const manifestPath = join(taskDir, "proposals", "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<ProposalManifest>(manifestPath);
    for (const file of manifest.apply_order) {
      const proposalPath = join(taskDir, "proposals", file);
      if (!existsSync(proposalPath)) continue;
      const proposal = readJson<unknown>(proposalPath);
      collectExcludedClaimIdsFromProposal(proposal, task, claimIds);
    }
  }
  return claimIds;
}

function collectExcludedClaimIdsFromProposal(proposal: unknown, task: ReturnType<typeof readTask>, claimIds: Set<string>): void {
  if (!proposalHasExcludedGithubSource(proposal, task)) return;
  const shaped = proposal as {
    creates?: {
      claims?: Array<{ id?: string }>;
      sources?: Array<{ id?: string }>;
      edges?: Array<{ from?: string; to?: string; from_id?: string; to_id?: string }>;
    };
  };
  const creates = shaped.creates;
  if (creates === undefined) return;
  const excludedSourceIds = new Set(
    (creates.sources ?? [])
      .map((source) => source.id)
      .filter((id): id is string => id !== undefined && proposalHasExcludedGithubSource(id, task)),
  );
  for (const edge of creates.edges ?? []) {
    const to = edge.to ?? edge.to_id;
    const from = edge.from ?? edge.from_id;
    if (to !== undefined && excludedSourceIds.has(to) && from !== undefined) claimIds.add(from);
  }
}

function stripExcludedGithubEvidence(proposal: unknown, task: ReturnType<typeof readTask>, excludedClaimIds: Set<string>): {
  proposal: unknown;
  skipped: boolean;
  reason?: string;
} {
  const cloned = JSON.parse(JSON.stringify(proposal)) as {
    creates?: {
      claims?: Array<{ id?: string; supersedes?: string[] }>;
      sources?: Array<{ id?: string }>;
      edges?: Array<{ from?: string; to?: string; from_id?: string; to_id?: string }>;
      components?: unknown[];
      flows?: unknown[];
    };
  };
  const creates = cloned.creates;
  if (creates === undefined) return { proposal: cloned, skipped: false };

  const excludedSourceIds = new Set(
    (creates.sources ?? [])
      .map((source) => source.id)
      .filter((id): id is string => id !== undefined && proposalHasExcludedGithubSource(id, task)),
  );
  const removedClaimIds = new Set(
    [...excludedClaimIds, ...(creates.edges ?? [])
      .filter((edge) => excludedSourceIds.has(edge.to ?? edge.to_id ?? ""))
      .map((edge) => edge.from ?? edge.from_id)
      .filter((id): id is string => id !== undefined)],
  );

  creates.sources = (creates.sources ?? []).filter((source) => source.id === undefined || !excludedSourceIds.has(source.id));
  creates.claims = (creates.claims ?? [])
    .filter((claim) => claim.id === undefined || !removedClaimIds.has(claim.id))
    .map((claim) => ({
      ...claim,
      supersedes: claim.supersedes?.filter((id) => !removedClaimIds.has(id)),
    }));
  creates.edges = (creates.edges ?? []).filter((edge) => {
    const from = edge.from ?? edge.from_id;
    const to = edge.to ?? edge.to_id;
    return !excludedSourceIds.has(to ?? "") && !removedClaimIds.has(from ?? "") && !removedClaimIds.has(to ?? "");
  });

  const hasCreates = (creates.components?.length ?? 0) > 0 ||
    (creates.flows?.length ?? 0) > 0 ||
    (creates.claims?.length ?? 0) > 0 ||
    (creates.sources?.length ?? 0) > 0 ||
    (creates.edges?.length ?? 0) > 0;
  return {
    proposal: cloned,
    skipped: !hasCreates,
    reason: !hasCreates ? "all proposal content was excluded GitHub evidence" : undefined,
  };
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: apply-proposals --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}
