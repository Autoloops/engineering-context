import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { CodeAnchorResolver } = await import(new URL("dist/libs/knowledge-graph/code-anchors/resolver.js", root));
const { fingerprintClaimAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/fingerprint.js", root));
const { classifyStale } = await import(new URL("dist/libs/knowledge-graph/code-anchors/freshness.js", root));
const { attachStaleClaims } = await import(new URL("dist/libs/knowledge-graph/graph-context/claim-freshness.js", root));
const { renderGraphContextMarkdown } = await import(new URL("dist/libs/knowledge-graph/graph-context/render.js", root));

const repo = mkdtempSync(join(tmpdir(), "greplica-freshness-foreground-test-"));
const file = join(repo, "mod.py");
const anchor = { file: "mod.py", symbol: "foo" };
const codeVerifiedClaim = {
  id: "claim.foo",
  kind: "fact",
  text: "foo returns 3",
  truth: "code_verified",
  intent: "intended",
  code_anchors: [anchor],
};
const sourceVerifiedClaim = { ...codeVerifiedClaim, id: "claim.source", truth: "source_verified" };
const resolver = new CodeAnchorResolver();

writeFileSync(file, "def foo():\n    return 3\n");
const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], resolver)]]);

assert.equal(classifyStale([
  { anchor: { ...anchor, status: "missing_symbol" }, storedHash: "a", currentHash: undefined },
]), "structural");
assert.equal(classifyStale([
  { anchor: { ...anchor, status: "resolved" }, storedHash: "a", currentHash: "b" },
]), "content");
assert.equal(classifyStale([
  { anchor: { ...anchor, status: "resolved" }, storedHash: "a", currentHash: "a" },
]), undefined);

writeFileSync(file, "def foo():\n    return 3\n");
const freshResolver = new CodeAnchorResolver();
const fresh = await attachStaleClaims([await claimResult(codeVerifiedClaim, freshResolver)], fakeRepository(baseline), "repo", repo, freshResolver);
assert.equal(fresh[0].freshness, undefined);
assert.doesNotMatch(renderResult(fresh), /Needs re-verification/);

writeFileSync(file, "def foo():\n    return 8\n");
const contentResolver = new CodeAnchorResolver();
const contentDrift = await attachStaleClaims([await claimResult(codeVerifiedClaim, contentResolver)], fakeRepository(baseline), "repo", repo, contentResolver);
assert.deepEqual(contentDrift[0].freshness, { reason: "content" });
assert.match(renderResult(contentDrift, ["claim.foo"]), /## Needs re-verification/);
assert.match(renderResult(contentDrift, ["claim.foo"]), /\[STALE: content drift - re-verify against current code\]/);
assert.match(renderResult(contentDrift, ["claim.foo"]), /`claim.foo` \(stale\)/);
assert.doesNotMatch(renderResult(contentDrift), /## Best Claims\n\n- None\./);

writeFileSync(file, "def bar():\n    return 3\n");
const structuralResolver = new CodeAnchorResolver();
const structuralDrift = await attachStaleClaims([await claimResult(codeVerifiedClaim, structuralResolver)], fakeRepository(baseline), "repo", repo, structuralResolver);
assert.deepEqual(structuralDrift[0].freshness, { reason: "structural" });
assert.match(renderResult(structuralDrift), /\[STALE: structural drift - re-verify against current code\]/);

writeFileSync(file, "def foo():\n    return 8\n");
const noBaselineResolver = new CodeAnchorResolver();
const noBaseline = await attachStaleClaims([await claimResult(codeVerifiedClaim, noBaselineResolver)], fakeRepository(new Map()), "repo", repo, noBaselineResolver);
assert.equal(noBaseline[0].freshness, undefined);

const sourceResolver = new CodeAnchorResolver();
const sourceVerified = await attachStaleClaims([await claimResult(sourceVerifiedClaim, sourceResolver)], fakeRepository(baseline), "repo", repo, sourceResolver);
assert.equal(sourceVerified[0].freshness, undefined);

console.log("check-freshness-foreground: ok");

async function claimResult(claim, claimResolver) {
  return {
    rank: 1,
    score: 1,
    signals: signals(),
    object: claim,
    about: [{ type: "component", id: "component.mod" }],
    evidence: [],
    code_anchors: await claimResolver.resolveMany(repo, claim.code_anchors),
  };
}

function fakeRepository(fingerprints) {
  return {
    readClaimAnchorFingerprints(_repoId, ids) {
      return new Map(ids.flatMap((id) => {
        const value = fingerprints.get(id);
        return value === undefined ? [] : [[id, value]];
      }));
    },
  };
}

function renderResult(claims, matchedClaimIds = []) {
  return renderGraphContextMarkdown({
    query: "foo",
    search_config_version: "test",
    embedding_status: { checked_objects: 0, created: 0, reused: 0 },
    claims,
    components: [{
      rank: 1,
      score: 1,
      context_relation: "additional",
      direct_score: 0,
      direct_raw_score: 0,
      claim_support_score: 1,
      claim_support_raw_score: 1,
      signals: signals(),
      object: { id: "component.mod", name: "Module", code_anchor: "mod.py" },
      matched_claim_ids: matchedClaimIds,
    }],
    flows: [],
    ranked_results: [
      ...claims.map((claim) => ({ ...claim, type: "claim" })),
      {
        rank: 2,
        score: 1,
        context_relation: "additional",
        direct_score: 0,
        direct_raw_score: 0,
        claim_support_score: 1,
        claim_support_raw_score: 1,
        signals: signals(),
        object: { id: "component.mod", name: "Module", code_anchor: "mod.py" },
        matched_claim_ids: matchedClaimIds,
        type: "component",
      },
    ],
    sources: [],
  });
}

function signals() {
  return {
    semantic_score: 1,
    semantic_raw_score: 1,
    semantic_rank: 1,
    bm25_score: 1,
    bm25_raw_score: 1,
    bm25_rank: 1,
    weighted_score: 1,
    weighted_raw_score: 1,
    pre_coherence_score: 1,
    graph_score: 1,
    graph_raw_score: 1,
    graph_sources: [],
    coherence_score: 1,
    coherence_raw_score: 1,
    coherence_sources: [],
  };
}
