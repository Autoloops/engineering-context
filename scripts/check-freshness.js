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
assert.equal(mixed.broken.length, 1, "content verdict still surfaces the structurally-broken anchor");
assert.equal(mixed.broken[0].status, "missing_symbol", "the broken anchor is carried through");

// Resolving anchor whose span can't be hashed now (unreadable file / resolver error) -> unknown.
const unknown = classifyFreshness([check(resolvesAnchor, undefined, "h1")]);
assert.equal(unknown.state, "unknown", "unreadable span -> unknown");
assert.equal(unknown.reason, null, "unknown carries no drift reason");
assert.equal(unknown.broken.length, 0, "unknown carries no broken anchors");

// Undeterminable with no baseline either -> still unknown (we couldn't read the code).
assert.equal(classifyFreshness([check(resolvesAnchor, undefined, undefined)]).state, "unknown", "no current hash -> unknown");

// Real drift always beats unknown: a changed hash on any anchor still wins as content.
assert.equal(
  classifyFreshness([check(resolvesAnchor, undefined, "h1"), check(resolvesAnchor, "h2", "h1")]).state,
  "stale",
  "content drift beats unknown",
);

// One anchor structurally broken, another undeterminable -> unknown, but the broken
// anchor is still surfaced (Phase 3's healer needs to know which anchors broke).
const brokenPlusUnknown = classifyFreshness([check(brokenAnchor, undefined, "h1"), check(resolvesAnchor, undefined, "h1")]);
assert.equal(brokenPlusUnknown.state, "unknown", "partial break + undeterminable -> unknown");
assert.equal(brokenPlusUnknown.broken.length, 1, "unknown verdict still surfaces the structurally-broken anchor");
assert.equal(brokenPlusUnknown.broken[0].status, "missing_symbol", "the broken anchor is carried through");

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
assert.deepEqual(repo.claimIdsForFiles("r1", []), [], "empty input -> empty");
assert.deepEqual(repo.fingerprintsForClaims([]), [], "empty input -> empty");

repo.upsertAnchorFingerprints([
  { repo_id: "r1", claim_id: "c1", file: "a.ts", symbol: "f", content_hash: "h1", file_mtime_ms: 10, file_size: 20, resolver_status: "resolved" },
  { repo_id: "r1", claim_id: "c2", file: "b.ts", symbol: "g", content_hash: "h9", file_mtime_ms: 5, file_size: 6, resolver_status: "resolved" },
  { repo_id: "r2", claim_id: "cother", file: "a.ts", symbol: "f", content_hash: "hx", file_mtime_ms: 1, file_size: 1, resolver_status: "resolved" },
]);
assert.deepEqual(repo.claimIdsForFiles("r1", ["a.ts"]), ["c1"], "reverse index is repo-scoped (excludes other repos' same-path claims)");
assert.equal(repo.fingerprintsForClaims(["c1"])[0].content_hash, "h1", "read fingerprint back");
assert.equal(repo.fingerprintsForClaims(["c1"])[0].checked_at !== undefined, true, "checked_at stamped");

repo.upsertAnchorFingerprints([
  { repo_id: "r1", claim_id: "c1", file: "a.ts", symbol: "f", content_hash: "h2", file_mtime_ms: 11, file_size: 21, resolver_status: "resolved" },
]);
assert.equal(repo.fingerprintsForClaims(["c1"])[0].content_hash, "h2", "upsert replaces existing row");
assert.equal(repo.fingerprintsForClaims(["c1"]).length, 1, "no duplicate row on upsert");

// File-only anchors use the "" symbol sentinel and must upsert idempotently
// (a nullable PK column would let SQLite treat each NULL as a distinct row).
repo.upsertAnchorFingerprints([
  { repo_id: "r1", claim_id: "c3", file: "d.ts", symbol: "", content_hash: "h1", file_mtime_ms: 1, file_size: 2, resolver_status: "resolved" },
]);
repo.upsertAnchorFingerprints([
  { repo_id: "r1", claim_id: "c3", file: "d.ts", symbol: "", content_hash: "h2", file_mtime_ms: 3, file_size: 4, resolver_status: "resolved" },
]);
assert.equal(repo.fingerprintsForClaims(["c3"]).length, 1, "file-only anchor upserts, no duplicate");
assert.equal(repo.fingerprintsForClaims(["c3"])[0].content_hash, "h2", "file-only anchor row replaced");

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

// --- foreground: fingerprint index + stat-prefiltered freshness checks ---
const { indexFingerprintsByClaim, freshnessChecks } = await import(new URL("dist/libs/knowledge-graph/anchor-fingerprints.js", root));
const { hashAnchorSpan, statAnchorFile } = await import(new URL("dist/libs/knowledge-graph/code-anchors/span-hash.js", root));

const fgRoot = mkdtempSync(join(tmpdir(), "greplica-fg-"));
writeFileSync(join(fgRoot, "svc.ts"), "line1\nexport function handle() { return 1; }\nline3\n");
const fgAnchor = { file: "svc.ts", symbol: "handle", status: "resolved", start_line: 2, end_line: 2 };

// Readable span, no stored fingerprint yet -> fresh (no false stale, no false unknown).
assert.equal(classifyFreshness(freshnessChecks([fgAnchor], undefined, fgRoot)).state, "fresh", "readable span, no baseline -> fresh");

// Build a stored row that matches the current file (hash + real stat).
const fgStat = statAnchorFile(fgRoot, "svc.ts");
const fgHash = hashAnchorSpan(fgRoot, fgAnchor);
const fgRows = [
  { repo_id: "r1", claim_id: "cf", file: "svc.ts", symbol: "handle", content_hash: fgHash, file_mtime_ms: fgStat.mtime_ms, file_size: fgStat.size, resolver_status: "resolved", checked_at: "t" },
];
const fgIndex = indexFingerprintsByClaim(fgRows);
assert.equal(fgIndex.get("cf").size, 1, "fingerprints grouped by claim id");

// Stat prefilter hit: file untouched -> reuse stored hash (no re-hash) -> fresh.
const hit = freshnessChecks([fgAnchor], fgIndex.get("cf"), fgRoot);
assert.equal(hit[0].currentHash, fgHash, "prefilter hit reuses the stored hash");
assert.equal(classifyFreshness(hit).state, "fresh", "unchanged file -> fresh");

// Body changed (size differs -> prefilter miss) -> re-hash -> content drift.
writeFileSync(join(fgRoot, "svc.ts"), "line1\nexport function handle() { return 99999; }\nline3\n");
const miss = freshnessChecks([fgAnchor], fgIndex.get("cf"), fgRoot);
assert.notEqual(miss[0].currentHash, fgHash, "prefilter miss re-hashes the span");
assert.equal(classifyFreshness(miss).reason, "content", "changed body -> content drift");

// Unreadable anchor -> current hash undefined -> unknown.
const goneChecks = freshnessChecks([{ file: "gone.ts", symbol: "x", status: "resolved", start_line: 1, end_line: 1 }], undefined, fgRoot);
assert.equal(classifyFreshness(goneChecks).state, "unknown", "unreadable anchor -> unknown");

console.log("Freshness checks passed.");
