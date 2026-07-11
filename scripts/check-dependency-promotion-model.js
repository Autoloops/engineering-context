import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for issue #79's fix mechanism: promoting a dependency to
// a component and connecting it with `about`/`touches` (not `contains`) is
// what makes it a genuine graph object instead of text trapped inside a
// claim. This proves the structural half of the fix deterministically,
// without embeddings (see check-dependency-promotion-retrieval.js, run
// separately via `npm run test:dependency-promotion-retrieval`, for the
// slower embedding-backed proof that this structure is actually what
// `graph context "<name>"` surfaces).

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-dependency-promotion-model-test-"));

function setupRepo(name) {
  const db = openDatabase(join(tmp, `${name}.db`));
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = { repo_root: join(tmp, name), repo_name: name, default_branch: "main" };
  const initialized = service.initRepo(repo);
  const memoryCommit = repository.createMemoryCommit({
    scope_id: initialized.working_scope_id,
    title: "seed",
  });
  return { db, repository, service, repo, initialized, memoryCommit };
}

// --- Case A: the bug as reported - a dependency mentioned only in claim
// text, with no component of its own. ---
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("bug-repro");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Bug repro: dependency only in claim text",
      creates: {
        components: [{ id: "component.api", name: "API Server" }],
        claims: [
          {
            id: "claim.integrates_with_broker",
            kind: "fact",
            text: "API Server integrates with a message broker for event delivery.",
            truth: "unknown",
            intent: "unknown",
            about: ["component.api"],
          },
        ],
      },
    }));

    const graph = service.readGraph(repo);
    assert.equal(graph.components.length, 1, "only the internal component should exist - no dedicated node for the dependency");
    assert.equal(
      graph.components[0].id,
      "component.api",
      "the dependency must not have accidentally become a component in the buggy shape",
    );
    assert.ok(
      graph.claims.some((claim) => claim.text.includes("message broker")),
      "the dependency name should only be reachable as text inside the claim, reproducing the reported bug",
    );
  } finally {
    db.close();
  }
}

// --- Case B: the fix as taught by the promotion guidance - a component
// for the dependency, connected via `about`/`touches`, never `contains`. ---
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("fix-applied");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Fix applied: dependency promoted to a component",
      creates: {
        components: [
          { id: "component.api", name: "API Server", code_anchor: "src/api.ts" },
          { id: "component.broker", name: "Message Broker", code_anchor: "docker-compose.yml" },
        ],
        flows: [{ id: "flow.ingest", name: "Event Ingestion", touches: ["component.api", "component.broker"] }],
        claims: [
          {
            id: "claim.api_publishes_to_broker",
            kind: "fact",
            text: "API Server publishes ingest events to the Message Broker.",
            truth: "unknown",
            intent: "unknown",
            about: ["component.api", "component.broker"],
          },
        ],
      },
    }));

    const graph = service.readGraph(repo);
    const broker = graph.components.find((component) => component.id === "component.broker");
    assert.ok(broker, "the dependency must exist as its own component");
    assert.equal(broker.name, "Message Broker");
    assert.equal(broker.code_anchor, "docker-compose.yml", "the dependency must be anchored at its declaration point");

    const aboutEdges = graph.edges.filter((edge) => edge.kind === "about" && edge.to_id === "component.broker");
    assert.equal(aboutEdges.length, 1, "the dependency must be reachable through an `about` edge from a claim");
    assert.equal(aboutEdges[0].from_id, "claim.api_publishes_to_broker");

    const touchesEdges = graph.edges.filter((edge) => edge.kind === "touches" && edge.to_id === "component.broker");
    assert.equal(touchesEdges.length, 1, "the dependency must participate in flow `touches` like any other component");
    assert.equal(touchesEdges[0].from_id, "flow.ingest");

    const containsEdges = graph.edges.filter(
      (edge) => edge.kind === "contains" && (edge.to_id === "component.broker" || edge.from_id === "component.broker"),
    );
    assert.equal(
      containsEdges.length,
      0,
      "the dependency must not be nested under an internal component with `contains` - the repo does not own it",
    );
  } finally {
    db.close();
  }
}

console.log("check-dependency-promotion-model: ok");
