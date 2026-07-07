import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { findSimilarClaims, similarClaimWarning } = await import(new URL("dist/libs/knowledge-graph/duplicate-claims.js", root));
const { graphContextConfig } = await import(new URL("dist/libs/knowledge-graph/graph-context/config.js", root));
const { float32ArrayToBuffer } = await import(new URL("dist/libs/knowledge-graph/graph-context/vector.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const config = {
  ...graphContextConfig,
  embedding: {
    provider: "local",
    model: "deterministic-test-embedder",
    dimensions: 3,
    batchSize: 8,
  },
  similarClaims: {
    threshold: graphContextConfig.similarClaims.threshold,
    maxMatchesPerClaim: 2,
  },
};

const existingClaim = {
  id: "claim.compute_total_discount",
  kind: "fact",
  text: "computeTotal applies a flat 5% discount.",
  truth: "code_verified",
  intent: "intended",
};

const graph = {
  components: [],
  flows: [],
  claims: [existingClaim],
  sources: [],
  edges: [],
};

const repository = {
  listGraphObjectEmbeddings: () => [{
    repo_id: "repo.test",
    object_type: "claim",
    object_id: existingClaim.id,
    provider: config.embedding.provider,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    embedding: float32ArrayToBuffer([1, 0, 0]),
    created_at: new Date(0).toISOString(),
  }],
};

const embedder = {
  async embedBatch(texts) {
    return texts.map(vectorForText);
  },
};

const matches = await findSimilarClaims({
  repo_id: "repo.test",
  graph,
  creates: {
    claims: [
      {
        id: "claim.exact_duplicate",
        kind: "fact",
        text: "computeTotal applies a flat 5% discount.",
        truth: "code_verified",
        intent: "intended",
      },
      {
        id: "claim.paraphrase_duplicate",
        kind: "fact",
        text: "computeTotal subtracts five percent from the amount.",
        truth: "code_verified",
        intent: "intended",
      },
      {
        id: "claim.related_distinct",
        kind: "fact",
        text: "computeTotal applies sales tax after subtotal calculation.",
        truth: "code_verified",
        intent: "intended",
      },
      {
        id: "claim.unrelated",
        kind: "fact",
        text: "The graph view renders claim freshness charts.",
        truth: "code_verified",
        intent: "intended",
      },
    ],
  },
  repository,
  config,
  embedder,
});

assert.deepEqual(
  matches.map((match) => match.claim_id),
  ["claim.exact_duplicate", "claim.paraphrase_duplicate"],
);
assert.ok(matches.every((match) => match.matched_claim_id === existingClaim.id));
assert.ok(matches.every((match) => match.score >= config.similarClaims.threshold));
assert.match(similarClaimWarning(matches[0]), /supersedes: "claim.compute_total_discount"/);

const tmp = mkdtempSync(join(tmpdir(), "greplica-duplicate-claims-test-"));
const db = openDatabase(join(tmp, "graph.db"));
try {
  const sqliteRepository = new SqliteRepository(db);
  const warning = "claim.new is similar to existing claim.old (score 0.950 >= 0.750). Consider adding supersedes: \"claim.old\" instead of creating a fresh duplicate claim.";
  const service = new KnowledgeGraphService(
    sqliteRepository,
    config,
    { ensureForGraph: async () => ({ checked_objects: 0, created: 0, reused: 0 }) },
    async () => [{
      claim_id: "claim.new",
      claim_text: "New duplicate claim.",
      matched_claim_id: "claim.old",
      matched_claim_text: "Old duplicate claim.",
      score: 0.95,
      threshold: graphContextConfig.similarClaims.threshold,
    }],
  );
  const repo = {
    repo_root: join(tmp, "repo"),
    repo_name: "duplicate-claims",
    default_branch: "main",
  };
  service.initRepo(repo);

  const proposal = {
    title: "Duplicate warning stays soft",
    creates: {
      claims: [
        {
          id: "claim.new",
          kind: "fact",
          text: "New duplicate claim.",
          truth: "unknown",
          intent: "unknown",
        },
      ],
    },
  };

  const validation = await service.validateProposal(repo, proposal);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.warnings, [warning]);

  const applied = await service.applyProposal(repo, proposal);
  assert.deepEqual(applied.warnings, [warning]);
  assert.equal(applied.created.claims, 1);
  assert.equal(service.readGraph(repo).claims.some((claim) => claim.id === "claim.new"), true);
} finally {
  db.close();
}

console.log("Duplicate claim checks passed.");

function vectorForText(text) {
  if (text.includes("five percent") || text.includes("5% discount")) return [1, 0, 0];
  if (text.includes("sales tax")) return [0.72, 0.694, 0];
  if (text.includes("freshness charts")) return [0, 0, 1];
  return [0, 1, 0];
}
