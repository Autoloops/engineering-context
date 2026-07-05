import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t.io", "-c", "user.name=t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString().trim();
}

// ---------------------------------------------------------------------------
// changedFilesSince: git diff (committed) ∪ git status --porcelain (uncommitted)
// ---------------------------------------------------------------------------
const { changedFilesSince } = await import(new URL("dist/libs/knowledge-graph/changed-files.js", root));

const gitRepo = mkdtempSync(join(tmpdir(), "greplica-cf-"));
git(gitRepo, "init", "-q");
writeFileSync(join(gitRepo, "a.ts"), "export const a = 1;\n");
writeFileSync(join(gitRepo, "b.ts"), "export const b = 1;\n");
git(gitRepo, "add", "-A");
git(gitRepo, "commit", "-qm", "seed");
const headSha = git(gitRepo, "rev-parse", "HEAD");

// Uncommitted edit to a.ts is caught; b.ts (untouched) is not.
writeFileSync(join(gitRepo, "a.ts"), "export const a = 2;\n");
let changed = changedFilesSince(gitRepo, headSha);
assert.ok(changed.includes("a.ts"), "uncommitted edit is caught");
assert.ok(!changed.includes("b.ts"), "untouched file is not reported");

// Commit the edit -> still reported as changed since the old headSha (committed diff).
git(gitRepo, "add", "-A");
git(gitRepo, "commit", "-qm", "edit a");
changed = changedFilesSince(gitRepo, headSha);
assert.ok(changed.includes("a.ts"), "committed change since sinceSha is caught");

// From the new HEAD with a clean tree -> nothing changed.
const headSha2 = git(gitRepo, "rev-parse", "HEAD");
assert.deepEqual(changedFilesSince(gitRepo, headSha2), [], "clean tree at HEAD -> no changes");

// Git probe failure -> undefined (distinct from [] clean), so the caller full-sweeps.
assert.equal(changedFilesSince(mkdtempSync(join(tmpdir(), "greplica-nogit-")), headSha), undefined, "no git -> undefined");
assert.equal(changedFilesSince(undefined, undefined), undefined, "no repo root -> undefined");

// ---------------------------------------------------------------------------
// freshness checkpoint + fingerprint deletion (repository)
// ---------------------------------------------------------------------------
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const cpRepo = new SqliteRepository(openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-cp-")), "graph.db")));
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), undefined, "no checkpoint -> undefined");
cpRepo.setFreshnessCheckpoint("repo1", "sha-abc");
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), "sha-abc", "checkpoint round-trips");
cpRepo.setFreshnessCheckpoint("repo1", "sha-def");
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), "sha-def", "checkpoint updates in place");
assert.equal(cpRepo.getFreshnessCheckpoint("repo2"), undefined, "checkpoints are per-repo");

cpRepo.upsertAnchorFingerprints([
  { claim_id: "cx", file: "x.ts", symbol: "s", content_hash: "h", file_mtime_ms: 1, file_size: 2, resolver_status: "resolved" },
]);
assert.equal(cpRepo.fingerprintsForClaims(["cx"]).length, 1, "fingerprint written");
cpRepo.deleteAnchorFingerprints(["cx"]);
assert.equal(cpRepo.fingerprintsForClaims(["cx"]).length, 0, "fingerprints deleted for demoted claim");

// ---------------------------------------------------------------------------
// buildAnchorInvalidation generalizes to content drift (not just structural)
// ---------------------------------------------------------------------------
const { buildAnchorInvalidation } = await import(new URL("dist/libs/knowledge-graph/anchor-invalidation.js", root));

const demotedClaim = { id: "claim.c", kind: "fact", text: "t", truth: "code_verified", intent: "intended", code_anchors: [{ file: "a.ts", symbol: "f" }] };
const miniGraph = { components: [], flows: [], claims: [demotedClaim], sources: [], edges: [] };

// content drift: the anchor still resolves, but its span changed.
const contentPlan = buildAnchorInvalidation(
  [{ claim: demotedClaim, reason: "content", anchors: [{ file: "a.ts", symbol: "f", status: "resolved", start_line: 1, end_line: 1 }] }],
  miniGraph,
);
assert.equal(contentPlan.events[0].reason, "content_drift", "content demotion -> content_drift event");
assert.equal(contentPlan.events[0].resolver_status, "resolved", "content event records the resolving status");
assert.ok(contentPlan.proposal.creates.claims.some((c) => c.truth === "unknown"), "content demotion rebuilds a truth:unknown claim");

// structural drift: unchanged behavior (broken anchor + anchor_drift reason).
const structuralPlan = buildAnchorInvalidation(
  [{ claim: demotedClaim, reason: "structural", anchors: [{ file: "a.ts", symbol: "f", status: "missing_symbol" }] }],
  miniGraph,
);
assert.equal(structuralPlan.events[0].reason, "anchor_drift", "structural demotion -> anchor_drift event");
assert.equal(structuralPlan.events[0].resolver_status, "missing_symbol", "structural event records the drift status");

