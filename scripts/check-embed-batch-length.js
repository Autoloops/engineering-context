import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { GraphContextBuilder } = await import(
  new URL("dist/libs/knowledge-graph/graph-context/context-builder.js", root)
);

const tmp = mkdtempSync(join(tmpdir(), "greplica-embed-batch-"));
const db = openDatabase(join(tmp, "graph.db"));
const repository = new SqliteRepository(db);
const builder = new GraphContextBuilder(repository);

const repo = {
  repo_root: tmp,
  repo_name: "embed-batch-check",
  default_branch: "main",
};
const { id: repoId } = repository.upsertRepo(repo).repo;

const dimensions = 8;
const config = {
  version: "test-embed-batch",
  embedding: {
    provider: "local",
    model: "test-model",
    dimensions,
    batchSize: 16,
  },
  ranking: {
    semanticThreshold: 0.1,
    selectionThreshold: 0.8,
    packetMinimumScore: 0.15,
    packetAdditionalDirectScoreFloor: 0.15,
    minimumSelectedClaims: 1,
    weights: { semantic: 1, bm25: 0 },
    bm25: { k1: 1.5, b: 0.75 },
    claimSupport: { weight: 0, countBoost: 0 },
    directObject: { weight: 0 },
    graphBoost: {
      claimAboutTarget: 0,
      containsParentToChild: 0,
      containsChildToParent: 0,
      touchesComponentToFlow: 0,
      maxSources: 1,
    },
    packetHubPenalty: {
      weight: 0,
      graphScoreThreshold: 0,
      claimSupportThreshold: 0,
      bm25Threshold: 0,
      semanticThreshold: 0,
      coherenceThreshold: 0,
    },
    coherence: {
      weight: 0,
      neighborThreshold: 0,
      degreePenalty: 0,
      aboutWeight: 0,
      touchesWeight: 0,
      containsWeight: 0,
      maxSources: 1,
    },
  },
  dedupe: { similarityThreshold: 0.75 },
};

const graph = {
  components: [],
  flows: [],
  claims: [
    {
      id: "claim.one",
      kind: "fact",
      text: "first claim text for embedding",
      truth: "source_verified",
      intent: "intended",
    },
    {
      id: "claim.two",
      kind: "fact",
      text: "second claim text for embedding",
      truth: "source_verified",
      intent: "intended",
    },
  ],
  sources: [],
  edges: [],
};

const shortBatchEmbedder = {
  async embed() {
    return Array.from({ length: dimensions }, () => 0.1);
  },
  async embedBatch(texts) {
    // Deliberately return fewer vectors than texts.
    return texts.slice(0, Math.max(0, texts.length - 1)).map(() => Array.from({ length: dimensions }, () => 0.2));
  },
};

await assert.rejects(
  () => builder.ensureForGraph(repoId, graph, config, shortBatchEmbedder),
  (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /embedBatch|vector/i);
    return true;
  },
);

const rowsAfterShortBatch = repository.listGraphObjectEmbeddings({
  repo_id: repoId,
  provider: config.embedding.provider,
  model: config.embedding.model,
  dimensions: config.embedding.dimensions,
});
assert.equal(rowsAfterShortBatch.length, 0, "short embedBatch must not insert embedding rows");

const emptyVectorEmbedder = {
  async embed() {
    return Array.from({ length: dimensions }, () => 0.1);
  },
  async embedBatch(texts) {
    return texts.map(() => []);
  },
};

await assert.rejects(
  () => builder.ensureForGraph(repoId, graph, config, emptyVectorEmbedder),
  (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /empty|length|dimension|vector/i);
    return true;
  },
);

const rowsAfterEmpty = repository.listGraphObjectEmbeddings({
  repo_id: repoId,
  provider: config.embedding.provider,
  model: config.embedding.model,
  dimensions: config.embedding.dimensions,
});
assert.equal(rowsAfterEmpty.length, 0, "empty vectors must not insert embedding rows");

const wrongDimensionEmbedder = {
  async embed() {
    return Array.from({ length: dimensions }, () => 0.1);
  },
  async embedBatch(texts) {
    return texts.map(() => Array.from({ length: dimensions - 1 }, () => 0.3));
  },
};

await assert.rejects(
  () => builder.ensureForGraph(repoId, graph, config, wrongDimensionEmbedder),
  (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /dimension|length|vector/i);
    return true;
  },
);

const rowsAfterWrongDim = repository.listGraphObjectEmbeddings({
  repo_id: repoId,
  provider: config.embedding.provider,
  model: config.embedding.model,
  dimensions: config.embedding.dimensions,
});
assert.equal(rowsAfterWrongDim.length, 0, "wrong-dimension vectors must not insert embedding rows");

const healthyEmbedder = {
  async embed() {
    return Array.from({ length: dimensions }, () => 0.1);
  },
  async embedBatch(texts) {
    return texts.map((_, index) => Array.from({ length: dimensions }, () => 0.01 * (index + 1)));
  },
};

const status = await builder.ensureForGraph(repoId, graph, config, healthyEmbedder);
assert.equal(status.created, 2);
const rowsHealthy = repository.listGraphObjectEmbeddings({
  repo_id: repoId,
  provider: config.embedding.provider,
  model: config.embedding.model,
  dimensions: config.embedding.dimensions,
});
assert.equal(rowsHealthy.length, 2);
for (const row of rowsHealthy) {
  assert.ok(row.embedding.byteLength > 0, "healthy embeddings must be non-empty BLOBs");
}

db.close();
console.log("Embed batch length checks passed.");
