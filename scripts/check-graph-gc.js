import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-gc-test-"));
const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repoRoot = join(tmp, "repo");
  mkdirSync(repoRoot, { recursive: true });

  const repo = {
    repo_root: repoRoot,
    repo_name: "graph-gc-test",
    default_branch: "main",
  };

  const initialized = service.initRepo(repo);

  // Create a working proposal with various entities
  const memoryCommit = repository.createMemoryCommit({
    scope_id: initialized.working_scope_id,
    title: "Seed test data",
  });

  repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
    title: "Seed test data",
    creates: {
      components: [
        { id: "comp.valid", name: "Valid Component" },
        { id: "comp.stale_anchor", name: "Stale Anchor Component", code_anchor: "nonexistent-file.ts" },
        { id: "comp.orphaned", name: "Orphaned Component" },
      ],
      flows: [
        { id: "flow.valid", name: "Valid Flow" },
        { id: "flow.orphaned", name: "Orphaned Flow" },
      ],
      claims: [
        { id: "claim.valid", name: "Valid Claim", kind: "fact", text: "Valid claim text", truth: "unknown", intent: "unknown" },
        { id: "claim.orphaned", name: "Orphaned Claim", kind: "fact", text: "Orphaned claim text", truth: "unknown", intent: "unknown" },
      ],
      sources: [{ id: "src.test", kind: "session", ref: "test-session" }],
      edges: [
        { id: "edge.valid_about", from_id: "claim.valid", from_type: "claim", to_id: "comp.valid", to_type: "component", kind: "about" },
        { id: "edge.valid_touches", from_id: "flow.valid", from_type: "flow", to_id: "comp.valid", to_type: "component", kind: "touches" },
        { id: "edge.valid_evidenced", from_id: "claim.valid", from_type: "claim", to_id: "src.test", to_type: "source", kind: "evidenced_by" },
        { id: "edge.orphaned_dangling", from_id: "flow.valid", from_type: "flow", to_id: "comp.nonexistent", to_type: "component", kind: "touches" },
      ],
    },
  });

  // Add an edge from stale_anchor to comp.orphaned so they're connected to each other but isolated
  const mc2 = repository.createMemoryCommit({ scope_id: initialized.working_scope_id, title: "Seed more data" });
  repository.createProposalRecords(initialized.working_scope_id, mc2.id, {
    title: "Seed more data",
    creates: {
      components: [
        { id: "comp.stale_connected", name: "Stale Connected", code_anchor: "missing-too.ts" },
      ],
      edges: [
        { id: "edge.comp_to_stale", from_id: "comp.stale_connected", from_type: "component", to_id: "comp.stale_anchor", to_type: "component", kind: "contains" },
      ],
    },
  });

  // Also add an embedding to verify cleanup
  repository.insertGraphObjectEmbeddings([
    {
      repo_id: initialized.repo_id,
      object_type: "component",
      object_id: "comp.stale_anchor",
      provider: "test",
      model: "test-model",
      dimensions: 128,
      embedding: Buffer.from([0, 1, 2, 3]),
    },
    {
      repo_id: initialized.repo_id,
      object_type: "component",
      object_id: "comp.stale_connected",
      provider: "test",
      model: "test-model",
      dimensions: 128,
      embedding: Buffer.from([0, 1, 2, 3]),
    },
  ]);

  // Test dry-run
  const dryResult = service.gcGraph(repo, true);
  const scan = dryResult.scan;
  assert.equal(scan.stale_components.length, 2, "Should detect 2 stale components");
  assert.equal(scan.dangling_edges.length, 1, "Should detect 1 dangling edge");
  assert.equal(scan.orphaned_components.length, 1, "Should detect 1 orphaned component");
  assert.equal(scan.orphaned_claims.length, 1, "Should detect 1 orphaned claim");
  assert.equal(scan.orphaned_flows.length, 1, "Should detect 1 orphaned flow");

  // Verify dry-run did not modify the database (check raw tables directly)
  const rawComponentsBefore = db.prepare("SELECT id FROM components").all();
  assert.equal(rawComponentsBefore.length, 4, "Dry run should not remove components from DB");
  const rawEdgesBefore = db.prepare("SELECT id FROM edges").all();
  assert.equal(rawEdgesBefore.length, 5, "Dry run should not remove edges from DB");

  // Test apply - one pass should clean everything including cascading
  const applyResult = service.gcGraph(repo, false);
  // Expected: 2 stale comps, 1 orphan comp = 3 component deletes
  // 1 orphan claim, 1 orphan flow = 5 entity deletes total
  // Plus: 1 dangling edge + 1 connected edge (comp_to_stale) = 2 edge deletes
  assert.equal(applyResult.deleted.components, 3, "Should delete 3 components");
  assert.equal(applyResult.deleted.claims, 1, "Should delete 1 claim");
  assert.equal(applyResult.deleted.flows, 1, "Should delete 1 flow");
  assert.equal(applyResult.deleted.edges, 2, "Should delete 2 edges");

  // Verify the database was cleaned
  const graphAfterApply = service.readGraph(repo);
  assert.equal(graphAfterApply.components.length, 1, "Should have 1 component remaining");
  assert.equal(graphAfterApply.components[0].id, "comp.valid", "Valid component should remain");
  assert.equal(graphAfterApply.claims.length, 1, "Should have 1 claim remaining");
  assert.equal(graphAfterApply.claims[0].id, "claim.valid", "Valid claim should remain");
  assert.equal(graphAfterApply.flows.length, 1, "Should have 1 flow remaining");
  assert.equal(graphAfterApply.flows[0].id, "flow.valid", "Valid flow should remain");

  // Verify DB is fully clean on next scan
  const finalScan = service.gcGraph(repo, true).scan;
  assert.equal(
    finalScan.stale_components.length + finalScan.orphaned_components.length + finalScan.orphaned_claims.length + finalScan.orphaned_flows.length + finalScan.dangling_edges.length,
    0,
    "All issues resolved in a single pass",
  );

  // Verify stale anchor files do not exist
  assert.equal(existsSync(join(repoRoot, "nonexistent-file.ts")), false, "Stale anchor file should not exist");
  assert.equal(existsSync(join(repoRoot, "missing-too.ts")), false, "Stale anchor file should not exist");

  console.log("Graph GC checks passed.");
} finally {
  db.close();
}
