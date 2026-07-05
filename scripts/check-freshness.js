import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { classifyFreshness } = await import(new URL("dist/libs/knowledge-graph/code-anchors/freshness.js", root));

const resolves = { file: "a.ts", symbol: "f", status: "resolved" };
const broken = { file: "a.ts", symbol: "f", status: "missing_symbol" };

// No anchors -> fresh.
assert.equal(classifyFreshness([], [], []).state, "fresh", "no anchors -> fresh");

// Every anchor broken -> structural drift.
const structural = classifyFreshness([broken], [undefined], ["h1"]);
assert.equal(structural.state, "stale");
assert.equal(structural.reason, "structural");
assert.equal(structural.broken.length, 1, "structural verdict carries the broken anchor");

// Resolves and the span hash matches -> fresh.
assert.equal(classifyFreshness([resolves], ["h1"], ["h1"]).state, "fresh", "unchanged span -> fresh");

// Resolves but the span hash changed -> content drift.
const content = classifyFreshness([resolves], ["h2"], ["h1"]);
assert.equal(content.state, "stale");
assert.equal(content.reason, "content");

// No stored fingerprint yet -> cannot compare -> fresh (never a false stale).
assert.equal(classifyFreshness([resolves], ["h1"], [undefined]).state, "fresh", "no baseline -> fresh");

// One anchor broken, another resolves with a changed hash -> content (not all broken).
const mixed = classifyFreshness([broken, resolves], [undefined, "h2"], ["h0", "h1"]);
assert.equal(mixed.reason, "content", "partial break + changed hash -> content");

// --- storage layer: anchor_fingerprints table + repository ---
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const db = openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-fp-")), "graph.db"));
const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anchor_fingerprints'").get();
assert.equal(table?.name, "anchor_fingerprints", "table exists");
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='anchor_fingerprints_file_idx'").get();
assert.equal(idx?.name, "anchor_fingerprints_file_idx", "file index exists");

const repo = new SqliteRepository(db);
assert.deepEqual(repo.claimIdsForFiles([]), [], "empty input -> empty");
assert.deepEqual(repo.fingerprintsForClaims([]), [], "empty input -> empty");

repo.upsertAnchorFingerprints([
  { claim_id: "c1", file: "a.ts", symbol: "f", content_hash: "h1", file_mtime_ms: 10, file_size: 20, resolver_status: "resolved" },
  { claim_id: "c2", file: "b.ts", symbol: "g", content_hash: "h9", file_mtime_ms: 5, file_size: 6, resolver_status: "resolved" },
]);
assert.deepEqual(repo.claimIdsForFiles(["a.ts"]), ["c1"], "reverse index maps file -> claim");
assert.equal(repo.fingerprintsForClaims(["c1"])[0].content_hash, "h1", "read fingerprint back");
assert.equal(repo.fingerprintsForClaims(["c1"])[0].checked_at !== undefined, true, "checked_at stamped");

repo.upsertAnchorFingerprints([
  { claim_id: "c1", file: "a.ts", symbol: "f", content_hash: "h2", file_mtime_ms: 11, file_size: 21, resolver_status: "resolved" },
]);
assert.equal(repo.fingerprintsForClaims(["c1"])[0].content_hash, "h2", "upsert replaces existing row");
assert.equal(repo.fingerprintsForClaims(["c1"]).length, 1, "no duplicate row on upsert");

console.log("Freshness checks passed.");
