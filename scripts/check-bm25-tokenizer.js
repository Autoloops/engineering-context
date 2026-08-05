import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { tokenize, scoreBm25 } = await import(new URL("dist/libs/knowledge-graph/graph-context/bm25.js", root));
const { graphContextConfig } = await import(new URL("dist/libs/knowledge-graph/graph-context/config.js", root));
const { applyGraphRanking } = await import(new URL("dist/libs/knowledge-graph/graph-context/graph-rank.js", root));
const { rankContextDocuments } = await import(new URL("dist/libs/knowledge-graph/graph-context/rank.js", root));

assert.ok(tokenize("handleUserAuth").includes("user"), "camelCase should emit sub-token user");
assert.ok(tokenize("handleUserAuth").includes("auth"), "camelCase should emit sub-token auth");
assert.ok(tokenize("handleUserAuth").includes("handle"), "camelCase should emit sub-token handle");
assert.ok(tokenize("handleUserAuth").includes("handleuserauth"), "camelCase should keep full lowercased token");

assert.ok(tokenize("HandleUserAuth").includes("user"), "PascalCase should emit sub-token user");
assert.ok(tokenize("handle_user_auth").includes("user"), "snake_case should emit sub-token user");
assert.ok(tokenize("handle_user_auth").includes("handle_user_auth"), "snake_case should keep original token");

assert.ok(tokenize("graph-context").includes("graph"), "kebab-case should emit sub-token graph");
assert.ok(tokenize("graph-context").includes("context"), "kebab-case should emit sub-token context");

assert.ok(tokenize("user2FA").includes("user"), "letter-number boundary should emit user");
assert.ok(tokenize("user2FA").includes("fa"), "letter-number boundary should emit fa");

assert.ok(tokenize("tokens").includes("token"), "English stemming variants should still apply");

const documents = [{ key: "doc:auth", text: "The handleUserAuth function validates sessions." }];
const ranked = scoreBm25("user auth validation", documents, graphContextConfig);
assert.equal(ranked[0]?.id, "doc:auth", "BM25 should match camelCase doc tokens to spaced query terms");

const lexicalClaim = {
  id: "claim.lexical_match",
  kind: "fact",
  text: "The processRareIdentifier function handles this workflow.",
  truth: "unknown",
  intent: "unknown",
};
const lexicalDocument = {
  key: "claim:claim.lexical_match",
  type: "claim",
  id: lexicalClaim.id,
  text: lexicalClaim.text,
  object: lexicalClaim,
  about: [],
};
const lexicalScores = scoreBm25("process rare identifier", [lexicalDocument], graphContextConfig);
const baseRanked = rankContextDocuments(
  [lexicalDocument],
  [{ id: lexicalDocument.key, score: 0, raw_score: 0, rank: 1 }],
  lexicalScores,
  graphContextConfig,
);
const graphRanked = applyGraphRanking(
  { claims: baseRanked, components: [], flows: [] },
  { claims: [lexicalClaim], components: [], flows: [], sources: [], edges: [] },
  graphContextConfig,
);
assert.equal(baseRanked[0]?.signals.bm25_score, 1, "lexical match should have the strongest normalized BM25 score");
assert.equal(baseRanked[0]?.signals.semantic_score, 0, "regression fixture must not rely on semantic similarity");
assert.equal(
  graphRanked.claims[0]?.document.id,
  lexicalClaim.id,
  "post-graph filtering should preserve a strong BM25-only match",
);

console.log("BM25 tokenizer checks passed.");
