import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
let normalizeProposal;
let validateProposal;
let KnowledgeGraphService;
let openDatabase;
let SqliteRepository;

beforeAll(async () => {
  const proposal = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));
  const validate = await import(new URL("dist/libs/knowledge-graph/validate-proposal.js", root));
  const service = await import(new URL("dist/libs/knowledge-graph/service.js", root));
  const db = await import(new URL("dist/libs/storage/sqlite/db.js", root));
  const repo = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
  normalizeProposal = proposal.normalizeProposal;
  validateProposal = validate.validateProposal;
  KnowledgeGraphService = service.KnowledgeGraphService;
  openDatabase = db.openDatabase;
  SqliteRepository = repo.SqliteRepository;
});

const components = [
  { id: "component.a", name: "A" },
  { id: "component.b", name: "B" },
];

describe("proposal validation", () => {
  test("does not crash on edges using from_id/to_id and reports a clear error", () => {
    const malformedEdge = {
      title: "Malformed edge repro",
      creates: {
        components,
        edges: [{ from_id: "component.a", to_id: "component.b", kind: "contains" }],
      },
    };

    let normalized;
    expect(() => {
      normalized = normalizeProposal(malformedEdge);
    }).not.toThrow();

    const malformedResult = validateProposal(normalized);
    expect(malformedResult.valid).toBe(false);
    expect(malformedResult.errors.some((error) => error.includes("from'/'to"))).toBe(true);
  });

  test("does not crash on edges missing kind and reports them invalid", () => {
    const missingKindEdge = {
      title: "Missing kind repro",
      creates: {
        components,
        edges: [{ from: "component.a", to: "component.b" }],
      },
    };

    let normalizedMissingKind;
    expect(() => {
      normalizedMissingKind = normalizeProposal(missingKindEdge);
    }).not.toThrow();

    expect(validateProposal(normalizedMissingKind).valid).toBe(false);
  });

  test("accepts well-formed compact edges", () => {
    const compactEdge = {
      title: "Compact edge",
      creates: {
        components,
        edges: [{ kind: "contains", from: "component.a", to: "component.b" }],
      },
    };

    const compactResult = validateProposal(normalizeProposal(compactEdge));
    expect(compactResult.valid).toBe(true);
  });
});

describe("repo-scoped graph objects", () => {
  test("repos are distinct and cross-repo compact references are rejected", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "greplica-proposal-validate-test-"));
    const db = openDatabase(join(tmp, "graph.db"));

    try {
      const repository = new SqliteRepository(db);
      const service = new KnowledgeGraphService(repository);
      const repoA = { repo_root: join(tmp, "repo-a"), repo_name: "repo-a", default_branch: "main" };
      const repoB = { repo_root: join(tmp, "repo-b"), repo_name: "repo-b", default_branch: "main" };
      const repoC = { repo_root: join(tmp, "repo-c"), repo_name: "repo-c", default_branch: "main" };
      const repoAProposal = {
        title: "Seed CLI component",
        creates: { components: [{ id: "component.cli", name: "Repo A CLI" }] },
      };
      const repoBProposal = {
        title: "Seed CLI component",
        creates: { components: [{ id: "component.cli", name: "Repo B CLI" }] },
      };

      const initializedA = service.initRepo(repoA);
      const initializedB = service.initRepo(repoB);
      service.initRepo(repoC);
      const memoryCommit = repository.createMemoryCommit({
        scope_id: initializedA.working_scope_id,
        title: "Seed repo A",
      });
      repository.createProposalRecords(initializedA.working_scope_id, memoryCommit.id, normalizeProposal(repoAProposal));

      const repoBResult = await service.validateProposal(repoB, repoBProposal);
      expect(repoBResult.valid).toBe(true);

      const repoCCrossReference = await service.validateProposal(repoC, {
        title: "Repo C cross-repo compact reference",
        creates: {
          claims: [
            {
              id: "claim.about_cli",
              kind: "fact",
              text: "Repo C references a CLI component.",
              truth: "unknown",
              intent: "unknown",
              about: "component.cli",
            },
          ],
        },
      });
      expect(repoCCrossReference.valid).toBe(false);
      expect(
        repoCCrossReference.errors.some((error) => error.includes("component:component.cli")),
      ).toBe(true);

      const repoBMemoryCommit = repository.createMemoryCommit({
        scope_id: initializedB.working_scope_id,
        title: "Seed repo B",
      });
      repository.createProposalRecords(initializedB.working_scope_id, repoBMemoryCommit.id, normalizeProposal(repoBProposal));

      const repoBDuplicateResult = await service.validateProposal(repoB, repoBProposal);
      expect(repoBDuplicateResult.valid).toBe(false);
      expect(repoBDuplicateResult.errors.includes("component:component.cli already exists.")).toBe(true);

      const repoAGraph = service.readGraph(repoA);
      const repoBGraph = service.readGraph(repoB);
      expect(repoAGraph.components.map((component) => component.name)).toEqual(["Repo A CLI"]);
      expect(repoBGraph.components.map((component) => component.name)).toEqual(["Repo B CLI"]);
      expect(initializedB.repo_id === initializedA.repo_id).toBe(false);
    } finally {
      db.close();
    }
  });
});
