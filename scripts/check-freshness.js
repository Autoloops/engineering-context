import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { classifyFreshness } = await import(new URL("dist/libs/knowledge-graph/code-anchors/freshness.js", root));

const resolvesAnchor = { file: "a.ts", symbol: "f", status: "resolved" };
const brokenAnchor = { file: "a.ts", symbol: "f", status: "missing_symbol" };
// An AnchorCheck bundles one anchor with its current + last-known span hash.
const check = (anchor, currentHash, storedHash) => ({ anchor, currentHash, storedHash });

// No anchors -> fresh.
assert.equal(classifyFreshness([]).state, "fresh", "no anchors -> fresh");

// Every anchor broken -> structural drift.
const structural = classifyFreshness([check(brokenAnchor, undefined, "h1")]);
assert.equal(structural.state, "stale");
assert.equal(structural.reason, "structural");
assert.equal(structural.broken.length, 1, "structural verdict carries the broken anchor");

// Resolves and the span hash matches -> fresh.
assert.equal(classifyFreshness([check(resolvesAnchor, "h1", "h1")]).state, "fresh", "unchanged span -> fresh");

// Resolves but the span hash changed -> content drift.
const content = classifyFreshness([check(resolvesAnchor, "h2", "h1")]);
assert.equal(content.state, "stale");
assert.equal(content.reason, "content");

// No stored fingerprint yet -> cannot compare -> fresh (never a false stale).
assert.equal(classifyFreshness([check(resolvesAnchor, "h1", undefined)]).state, "fresh", "no baseline -> fresh");

// One anchor broken, another resolves with a changed hash -> content (not all broken).
const mixed = classifyFreshness([check(brokenAnchor, undefined, "h0"), check(resolvesAnchor, "h2", "h1")]);
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

// --- service: fingerprints are written when a proposal is applied ---
import { writeFileSync } from "node:fs";
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const stubBuilder = { ensureForGraph: async () => ({ checked_objects: 0, created: 0, reused: 0 }) };

const repoRoot = mkdtempSync(join(tmpdir(), "greplica-fp-repo-"));
writeFileSync(join(repoRoot, "auth.ts"), "export function validateToken(t) { return t.length > 0; }\n");
const svcRepo = new SqliteRepository(openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-fp-home-")), "graph.db")));
const svc = new KnowledgeGraphService(svcRepo, undefined, stubBuilder);
const ref = { repo_root: repoRoot, repo_name: "fp", default_branch: "main" };
svc.initRepo(ref);

await svc.applyProposal(ref, { title: "seed", creates: { claims: [
  { id: "claim.tv", kind: "fact", text: "t", truth: "code_verified", intent: "intended", code_anchors: [{ file: "auth.ts", symbol: "validateToken" }] },
]}});
const fps = svcRepo.fingerprintsForClaims(["claim.tv"]);
assert.equal(fps.length, 1, "fingerprint written on apply for code_verified claim");
assert.equal(fps[0].file, "auth.ts");
assert.equal(fps[0].resolver_status, "resolved");
assert.equal(fps[0].content_hash.length, 64, "sha256 span hash stored");

await svc.applyProposal(ref, { title: "seed2", creates: { claims: [
  { id: "claim.sv", kind: "decision", text: "d", truth: "source_verified", intent: "intended" },
]}});
assert.equal(svcRepo.fingerprintsForClaims(["claim.sv"]).length, 0, "source_verified claim -> no fingerprint");

console.log("Freshness checks passed.");
