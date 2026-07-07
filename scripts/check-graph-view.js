import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { renderGraphContextMarkdown } = await import(new URL("dist/libs/knowledge-graph/graph-context/render.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-view-test-"));
const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository, undefined, {
    ensureForGraph: async () => ({ checked_objects: 0, created: 0, reused: 0 }),
  });
  const repo = {
    repo_root: join(tmp, "repo"),
    repo_name: "graph-view-null-anchor",
    default_branch: "main",
  };
  mkdirSync(join(repo.repo_root, "src"), { recursive: true });
  writeFileSync(
    join(repo.repo_root, "src/foo.ts"),
    "export function computeTotal(amount: number): number {\n  return amount * 0.95;\n}\n",
    "utf8",
  );

  const initialized = service.initRepo(repo);
  const memoryCommit = repository.createMemoryCommit({
    scope_id: initialized.working_scope_id,
    title: "Seed null component anchor",
  });

  repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
    title: "Seed null component anchor",
    creates: {
      components: [
        {
          id: "component.no_anchor",
          name: "Component Without Anchor",
        },
      ],
    },
  });

  await service.applyProposal(repo, {
    title: "Seed anchored claim",
    creates: {
      claims: [
        {
          id: "claim.compute_total_discount",
          kind: "fact",
          text: "computeTotal applies a flat 5% discount.",
          truth: "code_verified",
          intent: "intended",
          code_anchors: [{ file: "src/foo.ts", symbol: "computeTotal" }],
        },
      ],
    },
  });

  const storedClaim = service.readGraph(repo).claims.find((claim) => claim.id === "claim.compute_total_discount");
  const storedHash = storedClaim?.code_anchors?.[0]?.content_hash;
  assert.equal(typeof storedHash, "string", "applyProposal must persist an anchor content hash");
  assert.match(storedHash, /^sha256:/);

  const beforeAudit = await service.auditCodeAnchors(repo);
  assert.equal(beforeAudit.stale_content.length, 0, "unchanged anchored code must not audit as stale");

  writeFileSync(
    join(repo.repo_root, "src/foo.ts"),
    "export function computeTotal(amount: number): number {\n  return amount;\n}\n",
    "utf8",
  );

  const afterAudit = await service.auditCodeAnchors(repo);
  assert.deepEqual(afterAudit.stale_content.map((issue) => issue.claim_id), ["claim.compute_total_discount"]);

  const html = await service.buildGraphView(repo);
  assert.match(html, /Component Without Anchor/);
  assert.match(html, /Greplica graph view/);
  assert.match(html, /stale content/);
  assert.match(html, /"stale_content":1/);

  const markdown = renderGraphContextMarkdown({
    query: "computeTotal",
    search_config_version: "test",
    embedding_status: { checked_objects: 0, created: 0, reused: 0 },
    claims: [],
    components: [],
    flows: [],
    sources: [],
    ranked_results: [
      {
        type: "claim",
        rank: 1,
        score: 1,
        signals: {},
        object: storedClaim,
        about: [],
        evidence: [],
        code_anchors: [{ file: "src/foo.ts", symbol: "computeTotal", status: "stale_content" }],
      },
    ],
    debug: {},
  });
  assert.match(markdown, /stale content/);
} finally {
  db.close();
}

console.log("Graph view checks passed.");
