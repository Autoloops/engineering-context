import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for issue #79's fix mechanism: promoting a dependency to
// a component and connecting it with `about`/`touches` (not `contains`) is
// what makes it a genuine graph object instead of text trapped inside a
// claim. This proves the structural half of the fix deterministically,
// without embeddings, across a spread of real dependency shapes named in
// the original issue (message broker, cache, relational store via an ORM,
// analytics store, deploy platform) so the proof isn't an artifact of one
// technology's name. See check-dependency-promotion-retrieval.js (run
// directly with `node scripts/check-dependency-promotion-retrieval.js`) for
// the slower embedding-backed proof that this structure is actually what
// `graph context "<name>"` surfaces.

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-dependency-promotion-model-test-"));

const dependencies = [
  { id: "component.kafka", name: "Kafka", anchor: "k8s/kafka-statefulset.yaml", relation: "publishes ingest events to" },
  { id: "component.redis", name: "Redis", anchor: "docker-compose.yml", relation: "caches session data in" },
  { id: "component.docker", name: "Docker", anchor: "Dockerfile", relation: "is containerized with" },
  { id: "component.ecs", name: "ECS", anchor: "deploy/ecs-task-definition.json", relation: "is deployed on" },
  { id: "component.prisma", name: "Prisma", anchor: "prisma/schema.prisma", relation: "accesses its database through" },
  { id: "component.clickhouse", name: "ClickHouse", anchor: "k8s/clickhouse-deployment.yaml", relation: "ships analytics events to" },
  { id: "component.postgres", name: "Postgres", anchor: "prisma/schema.prisma", relation: "persists orders in" },
];

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

// --- Case A: the bug as reported - dependencies mentioned only in claim
// text, with no component of their own. ---
{
  const { db, service, repository, repo, initialized, memoryCommit } = setupRepo("bug-repro");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Bug repro: dependencies only in claim text",
      creates: {
        components: [{ id: "component.api", name: "API Server" }],
        claims: dependencies.map((dependency) => ({
          id: `claim.integrates_with_${dependency.id.replace("component.", "")}`,
          kind: "fact",
          text: `API Server ${dependency.relation} ${dependency.name}.`,
          truth: "unknown",
          intent: "unknown",
          about: ["component.api"],
        })),
      },
    }));

    const graph = service.readGraph(repo);
    assert.equal(graph.components.length, 1, "only the internal component should exist - no dedicated node for any dependency");
    assert.equal(
      graph.components[0].id,
      "component.api",
      "no dependency should have accidentally become a component in the buggy shape",
    );
    for (const dependency of dependencies) {
      assert.ok(
        graph.claims.some((claim) => claim.text.includes(dependency.name)),
        `${dependency.name} should only be reachable as text inside a claim, reproducing the reported bug`,
      );
    }
  } finally {
    db.close();
  }
}

// --- Case B: the fix as taught by the promotion guidance - a component per
// dependency, each connected via `about`/`touches`, never `contains`. ---
{
  const { db, service, repository, repo, initialized, memoryCommit } = setupRepo("fix-applied");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Fix applied: dependencies promoted to components",
      creates: {
        components: [
          { id: "component.api", name: "API Server", code_anchor: "src/api.ts" },
          ...dependencies.map((dependency) => ({ id: dependency.id, name: dependency.name, code_anchor: dependency.anchor })),
        ],
        flows: dependencies.map((dependency) => ({
          id: `flow.${dependency.id.replace("component.", "")}_usage`,
          name: `API Server / ${dependency.name} interaction`,
          touches: ["component.api", dependency.id],
        })),
        claims: dependencies.map((dependency) => ({
          id: `claim.api_uses_${dependency.id.replace("component.", "")}`,
          kind: "fact",
          text: `API Server ${dependency.relation} ${dependency.name}.`,
          truth: "unknown",
          intent: "unknown",
          about: ["component.api", dependency.id],
        })),
      },
    }));

    const graph = service.readGraph(repo);

    for (const dependency of dependencies) {
      const component = graph.components.find((candidate) => candidate.id === dependency.id);
      assert.ok(component, `${dependency.name} must exist as its own component`);
      assert.equal(component.name, dependency.name);
      assert.equal(component.code_anchor, dependency.anchor, `${dependency.name} must be anchored at its declaration point`);

      const aboutEdges = graph.edges.filter((edge) => edge.kind === "about" && edge.to_id === dependency.id);
      assert.equal(aboutEdges.length, 1, `${dependency.name} must be reachable through an \`about\` edge from a claim`);

      const touchesEdges = graph.edges.filter((edge) => edge.kind === "touches" && edge.to_id === dependency.id);
      assert.equal(touchesEdges.length, 1, `${dependency.name} must participate in flow \`touches\` like any other component`);

      const containsEdges = graph.edges.filter(
        (edge) => edge.kind === "contains" && (edge.to_id === dependency.id || edge.from_id === dependency.id),
      );
      assert.equal(
        containsEdges.length,
        0,
        `${dependency.name} must not be nested under an internal component with \`contains\` - the repo does not own it`,
      );
    }
  } finally {
    db.close();
  }
}

console.log(`check-dependency-promotion-model: ok (${dependencies.length} dependency shapes verified: ${dependencies.map((d) => d.name).join(", ")})`);
