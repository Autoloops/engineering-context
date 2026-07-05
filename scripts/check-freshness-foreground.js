import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { attachFreshness } = await import(new URL("dist/libs/knowledge-graph/graph-context/claim-freshness.js", root));
const { hashAnchorSpan, statAnchorFile } = await import(new URL("dist/libs/knowledge-graph/code-anchors/span-hash.js", root));

const repoRoot = mkdtempSync(join(tmpdir(), "greplica-fg-ctx-"));
writeFileSync(join(repoRoot, "svc.ts"), "line1\nexport function handle() { return 1; }\nline3\n");
const anchor = { file: "svc.ts", symbol: "handle", status: "resolved", start_line: 2, end_line: 2 };

const db = openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-fg-db-")), "graph.db"));
const repo = new SqliteRepository(db);

// Minimal ClaimContextResult (sans the freshness attachFreshness computes).
const claimResult = (id, anchors) => ({
  rank: 1, score: 1, signals: {}, about: [], evidence: [], code_anchors: anchors,
  object: { id, kind: "fact", text: "t", truth: "code_verified", intent: "intended" },
});

// No fingerprint stored yet, span readable -> fresh (no false stale/unknown).
let out = attachFreshness([claimResult("c1", [anchor])], repo, repoRoot);
assert.equal(out[0].freshness.state, "fresh", "no baseline, readable -> fresh");

// Seed a fingerprint matching the current file -> fresh.
const stat = statAnchorFile(repoRoot, "svc.ts");
repo.upsertAnchorFingerprints([
  { claim_id: "c1", file: "svc.ts", symbol: "handle", content_hash: hashAnchorSpan(repoRoot, anchor), file_mtime_ms: stat.mtime_ms, file_size: stat.size, resolver_status: "resolved" },
]);
out = attachFreshness([claimResult("c1", [anchor])], repo, repoRoot);
assert.equal(out[0].freshness.state, "fresh", "baseline matches current -> fresh");

// Change the body -> content drift (foreground detects it live).
writeFileSync(join(repoRoot, "svc.ts"), "line1\nexport function handle() { return 99999; }\nline3\n");
out = attachFreshness([claimResult("c1", [anchor])], repo, repoRoot);
assert.equal(out[0].freshness.state, "stale", "changed body -> stale");
assert.equal(out[0].freshness.reason, "content", "changed body -> content drift");

// Unreadable anchor -> unknown.
out = attachFreshness([claimResult("c2", [{ file: "gone.ts", symbol: "x", status: "resolved", start_line: 1, end_line: 1 }])], repo, repoRoot);
assert.equal(out[0].freshness.state, "unknown", "unreadable anchor -> unknown");

// All anchors broken -> structural.
out = attachFreshness([claimResult("c3", [{ file: "svc.ts", symbol: "handle", status: "missing_symbol" }])], repo, repoRoot);
assert.equal(out[0].freshness.state, "stale", "all broken -> stale");
assert.equal(out[0].freshness.reason, "structural", "all broken -> structural");

// Read-only: attachFreshness returns new objects, never mutates its input.
const input = claimResult("c1", [anchor]);
attachFreshness([input], repo, repoRoot);
assert.equal(input.freshness, undefined, "attachFreshness does not mutate its input");

// --- render: truth + `## Needs re-verification` section ---
const { renderGraphContextMarkdown } = await import(new URL("dist/libs/knowledge-graph/graph-context/render.js", root));

const claimItem = (id, truth, freshness, anchors = []) => ({
  type: "claim", rank: 1, score: 1, signals: {}, about: [], evidence: [], code_anchors: anchors,
  object: { id, kind: "fact", text: `text of ${id}`, truth, intent: "intended" }, freshness,
});
const freshV = { state: "fresh", reason: null, broken: [] };
const staleV = { state: "stale", reason: "content", broken: [] };
const unknownV = { state: "unknown", reason: null, broken: [] };
const packet = (items) => ({
  query: "q", search_config_version: "v", embedding_status: { checked_objects: 0, created: 0, reused: 0 },
  claims: [], components: [], flows: [], sources: [], ranked_results: items,
});

const md = renderGraphContextMarkdown(packet([
  claimItem("claim.fresh", "code_verified", freshV),
  claimItem("claim.stale", "code_verified", staleV),
  claimItem("claim.unknown", "code_verified", unknownV),
]));

const bestIdx = md.indexOf("## Best Claims");
const reverifyIdx = md.indexOf("## Needs re-verification");
assert.ok(reverifyIdx !== -1, "stale claims get a Needs re-verification section");
assert.ok(md.indexOf("claim.stale") > reverifyIdx, "stale claim rendered under Needs re-verification");
assert.ok(md.indexOf("claim.fresh") > bestIdx && md.indexOf("claim.fresh") < reverifyIdx, "fresh claim under Best Claims");
assert.ok(md.indexOf("claim.unknown") > bestIdx && md.indexOf("claim.unknown") < reverifyIdx, "unknown claim stays under Best Claims");
assert.ok(md.includes("code_verified"), "truth surfaced on claim lines");
assert.ok(/unverifiable/i.test(md), "unknown claim carries an unverifiable caveat");
assert.ok(/re-verify/i.test(md), "stale claim carries a re-verify instruction");

// No stale claims -> the section is omitted (no noise on healthy packets).
const mdClean = renderGraphContextMarkdown(packet([claimItem("claim.ok", "code_verified", freshV)]));
assert.ok(!mdClean.includes("## Needs re-verification"), "no stale section when nothing drifted");

console.log("Freshness foreground checks passed.");
