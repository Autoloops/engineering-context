import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

// Stub the embedding step so the suite never downloads a model; invalidation
// correctness does not depend on embeddings.
const stubContextBuilder = { ensureForGraph: async () => ({ checked_objects: 0, created: 0, reused: 0 }) };

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "greplica-drift-home-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "greplica-drift-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repoRoot, env: gitEnv() });

  const repository = new SqliteRepository(openDatabase(join(home, "graph.db")));
  const service = new KnowledgeGraphService(repository, undefined, stubContextBuilder);
  const ref = { repo_root: repoRoot, repo_name: "drift-test", default_branch: "main" };
  service.initRepo(ref);
  return { repoRoot, repository, service, ref };
}

function write(repoRoot, name, contents) {
  writeFileSync(join(repoRoot, name), contents);
}

// 1. Happy path: rename a symbol -> the claim is demoted, superseded, logged,
//    and kept in history; edges (with reasons) are re-pointed at the rebuild.
async function happyPath() {
  const { repoRoot, repository, service, ref } = setup();
  write(repoRoot, "auth.ts", "export function validateToken(t){return t.length>0;}\n");
  await service.applyProposal(ref, {
    title: "seed",
    creates: {
      components: [{ id: "comp.auth", name: "auth" }],
      sources: [{ id: "src.s1", kind: "session", ref: "codex:1", title: "s1" }],
      claims: [
        {
          id: "claim.tv",
          kind: "fact",
          text: "validated in validateToken",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "auth.ts", symbol: "validateToken" }],
          about: ["comp.auth"],
        },
      ],
      edges: [{ kind: "evidenced_by", from: "claim.tv", to: "src.s1", metadata: { reason: "stated in s1" } }],
    },
  });

  write(repoRoot, "auth.ts", "export function verifyToken(t){return t.length>0;}\n");
  const result = await service.invalidateDriftedAnchors(ref);

  assert.equal(result.invalidated.length, 1);
  assert.deepEqual(result.invalidated[0], {
    claim_id: "claim.tv",
    superseding_claim_id: "claim.tv__drift",
    broken_anchor: "auth.ts#validateToken",
    resolver_status: "missing_symbol",
  });
  assert.equal(typeof result.memory_commit_id, "string");
  assert.deepEqual(result.errors, []);

  const graph = service.readGraph(ref);
  assert.equal(graph.claims.find((c) => c.id === "claim.tv"), undefined, "original is superseded");
  const rebuilt = graph.claims.find((c) => c.id === "claim.tv__drift");
  assert.ok(rebuilt, "rebuilt claim exists");
  assert.equal(rebuilt.truth, "unknown");
  assert.deepEqual(rebuilt.code_anchors, [{ file: "auth.ts", symbol: "validateToken" }], "broken anchor kept as evidence");

  // The `supersedes` edge itself is intentionally hidden by readGraphView (it
  // points at the now-inactive original); its effect — the original dropping out
  // of the active view, asserted above — is the observable proof it was written.
  const rebuiltEdges = graph.edges.filter((e) => e.from_id === "claim.tv__drift");
  assert.ok(rebuiltEdges.some((e) => e.kind === "about" && e.to_id === "comp.auth"), "about edge cloned");
  const evidence = rebuiltEdges.find((e) => e.kind === "evidenced_by");
  assert.equal(evidence?.metadata?.reason, "stated in s1", "evidenced_by reason preserved");

  const repoId = service.requireRepo(ref).repo_id;
  const events = repository.listInvalidationEvents(repoId);
  assert.equal(events.length, 1);
  assert.equal(events[0].original_claim_id, "claim.tv");
  assert.equal(events[0].resolver_status, "missing_symbol");
  assert.equal(repository.subjectExists("claim", "claim.tv"), true, "original retained in history");

  const again = await service.invalidateDriftedAnchors(ref);
  assert.equal(again.invalidated.length, 0, "second run is idempotent");
  assert.equal(again.memory_commit_id, undefined);
}

// 2. Option A: a multi-anchor claim survives while any anchor resolves, and is
//    demoted only once every anchor is broken.
async function optionA() {
  const { repoRoot, service, ref } = setup();
  write(repoRoot, "auth.ts", "export function issueToken(){return 'x';}\nexport function validateToken(t){return t.length>0;}\n");
  await service.applyProposal(ref, {
    title: "seed",
    creates: {
      claims: [
        {
          id: "claim.multi",
          kind: "fact",
          text: "issue and validate",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [
            { file: "auth.ts", symbol: "issueToken" },
            { file: "auth.ts", symbol: "validateToken" },
          ],
        },
      ],
    },
  });

  write(repoRoot, "auth.ts", "export function issueToken(){return 'x';}\nexport function verifyToken(t){return t.length>0;}\n");
  const partial = await service.invalidateDriftedAnchors(ref);
  assert.equal(partial.invalidated.length, 0, "not demoted while one anchor resolves");

  write(repoRoot, "auth.ts", "export const nothing = 1;\n");
  const full = await service.invalidateDriftedAnchors(ref);
  assert.equal(full.invalidated.length, 1, "demoted once all anchors are broken");
  assert.equal(full.invalidated[0].claim_id, "claim.multi");
}

// 3. Unchanged and unsupported-language anchors are never demoted.
async function neverDemoted() {
  const { repoRoot, repository, service, ref } = setup();
  write(repoRoot, "keep.ts", "export function stable(){return 1;}\n");
  write(repoRoot, "data.xyz", "blob foo blob\n");

  await service.applyProposal(ref, {
    title: "seed",
    creates: {
      claims: [
        { id: "claim.stable", kind: "fact", text: "stable", truth: "code_verified", intent: "intended", code_anchors: [{ file: "keep.ts", symbol: "stable" }] },
      ],
    },
  });

  // An unsupported-language anchor cannot pass proposal validation, so seed it
  // straight through the repository to exercise the invalidation policy.
  const repoId = service.requireRepo(ref).repo_id;
  const working = repository.requireWorkingScope(repoId);
  const commit = repository.createMemoryCommit({ scope_id: working.id, title: "direct" });
  repository.createProposalRecords(working.id, commit.id, {
    title: "direct",
    creates: {
      claims: [
        { id: "claim.unsup", kind: "fact", text: "unsupported", truth: "code_verified", intent: "intended", code_anchors: [{ file: "data.xyz", symbol: "foo" }] },
      ],
    },
  });

  const result = await service.invalidateDriftedAnchors(ref);
  assert.equal(result.invalidated.length, 0, "unchanged and unsupported-language claims are left alone");
}

await happyPath();
await optionA();
await neverDemoted();

console.log("Anchor drift checks passed.");
