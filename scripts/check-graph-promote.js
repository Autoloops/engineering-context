import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { countPromotedSubjects } = await import(new URL("dist/libs/knowledge-graph/graph-promote.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-promote-test-"));
const repoRoot = join(tmp, "repo");
mkdirSync(repoRoot, { recursive: true });

const db = openDatabase(join(tmp, "graph.db"));

const membershipCount = (scopeId) =>
  db.prepare("SELECT count(*) AS c FROM graph_memberships WHERE scope_id = ?").get(scopeId).c;
const claimIds = (graph) => new Set(graph.claims.map((claim) => claim.id));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = { repo_root: repoRoot, repo_name: "graph-promote", default_branch: "main" };

  const initialized = service.initRepo(repo);

  // --- main already holds a v1 claim about onboarding ---
  const mainSeed = repository.createMemoryCommit({ scope_id: initialized.main_scope_id, title: "Main seed" });
  repository.createProposalRecords(initialized.main_scope_id, mainSeed.id, {
    title: "Main seed",
    creates: {
      components: [{ id: "component.onboarding", name: "Onboarding", code_anchor: "src/onboarding.ts" }],
      claims: [
        { id: "claim.v1", kind: "fact", text: "Onboarding is a 5-step form.", truth: "code_verified", intent: "intended", code_anchors: [{ file: "src/onboarding.ts" }] },
      ],
    },
  });

  // --- a session rewrites onboarding in the working scope: a new component, a v2
  //     claim, and a supersedes edge retiring the v1 main claim ---
  const workingSeed = repository.createMemoryCommit({ scope_id: initialized.working_scope_id, title: "Working seed" });
  repository.createProposalRecords(initialized.working_scope_id, workingSeed.id, {
    title: "Working seed",
    creates: {
      components: [{ id: "component.worker", name: "Build Worker", code_anchor: "src/worker.ts" }],
      claims: [
        { id: "claim.v2", kind: "fact", text: "Onboarding is a 7-stage chat.", truth: "code_verified", intent: "intended", code_anchors: [{ file: "src/onboarding.ts" }] },
      ],
      edges: [
        { id: "edge.supersede", from_id: "claim.v2", from_type: "claim", to_id: "claim.v1", to_type: "claim", kind: "supersedes" },
      ],
    },
  });

  // --- before promote: working holds the 3 new memberships, main holds 2, and the
  //     union view already retires v1 in favour of v2 ---
  assert.equal(membershipCount(initialized.working_scope_id), 3, "working starts with 3 memberships");
  assert.equal(membershipCount(initialized.main_scope_id), 2, "main starts with 2 memberships");

  let graph = service.readGraph(repo);
  assert.ok(claimIds(graph).has("claim.v2"), "v2 is live before promote");
  assert.ok(!claimIds(graph).has("claim.v1"), "v1 is superseded before promote");

  // --- promote: every working membership moves into main under one commit ---
  const report = service.promoteWorking(repo);
  assert.deepEqual(report.promoted, { components: 1, flows: 0, claims: 1, edges: 1 }, "promoted counts");
  assert.equal(report.total, 3, "promoted total");
  assert.ok(report.memory_commit_id, "a main memory commit owns the promoted subjects");

  // --- after promote: working is empty, main owns everything, and NOTHING was
  //     deleted (object rows are global) ---
  assert.equal(membershipCount(initialized.working_scope_id), 0, "working scope cleared");
  assert.equal(membershipCount(initialized.main_scope_id), 5, "main now owns all 5 subjects");
  for (const [type, id] of [
    ["component", "component.onboarding"],
    ["component", "component.worker"],
    ["claim", "claim.v1"],
    ["claim", "claim.v2"],
    ["edge", "edge.supersede"],
  ]) {
    assert.equal(repository.subjectExists(initialized.repo_id, type, id), true, `${id} row preserved`);
  }

  // --- the design fork: because the supersedes edge travelled with the claim,
  //     v1 stays retired even now that working is empty. If the edge had been
  //     left behind, v1 would resurface here. ---
  graph = service.readGraph(repo);
  assert.ok(claimIds(graph).has("claim.v2"), "v2 still live after promote");
  assert.ok(!claimIds(graph).has("claim.v1"), "v1 still superseded after promote (supersedes edge promoted too)");

  // --- idempotent: a second promote finds nothing in working ---
  const again = service.promoteWorking(repo);
  assert.deepEqual(again.promoted, { components: 0, flows: 0, claims: 0, edges: 0 }, "second promote is a no-op");
  assert.equal(again.total, 0, "second promote total is zero");
  assert.equal(again.memory_commit_id, undefined, "no commit created when working is empty");

  // --- pure counting helper stands alone ---
  assert.deepEqual(
    countPromotedSubjects([
      { type: "component", id: "c1" },
      { type: "claim", id: "k1" },
      { type: "claim", id: "k2" },
      { type: "edge", id: "e1" },
    ]),
    { components: 1, flows: 0, claims: 2, edges: 1 },
    "countPromotedSubjects tallies by type",
  );
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("Graph promote checks passed.");
