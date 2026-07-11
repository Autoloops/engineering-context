import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slow, embedding-backed proof for issue #79's fix: reproduces the exact
// symptom from the issue (`greplica graph context "<name>"` returns claims
// instead of a dedicated node) and confirms it is fixed once the promotion
// guidance's recipe is followed. Uses the real local embedding model, which
// downloads/loads on first use (~10s+ per call), so this is intentionally
// NOT part of `npm test`. Run explicitly with:
//
//   npm run test:dependency-promotion-retrieval
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

// --- Before: dependency only in claim text - reproduces the issue. ---
let bugReproComponents;
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("bug-repro");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Bug repro",
      creates: {
        components: [{ id: "component.api", name: "API Server" }],
        claims: [
          {
            id: "claim.integrates_with_broker",
            kind: "fact",
            text: "API Server integrates with the Broker for event delivery.",
            truth: "unknown",
            intent: "unknown",
            about: ["component.api"],
          },
        ],
      },
    }));

    const result = await service.contextGraph(repo, "Broker");
    bugReproComponents = result.components.map((component) => component.object.name);
  } finally {
    db.close();
  }
}

assert.ok(
  !bugReproComponents.includes("Broker"),
  `expected no dedicated "Broker" component node when it is only mentioned in claim text (issue #79's reported bug), got: ${JSON.stringify(bugReproComponents)}`,
);
console.log(`Before promotion: graph context "Broker" -> components: ${JSON.stringify(bugReproComponents)} (no dedicated node - bug reproduced)`);

// --- After: dependency promoted to a component per the guidance. ---
let fixedComponents;
{
  const { db, repository, service, repo, initialized, memoryCommit } = setupRepo("fix-applied");
  try {
    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, normalizeProposal({
      title: "Fix applied",
      creates: {
        components: [
          { id: "component.api", name: "API Server", code_anchor: "src/api.ts" },
          { id: "component.broker", name: "Broker", code_anchor: "docker-compose.yml" },
        ],
        flows: [{ id: "flow.ingest", name: "Event Ingestion", touches: ["component.api", "component.broker"] }],
        claims: [
          {
            id: "claim.api_publishes_to_broker",
            kind: "fact",
            text: "API Server publishes ingest events to the Broker.",
            truth: "unknown",
            intent: "unknown",
            about: ["component.api", "component.broker"],
          },
        ],
      },
    }));

    const result = await service.contextGraph(repo, "Broker");
    fixedComponents = result.components.map((component) => component.object.name);
  } finally {
    db.close();
  }
}

assert.ok(
  fixedComponents.includes("Broker"),
  `expected "Broker" to be returned as a dedicated ranked component after promotion, got: ${JSON.stringify(fixedComponents)}`,
);
console.log(`After promotion: graph context "Broker" -> components: ${JSON.stringify(fixedComponents)} (fixed)`);

console.log("check-dependency-promotion-retrieval: ok");