// ---------------------------------------------------------------------------
// service.healDriftedAnchors: change-scoped structural + content heal
// ---------------------------------------------------------------------------
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const stubBuilder = { ensureForGraph: async () => ({ checked_objects: 0, created: 0, reused: 0 }) };

const healRoot = mkdtempSync(join(tmpdir(), "greplica-heal-"));
git(healRoot, "init", "-q");
writeFileSync(join(healRoot, "a.ts"), "export function fa() { return 1; }\n");
writeFileSync(join(healRoot, "b.ts"), "export function fb() { return 1; }\n");
git(healRoot, "add", "-A");
git(healRoot, "commit", "-qm", "seed");

const healRepo = new SqliteRepository(openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-heal-home-")), "graph.db")));
const healSvc = new KnowledgeGraphService(healRepo, undefined, stubBuilder);
const healRef = { repo_root: healRoot, repo_name: "heal", default_branch: "main" };
healSvc.initRepo(healRef);
await healSvc.applyProposal(healRef, { title: "seed", creates: { claims: [
  { id: "claim.a", kind: "fact", text: "a", truth: "code_verified", intent: "intended", code_anchors: [{ file: "a.ts", symbol: "fa" }] },
  { id: "claim.b", kind: "fact", text: "b", truth: "code_verified", intent: "intended", code_anchors: [{ file: "b.ts", symbol: "fb" }] },
]}});
const head = git(healRoot, "rev-parse", "HEAD");

// Content-edit a.ts only (uncommitted). Heal must demote claim.a, not claim.b,
// and only recheck the changed file's claim (reverse index).
writeFileSync(join(healRoot, "a.ts"), "export function fa() { return 99999; }\n");
const healed = await healSvc.healDriftedAnchors(healRef, head);
assert.deepEqual(healed.demoted, ["claim.a"], "content-drifted claim demoted");
assert.equal(healed.rechecked, 1, "only the changed file's claim was rechecked (reverse index)");
assert.equal(typeof healed.headSha, "string", "heal returns the current HEAD sha");

const g = healSvc.readGraph(healRef);
assert.ok(g.claims.some((c) => c.id === "claim.b" && c.truth === "code_verified"), "unchanged claim untouched");
assert.ok(g.claims.some((c) => c.truth === "unknown"), "drifted claim rebuilt as unknown");
assert.ok(!g.claims.some((c) => c.id === "claim.a" && c.truth === "code_verified"), "original demoted");
assert.equal(healRepo.fingerprintsForClaims(["claim.a"]).length, 0, "demoted claim fingerprints removed");

// Second heal with no new edits -> idempotent no-op (early cutoff).
const again = await healSvc.healDriftedAnchors(healRef, head);
assert.deepEqual(again.demoted, [], "second heal demotes nothing (idempotent)");

// Unknown never demotes: make b.ts unreadable, run a full sweep (no sinceSha).
chmodSync(join(healRoot, "b.ts"), 0o000);
const sweep = await healSvc.healDriftedAnchors(healRef);
chmodSync(join(healRoot, "b.ts"), 0o644);
assert.ok(!sweep.demoted.includes("claim.b"), "unreadable (unknown) claim is not demoted");

// Bad checkpoint sha -> git probe fails -> full sweep (never a silent skip).
writeFileSync(join(healRoot, "b.ts"), "export function fb() { return 12345; }\n");
const badSha = await healSvc.healDriftedAnchors(healRef, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
assert.deepEqual(badSha.demoted, ["claim.b"], "bad checkpoint sha -> full sweep demotes the drifted claim");

// Checkpoint advanced to the current HEAD.
assert.equal(healRepo.getFreshnessCheckpoint(healSvc.requireRepo(healRef).repo_id), head, "checkpoint set to HEAD");

// ---------------------------------------------------------------------------
// config default + worker drift-heal pass (dedupe + gate)
// ---------------------------------------------------------------------------
const { defaultSessionConfig } = await import(new URL("dist/libs/config/greplica-config.js", root));
assert.equal(defaultSessionConfig.autoHealDrift, true, "autoHealDrift defaults on");

const { runDriftHealPass } = await import(new URL("dist/libs/hooks/worker.js", root));
const healCalls = [];
const fakeService = {
  healDriftedAnchorsFromCheckpoint: async (ref) => {
    healCalls.push(ref.repo_root);
    return { demoted: [], rechecked: 1 };
  },
};
const r = (path) => ({ repo_root: path, repo_name: path, default_branch: "main" });

// Gate off -> no heal.
await runDriftHealPass(fakeService, [r("/r1")], false, () => true, () => {});
assert.equal(healCalls.length, 0, "autoHealDrift off -> no heal");

// Gate on -> each distinct repo healed once (deduped).
await runDriftHealPass(fakeService, [r("/r1"), r("/r1"), r("/r2")], true, () => true, () => {});
assert.deepEqual(healCalls, ["/r1", "/r2"], "heals each distinct repo once");

console.log("Freshness background checks passed.");
