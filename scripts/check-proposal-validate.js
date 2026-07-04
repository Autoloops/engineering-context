import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));
const { validateProposal } = await import(new URL("dist/libs/knowledge-graph/validate-proposal.js", root));

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

console.log("check-proposal-validate: ok");
