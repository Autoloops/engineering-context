import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { collectGitHistory, generateGitHistoryProposal, githubRepository } = await import(
  new URL("dist/libs/git-memory/history.js", root)
);
const { runGitWatchCheck } = await import(new URL("dist/libs/git-memory/watch.js", root));
const { validateProposal } = await import(new URL("dist/libs/knowledge-graph/validate-proposal.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const repoRoot = mkdtempSync(join(tmpdir(), "greplica-git-memory-test-"));
git(["init", "-b", "main"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "Greplica Test"]);

mkdirSync(join(repoRoot, "src", "auth"), { recursive: true });
mkdirSync(join(repoRoot, "src", "api"), { recursive: true });
writeFileSync(join(repoRoot, "src", "auth", "token.ts"), "export const token = 1;\n");
writeFileSync(join(repoRoot, "src", "api", "client.ts"), "export const client = 1;\n");
commitAll("feat(auth): add token integration", "We decided to keep token handling in auth.");

writeFileSync(join(repoRoot, "src", "auth", "token.ts"), "export const token = 2;\n");
writeFileSync(join(repoRoot, "src", "api", "client.ts"), "export const client = 2;\n");
commitAll("refactor(api): align authentication client");

mkdirSync(join(repoRoot, "docs"));
writeFileSync(join(repoRoot, "docs", "notes.md"), "History notes.\n");
commitAll("docs: add history notes");

const commits = collectGitHistory(repoRoot, { maxCommits: 10 });
assert.equal(commits.length, 3);
assert.deepEqual(commits[0].files.map((file) => file.path), ["docs/notes.md"]);

const emptyGraph = { components: [], flows: [], claims: [], sources: [], edges: [] };
const plan = generateGitHistoryProposal(repoRoot, commits, emptyGraph);
assert.equal(plan.stats.commits_analyzed, 3);
assert.equal(plan.stats.components, 3);
assert.equal(plan.stats.flows, 1, "repeated auth/api co-changes should produce a flow");
assert.equal(plan.stats.sources, 3, "every analyzed commit should retain provenance");
assert.ok(plan.proposal.creates.claims.some((claim) => claim.kind === "insight"));
assert.ok(plan.proposal.creates.claims.some((claim) => claim.kind === "decision"));
assert.ok(plan.proposal.creates.sources.every((source) => source.kind === "git_history"));
assert.deepEqual(validateProposal(plan.proposal), { valid: true, errors: [] });
assert.equal(githubRepository("git@github.com:Autoloops/greplica.git"), "Autoloops/greplica");

const database = openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-git-memory-db-")), "graph.db"));
try {
  const repository = new SqliteRepository(database);
  const embeddingBuilder = {
    async ensureForGraph() {
      return { checked_objects: 0, created: 0, reused: 0 };
    },
  };
  const service = new KnowledgeGraphService(repository, undefined, embeddingBuilder);
  const repo = { repo_root: repoRoot, repo_name: "git-memory-test", default_branch: "main" };
  service.initRepo(repo);
  await service.applyProposal(repo, {
    title: "Seed anchored claim",
    creates: {
      components: [{ id: "component.auth", name: "Authentication" }],
      claims: [{
        id: "claim.token_value",
        kind: "fact",
        text: "The token constant is 2.",
        truth: "code_verified",
        intent: "intended",
        code_anchors: [{ file: "src/auth/token.ts" }],
      }],
      edges: [{
        id: "edge.claim_token_auth",
        from_id: "claim.token_value",
        from_type: "claim",
        to_id: "component.auth",
        to_type: "component",
        kind: "about",
      }],
    },
  });

  const first = await runGitWatchCheck(repoRoot, repo, service, repository, {
    anchorThresholdDays: 7,
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(first.full_audit, true);
  assert.equal(first.marked_claims, 0);

  writeFileSync(join(repoRoot, "src", "auth", "token.ts"), "export const token = 3;\n");
  commitAll("fix(auth): rotate token constant");
  const second = await runGitWatchCheck(repoRoot, repo, service, repository, {
    anchorThresholdDays: 7,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  assert.equal(second.full_audit, false);
  assert.deepEqual(second.changed_files, ["src/auth/token.ts"]);
  assert.equal(second.marked_claims, 1);

  const reviewEdge = service.readGraph(repo).edges.find((edge) => edge.kind === "needs_review");
  assert.equal(reviewEdge?.from_id, "claim.token_value");
  assert.equal(reviewEdge?.to_id, "claim.token_value");
  assert.equal(reviewEdge?.metadata?.reason, "file_content_changed");

  const staleReference = await service.validateProposal(repo, {
    title: "Reference stale claim",
    creates: { edges: [{
      id: "edge.stale_claim_auth",
      from_id: "claim.token_value",
      from_type: "claim",
      to_id: "component.auth",
      to_type: "component",
      kind: "about",
    }] },
  });
  assert.equal(staleReference.valid, false);
  assert.ok(staleReference.errors.some((error) => error.includes("needs review")));

  const unchanged = await runGitWatchCheck(repoRoot, repo, service, repository, {
    anchorThresholdDays: 7,
    now: new Date("2026-01-02T01:00:00Z"),
  });
  assert.equal(unchanged.skipped, true);
} finally {
  database.close();
}

console.log("check-git-memory: ok");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function commitAll(subject, body) {
  git(["add", "."]);
  const args = ["commit", "-m", subject];
  if (body) args.push("-m", body);
  git(args);
}
