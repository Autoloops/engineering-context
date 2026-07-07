import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));
const { validateProposal } = await import(new URL("dist/libs/knowledge-graph/validate-proposal.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const components = [
  { id: "component.a", name: "A" },
  { id: "component.b", name: "B" },
];

// Edge written with canonical field names but no types (issue #82) must not crash
// normalization, and must surface as a validation error.
const malformedEdge = {
  title: "Malformed edge repro",
  creates: {
    components,
    edges: [{ from_id: "component.a", to_id: "component.b", kind: "contains" }],
  },
};

let normalized;
assert.doesNotThrow(() => {
  normalized = normalizeProposal(malformedEdge);
}, "normalizeProposal must not throw on a malformed edge");

const malformedResult = validateProposal(normalized);
assert.equal(malformedResult.valid, false, "malformed edge proposal must be invalid");
assert.ok(
  malformedResult.errors.some((error) => error.includes("from'/'to")),
  `expected a from/to guidance error, got: ${JSON.stringify(malformedResult.errors)}`,
);

// Edge missing kind must also be reported, not crash.
const missingKindEdge = {
  title: "Missing kind repro",
  creates: {
    components,
    edges: [{ from: "component.a", to: "component.b" }],
  },
};

let normalizedMissingKind;
assert.doesNotThrow(() => {
  normalizedMissingKind = normalizeProposal(missingKindEdge);
}, "normalizeProposal must not throw on an edge without kind");
assert.equal(validateProposal(normalizedMissingKind).valid, false, "edge without kind must be invalid");

// A well-formed compact edge must keep validating cleanly.
const compactEdge = {
  title: "Compact edge",
  creates: {
    components,
    edges: [{ kind: "contains", from: "component.a", to: "component.b" }],
  },
};

const compactResult = validateProposal(normalizeProposal(compactEdge));
assert.equal(compactResult.valid, true, `compact edge must stay valid, got: ${JSON.stringify(compactResult.errors)}`);

const tmp = mkdtempSync(join(tmpdir(), "greplica-proposal-validate-test-"));
const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repoA = {
    repo_root: join(tmp, "repo-a"),
    repo_name: "repo-a",
    default_branch: "main",
  };
  const repoB = {
    repo_root: join(tmp, "repo-b"),
    repo_name: "repo-b",
    default_branch: "main",
  };
  const repoC = {
    repo_root: join(tmp, "repo-c"),
    repo_name: "repo-c",
    default_branch: "main",
  };
  const repoAProposal = {
    title: "Seed CLI component",
    creates: {
      components: [{ id: "component.cli", name: "Repo A CLI" }],
    },
  };
  const repoBProposal = {
    title: "Seed CLI component",
    creates: {
      components: [{ id: "component.cli", name: "Repo B CLI" }],
    },
  };

  const initializedA = service.initRepo(repoA);
  const initializedB = service.initRepo(repoB);
  service.initRepo(repoC);
  const memoryCommit = repository.createMemoryCommit({
    scope_id: initializedA.working_scope_id,
    title: "Seed repo A",
  });
  repository.createProposalRecords(initializedA.working_scope_id, memoryCommit.id, normalizeProposal(repoAProposal));

  const repoBResult = await service.validateProposal(repoB, repoBProposal);
  assert.equal(
    repoBResult.valid,
    true,
    `repo B must be able to create its own component.cli, got: ${JSON.stringify(repoBResult.errors)}`,
  );

  const repoCCrossReference = await service.validateProposal(repoC, {
    title: "Repo C cross-repo compact reference",
    creates: {
      claims: [
        {
          id: "claim.about_cli",
          kind: "fact",
          text: "Repo C references a CLI component.",
          truth: "unknown",
          intent: "unknown",
          about: "component.cli",
        },
      ],
    },
  });
  assert.equal(repoCCrossReference.valid, false, "repo C must not resolve compact references through repo A");
  assert.ok(
    repoCCrossReference.errors.some((error) => error.includes("component:component.cli")),
    `expected repo C to report missing component.cli, got: ${JSON.stringify(repoCCrossReference.errors)}`,
  );

  const repoBMemoryCommit = repository.createMemoryCommit({
    scope_id: initializedB.working_scope_id,
    title: "Seed repo B",
  });
  repository.createProposalRecords(initializedB.working_scope_id, repoBMemoryCommit.id, normalizeProposal(repoBProposal));

  const repoBDuplicateResult = await service.validateProposal(repoB, repoBProposal);
  assert.equal(repoBDuplicateResult.valid, false, "repo B must still reject duplicate IDs inside the same repo");
  assert.ok(
    repoBDuplicateResult.errors.includes("component:component.cli already exists."),
    `expected repo B duplicate error, got: ${JSON.stringify(repoBDuplicateResult.errors)}`,
  );

  const repoAGraph = service.readGraph(repoA);
  const repoBGraph = service.readGraph(repoB);
  assert.deepEqual(repoAGraph.components.map((component) => component.name), ["Repo A CLI"]);
  assert.deepEqual(repoBGraph.components.map((component) => component.name), ["Repo B CLI"]);
  assert.equal(initializedB.repo_id === initializedA.repo_id, false, "test repos must be distinct");
} finally {
  db.close();
}

console.log("check-proposal-validate: ok");
