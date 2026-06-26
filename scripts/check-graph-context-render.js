import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { renderGraphContextMarkdown } = await import(new URL("dist/libs/knowledge-graph/graph-context/render.js", root));

const signals = {
  semantic_score: 1,
  semantic_raw_score: 1,
  semantic_rank: 1,
  bm25_score: 0,
  bm25_raw_score: 0,
  bm25_rank: null,
  weighted_score: 1,
  weighted_raw_score: 1,
  pre_coherence_score: 1,
  graph_score: 0,
  graph_raw_score: 0,
  graph_sources: [],
  coherence_score: 1,
  coherence_raw_score: 1,
  coherence_sources: [],
};

const component = {
  rank: 1,
  score: 1,
  context_relation: "primary",
  direct_score: 1,
  direct_raw_score: 1,
  claim_support_score: 1,
  claim_support_raw_score: 1,
  signals,
  object: {
    id: "component.renderer",
    name: "Graph context renderer",
    code_anchor: "libs/knowledge-graph/graph-context/render.ts",
  },
  matched_claim_ids: ["claim.render_trust"],
};

const flow = {
  rank: 1,
  score: 1,
  context_relation: "primary",
  direct_score: 1,
  direct_raw_score: 1,
  claim_support_score: 1,
  claim_support_raw_score: 1,
  signals,
  object: {
    id: "flow.graph_context",
    name: "Graph context rendering",
  },
  matched_claim_ids: ["claim.render_trust"],
};

const verifiedClaim = {
  type: "claim",
  rank: 1,
  score: 1,
  signals,
  object: {
    id: "claim.render_trust",
    kind: "fact",
    text: "Graph context output includes trust metadata for each retrieved claim.",
    truth: "code_verified",
    intent: "intended",
  },
  about: [
    { type: "component", id: "component.renderer" },
    { type: "flow", id: "flow.graph_context" },
  ],
  evidence: [
    {
      source: {
        id: "source.codex_session.abc",
        kind: "session",
        ref: "codex-session:abc",
        title: "Renderer design session",
      },
      reason: "captured the user-approved provenance display requirement",
    },
  ],
  code_anchors: [
    {
      status: "resolved",
      file: "libs/knowledge-graph/graph-context/render.ts",
      symbol: "renderGraphContextMarkdown",
      start_line: 1,
      end_line: 12,
    },
  ],
};

const unknownClaim = {
  type: "claim",
  rank: 2,
  score: 0.7,
  signals,
  object: {
    id: "claim.future_work",
    kind: "question",
    text: "Should graph context eventually support trust-aware reranking?",
    truth: "unknown",
    intent: "unknown",
  },
  about: [],
  evidence: [],
  code_anchors: [],
};

const markdown = renderGraphContextMarkdown({
  query: "trust output",
  search_config_version: "test",
  embedding_status: {
    checked_objects: 0,
    created: 0,
    reused: 0,
  },
  claims: [verifiedClaim, unknownClaim],
  components: [component],
  flows: [flow],
  ranked_results: [
    verifiedClaim,
    unknownClaim,
    { type: "component", ...component },
    { type: "flow", ...flow },
  ],
  sources: [verifiedClaim.evidence[0].source],
});

assert.match(markdown, /Trust: fact \| code_verified \| intended\./);
assert.match(markdown, /Trust: question \| unknown \| unknown\./);
assert.match(markdown, /Anchor: `libs\/knowledge-graph\/graph-context\/render.ts:1-12#renderGraphContextMarkdown`\./);
assert.match(markdown, /About: component Graph context renderer; flow Graph context rendering\./);
assert.match(
  markdown,
  /Evidence: session Renderer design session \(`codex-session:abc`\) - captured the user-approved provenance display requirement\./,
);

console.log("Graph context render checks passed.");
