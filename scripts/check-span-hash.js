import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { hashAnchorSpan, statAnchorFile } = await import(new URL("dist/libs/knowledge-graph/code-anchors/span-hash.js", root));

const repo = mkdtempSync(join(tmpdir(), "greplica-span-hash-"));
writeFileSync(join(repo, "auth.ts"), "line 1\nexport function validateToken(t) { return t.length > 0; }\nline 3\n");

const anchor = { file: "auth.ts", symbol: "validateToken", status: "resolved", start_line: 2, end_line: 2 };

// Deterministic: same content -> same hash.
const first = hashAnchorSpan(repo, anchor);
assert.equal(typeof first, "string");
assert.equal(first.length, 64, "sha256 hex");
assert.equal(hashAnchorSpan(repo, anchor), first, "same span content -> same hash");

// A change to the span body changes the hash, even at the same line.
writeFileSync(join(repo, "auth.ts"), "line 1\nexport function validateToken(t) { return t.length > 99; }\nline 3\n");
assert.notEqual(hashAnchorSpan(repo, anchor), first, "changed span body -> different hash");

// A change outside the span does NOT change the hash (span-level granularity).
writeFileSync(join(repo, "auth.ts"), "CHANGED\nexport function validateToken(t) { return t.length > 0; }\nline 3\n");
assert.equal(hashAnchorSpan(repo, anchor), first, "change outside span -> same hash");

// File-only anchor (no line range) hashes the whole file.
const fileOnly = { file: "auth.ts", status: "file_only" };
assert.equal(typeof hashAnchorSpan(repo, fileOnly), "string", "file-only anchor hashes whole file");

// Missing / unreadable file -> undefined (graceful degradation, never throws).
assert.equal(hashAnchorSpan(repo, { file: "gone.ts", status: "missing_file" }), undefined, "missing file -> undefined");
assert.equal(hashAnchorSpan(repo, { file: "../escape.ts", status: "resolved" }), undefined, "path escape -> undefined");
assert.equal(hashAnchorSpan(undefined, anchor), undefined, "no repo root -> undefined");

// statAnchorFile returns real metadata, zeros when unavailable.
const stat = statAnchorFile(repo, "auth.ts");
assert.ok(stat.mtime_ms > 0 && stat.size > 0, "stat returns real metadata");
assert.deepEqual(statAnchorFile(repo, "gone.ts"), { mtime_ms: 0, size: 0 }, "missing file -> zero stat");

console.log("Span hash checks passed.");
