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

console.log("Freshness checks passed.");
