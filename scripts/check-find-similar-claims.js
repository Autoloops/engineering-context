import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { findSimilarClaims } = await import(
  new URL("dist/libs/knowledge-graph/dedupe/find-similar-claims.js", root)
);

const identical = new Float32Array([1, 0, 0]);
const nearDuplicate = new Float32Array([0.99, 0.14, 0]); // cosine ~0.99
const distinct = new Float32Array([0, 1, 0]); // cosine 0 vs identical
const somewhatRelated = new Float32Array([0.6, 0.8, 0]); // cosine 0.6 vs identical

// Exact duplicate should be flagged with similarity 1.
{
  const matches = findSimilarClaims(identical, [{ claim_id: "claim.exact", vector: identical }], 0.9);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].claim_id, "claim.exact");
  assert.equal(matches[0].similarity, 1);
}

// Near-duplicate above threshold should be flagged.
{
  const matches = findSimilarClaims(identical, [{ claim_id: "claim.near", vector: nearDuplicate }], 0.9);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].claim_id, "claim.near");
}

// Orthogonal (unrelated) vector should not be flagged.
{
  const matches = findSimilarClaims(identical, [{ claim_id: "claim.distinct", vector: distinct }], 0.9);
  assert.equal(matches.length, 0);
}

// Similarity below threshold should not be flagged.
{
  const matches = findSimilarClaims(identical, [{ claim_id: "claim.related", vector: somewhatRelated }], 0.9);
  assert.equal(matches.length, 0);
}

// Empty existing set returns empty matches, no crash.
{
  const matches = findSimilarClaims(identical, [], 0.9);
  assert.deepEqual(matches, []);
}

// Multiple matches are sorted descending by similarity.
{
  const matches = findSimilarClaims(
    identical,
    [
      { claim_id: "claim.low", vector: somewhatRelated },
      { claim_id: "claim.high", vector: nearDuplicate },
    ],
    0.5
  );
  assert.equal(matches.length, 2);
  assert.equal(matches[0].claim_id, "claim.high");
  assert.equal(matches[1].claim_id, "claim.low");
}

// Threshold is inclusive at the exact similarity value.
{
  const matches = findSimilarClaims(identical, [{ claim_id: "claim.eq", vector: identical }], 1);
  assert.equal(matches.length, 1);
}

console.log("Find similar claims checks passed.");