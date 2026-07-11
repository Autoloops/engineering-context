import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slow, embedding-backed proof for issue #79's fix: reproduces the exact
// symptom from the issue (`greplica graph context "<name>"` returns claims
// instead of a dedicated node) and confirms it is fixed once the promotion
// guidance's recipe is followed. Covers a spread of real dependency shapes
// from the issue (message broker, cache, container platform, orchestrator,
// ORM, analytics store, relational store) so the proof isn't an artifact of
// one technology's name/word-shape. Uses the real local embedding model,
// which downloads/loads on first use (~10s+ for the first call, fast after
// that within the same process), so this is intentionally NOT part of
// `npm test`. Run explicitly with:
//
//   node scripts/check-dependency-promotion-retrieval.js
//
// See check-dependency-promotion-model.js for the fast, embedding-free
// structural regression test that runs on every `npm test`.

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-dependency-promotion-retrieval-test-"));
process.env.GREPLICA_HOME = tmp;

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

console.log("Loading local embedding model (first call is slow)...");

// --- Before: every dependency only mentioned in claim text - reproduces
// the issue for each technology. ---
const bugReproResults = {};
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("bug-repro");
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

    for (const dependency of dependencies) {
      const result = await service.contextGraph(repo, dependency.name);
      bugReproResults[dependency.name] = result.components.map((component) => component.object.name);
    }
  } finally {
    db.close();
  }
}

for (const dependency of dependencies) {
  const components = bugReproResults[dependency.name];
  assert.ok(
    !components.includes(dependency.name),
    `expected no dedicated "${dependency.name}" component node when it is only mentioned in claim text (issue #79's reported bug), got: ${JSON.stringify(components)}`,
  );
  console.log(`Before promotion: graph context "${dependency.name}" -> components: ${JSON.stringify(components)} (no dedicated node - bug reproduced)`);
}

// --- After: every dependency promoted to a component per the guidance. ---
const fixedResults = {};
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("fix-applied");
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

    for (const dependency of dependencies) {
      const result = await service.contextGraph(repo, dependency.name);
      fixedResults[dependency.name] = result.components.map((component) => component.object.name);
    }
  } finally {
    db.close();
  }
}

for (const dependency of dependencies) {
  const components = fixedResults[dependency.name];
  assert.ok(
    components.includes(dependency.name),
    `expected "${dependency.name}" to be returned as a dedicated ranked component after promotion, got: ${JSON.stringify(components)}`,
  );
  console.log(`After promotion: graph context "${dependency.name}" -> components: ${JSON.stringify(components)} (fixed)`);
}

console.log(`check-dependency-promotion-retrieval: ok (${dependencies.length} dependency shapes verified: ${dependencies.map((d) => d.name).join(", ")})`);
