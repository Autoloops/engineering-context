import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-gc-test-"));
const repoRoot = join(tmp, "repo");
mkdirSync(join(repoRoot, "src"), { recursive: true });
writeFileSync(join(repoRoot, "src", "keep.ts"), "export const keep = 1;\n");
writeFileSync(join(repoRoot, "src", "drop.ts"), "export const drop = 1;\n");

const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = { repo_root: repoRoot, repo_name: "graph-gc", default_branch: "main" };

  const initialized = service.initRepo(repo);
  const memoryCommit = repository.createMemoryCommit({ scope_id: initialized.working_scope_id, title: "Seed" });

  repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
    title: "Seed",
    creates: {
      components: [
        { id: "component.keep", name: "Keep", code_anchor: "src/keep.ts" },
        { id: "component.drop", name: "Drop", code_anchor: "src/drop.ts" },
      ],
      claims: [
        { id: "claim.keep", kind: "fact", text: "keep", truth: "code_verified", intent: "intended", code_anchors: [{ file: "src/keep.ts" }] },
        { id: "claim.drop", kind: "fact", text: "drop", truth: "code_verified", intent: "intended", code_anchors: [{ file: "src/drop.ts" }] },
      ],
      edges: [
        { id: "edge.about_keep", from_id: "claim.keep", from_type: "claim", to_id: "component.keep", to_type: "component", kind: "about" },
        { id: "edge.about_drop", from_id: "claim.drop", from_type: "claim", to_id: "component.drop", to_type: "component", kind: "about" },
        { id: "edge.dangling", from_id: "claim.keep", from_type: "claim", to_id: "component.ghost", to_type: "component", kind: "about" },
      ],
    },
  });

  // A refactor deletes drop.ts -> its component + claim anchors go stale.
  rmSync(join(repoRoot, "src", "drop.ts"));

  // --- dry run: reports defects, changes nothing ---
  const dry = await service.gcGraph(repo, { dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.stale_components.map((c) => c.id), ["component.drop"], "stale component detected");
  assert.deepEqual(dry.stale_claims.map((c) => c.id), ["claim.drop"], "stale claim detected");
  assert.deepEqual(dry.dangling_edges.map((e) => e.id), ["edge.dangling"], "dangling edge detected");
  assert.deepEqual(dry.pruned, { components: 1, flows: 0, claims: 1, edges: 2 }, "dry-run plan counts");

  let graph = service.readGraph(repo);
  assert.equal(graph.claims.length, 2, "dry run must not delete anything");
  assert.equal(graph.components.length, 2, "dry run must not delete anything");

  // --- real run: prunes the defects, keeps healthy objects ---
  const run = await service.gcGraph(repo, { dryRun: false });
  assert.equal(run.dry_run, false);
  assert.deepEqual(run.pruned, { components: 1, flows: 0, claims: 1, edges: 2 }, "prune counts");

  graph = service.readGraph(repo);
  assert.deepEqual(graph.components.map((c) => c.id), ["component.keep"], "only healthy component remains");
  assert.deepEqual(graph.claims.map((c) => c.id), ["claim.keep"], "only healthy claim remains");

  assert.equal(repository.subjectExists("claim", "claim.drop"), false, "stale claim row deleted");
  assert.equal(repository.subjectExists("component", "component.drop"), false, "stale component row deleted");
  assert.equal(repository.subjectExists("edge", "edge.about_drop"), false, "cascaded edge deleted");
  assert.equal(repository.subjectExists("edge", "edge.dangling"), false, "dangling edge deleted");

  assert.equal(repository.subjectExists("claim", "claim.keep"), true, "healthy claim kept");
  assert.equal(repository.subjectExists("component", "component.keep"), true, "healthy component kept");
  assert.equal(repository.subjectExists("edge", "edge.about_keep"), true, "healthy edge kept");

  // --- idempotent: nothing left to prune ---
  const again = await service.gcGraph(repo, { dryRun: true });
  assert.deepEqual(again.pruned, { components: 0, flows: 0, claims: 0, edges: 0 }, "second pass is a no-op");
} finally {
  db.close();
}

console.log("Graph gc checks passed.");
