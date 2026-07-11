import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { graphContextConfig } = await import(new URL("dist/libs/knowledge-graph/graph-context/config.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-proposal-apply-atomicity-test-"));
const db = openDatabase(join(tmp, "graph.db"));

const repoRef = {
  repo_root: join(tmp, "repo"),
  repo_name: "proposal-apply-atomicity",
  default_branch: "main",
};
const proposal = {
  title: "Proposal apply atomicity",
  creates: {
    components: [{ id: "component.atomicity", name: "Atomicity Component" }],
    flows: [{ id: "flow.atomicity", name: "Atomicity Flow", touches: "component.atomicity" }],
    claims: [
      {
        id: "claim.atomicity",
        kind: "fact",
        text: "Proposal apply is atomic when embedding generation fails.",
        truth: "source_verified",
        intent: "intended",
        about: "component.atomicity",
      },
    ],
    sources: [
      {
        id: "source.atomicity",
        kind: "session",
        ref: "test:proposal-apply-atomicity",
      },
    ],
    edges: [
      {
        kind: "evidenced_by",
        from: "claim.atomicity",
        to: "source.atomicity",
        metadata: { reason: "Deterministic proposal apply test." },
      },
    ],
  },
};

try {
  const repository = new SqliteRepository(db);
  const failingContextBuilder = {
    async ensureForGraph(repoId, graph, config) {
      repository.insertGraphObjectEmbeddings([
        {
          repo_id: repoId,
          object_type: "component",
          object_id: graph.components[0].id,
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          embedding: Buffer.alloc(config.embedding.dimensions * Float32Array.BYTES_PER_ELEMENT),
        },
      ]);
      throw new Error("synthetic embedding failure");
    },
  };
  const failingService = new KnowledgeGraphService(repository, graphContextConfig, failingContextBuilder);
  failingService.initRepo(repoRef);

  await assert.rejects(
    failingService.applyProposal(repoRef, proposal),
    /synthetic embedding failure/,
  );

  const failedGraph = failingService.readGraph(repoRef);
  assert.deepEqual(failedGraph.components, []);
  assert.deepEqual(failedGraph.flows, []);
  assert.deepEqual(failedGraph.claims, []);
  assert.deepEqual(failedGraph.sources, []);
  assert.deepEqual(failedGraph.edges, []);

  for (const table of [
    "components",
    "flows",
    "claims",
    "sources",
    "edges",
    "graph_memberships",
    "memory_commits",
    "graph_object_embeddings",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    assert.equal(row.count, 0, `${table} must not retain rows from a failed proposal apply`);
  }

  const successfulContextBuilder = {
    async ensureForGraph(_repoId, graph) {
      const checkedObjects = graph.components.length + graph.flows.length + graph.claims.length;
      return { checked_objects: checkedObjects, created: 0, reused: checkedObjects };
    },
  };
  const successfulService = new KnowledgeGraphService(repository, graphContextConfig, successfulContextBuilder);
  await successfulService.applyProposal(repoRef, proposal);

  const successfulGraph = successfulService.readGraph(repoRef);
  assert.deepEqual(successfulGraph.components.map((component) => component.id), ["component.atomicity"]);
  assert.deepEqual(successfulGraph.flows.map((flow) => flow.id), ["flow.atomicity"]);
  assert.deepEqual(successfulGraph.claims.map((claim) => claim.id), ["claim.atomicity"]);
  assert.deepEqual(successfulGraph.sources.map((source) => source.id), ["source.atomicity"]);
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("check-proposal-apply-atomicity: ok");
