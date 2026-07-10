import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
let openDatabase;
let SqliteRepository;
let KnowledgeGraphService;

beforeAll(async () => {
  const db = await import(new URL("dist/libs/storage/sqlite/db.js", root));
  const repo = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
  const service = await import(new URL("dist/libs/knowledge-graph/service.js", root));
  openDatabase = db.openDatabase;
  SqliteRepository = repo.SqliteRepository;
  KnowledgeGraphService = service.KnowledgeGraphService;
});

describe("graph view", () => {
  test("renders components without code anchors", () => {
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
      expect(html).toMatch(/Component Without Anchor/);
      expect(html).toMatch(/Greplica graph view/);
    } finally {
      db.close();
    }
  });
});
