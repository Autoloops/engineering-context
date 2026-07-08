import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { CodeAnchorResolver } = await import(new URL("dist/libs/knowledge-graph/code-anchors/resolver.js", root));
const { fingerprintClaimAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/fingerprint.js", root));
const { auditClaimCodeAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/audit.js", root));

const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
const file = join(repo, "mod.py");
const anchor = { file: "mod.py", symbol: "foo" };
const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

// Baseline fingerprint captured when the fact was "written".
writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

async function driftedIds(variant) {
  writeFileSync(file, variant);
  const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
  return result.drifted.map((issue) => issue.claim_id);
}

// Unchanged code does not drift.
assert.deepEqual(await driftedIds("def foo():\n    # returns the threshold\n    return 3\n"), []);

// A real value change (3 -> 8) drifts.
assert.deepEqual(await driftedIds("def foo():\n    # returns the threshold\n    return 8\n"), ["claim.foo"]);

// Comment-only edits do not drift.
assert.deepEqual(await driftedIds("def foo():\n    # returns the configured threshold value\n    return 3\n"), []);

// Whitespace-only edits do not drift.
assert.deepEqual(await driftedIds("def foo():\n\n    # returns the threshold\n    return 3\n\n"), []);

// A claim with no stored baseline is treated as unknown, never drifted.
const noBaseline = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver());
assert.deepEqual(noBaseline.drifted, []);

console.log("check-anchor-drift: ok");
