import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-view-test-"));
const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = {
    repo_root: join(tmp, "repo"),
    repo_name: "graph-view-null-anchor",
    default_branch: "main",
  };

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

  const html = service.buildGraphView(repo);
  assert.match(html, /Component Without Anchor/);
  assert.match(html, /Greplica graph view/);
} finally {
  db.close();
}

console.log("Graph view checks passed.");
