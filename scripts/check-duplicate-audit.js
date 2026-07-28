import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";

const temporary = mkdtempSync(join(tmpdir(), "greplica-duplicate-audit-"));
process.env.GREPLICA_HOME = join(temporary, "greplica-home");

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const { graphContextConfig } = await import(
  new URL("dist/libs/knowledge-graph/graph-context/config.js", root)
);
const { ManagedGraphMemoryClient } = await import(
  new URL("dist/libs/knowledge-graph/managed-client.js", root)
);
const { KnowledgeGraphService } = await import(
  new URL("dist/libs/knowledge-graph/service.js", root)
);
const { routeSchemas } = await import(new URL("dist/libs/managed/protocol.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(
  new URL("dist/libs/storage/sqlite/repository.js", root)
);
const { RepoInstallationStore } = await import(
  new URL("dist/libs/install/repo-installation-store.js", root)
);

const embeddingConfig = {
  ...graphContextConfig,
  dedupe: { similarityThreshold: 0.9 },
};

const repoRoot = join(temporary, "repo");
mkdirSync(repoRoot, { recursive: true });
execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repoRoot });
const repo = {
  repo_root: repoRoot,
  repo_name: "repo",
  default_branch: "main",
};
const db = openDatabase();
const repository = new SqliteRepository(db);
const installation = new RepoInstallationStore(db).activateLocal(repo, {
  hooksEnabled: false,
  autoMemoryUpdates: false,
});
const service = new KnowledgeGraphService(repository, embeddingConfig);
const initialized = service.initRepo(repo);
const memoryCommit = repository.createMemoryCommit({
  scope_id: initialized.working_scope_id,
  title: "Seed duplicate audit",
});
repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
  title: "Seed duplicate audit",
  creates: {
    claims: [
      claim("claim.alpha", "The worker closes its transcript before cleanup."),
      claim("claim.alpha-copy", "The worker closes the transcript before cleanup."),
      claim("claim.distinct", "The graph view renders a static HTML file."),
      claim("claim.superseded", "An obsolete duplicate claim."),
    ],
    edges: [{
      id: "edge.supersede-obsolete",
      from_id: "claim.distinct",
      from_type: "claim",
      to_id: "claim.superseded",
      to_type: "claim",
      kind: "supersedes",
    }],
  },
});
repository.insertGraphObjectEmbeddings([
  embedding(initialized.repo_id, "claim.alpha", vector(1, 0, 0)),
  embedding(initialized.repo_id, "claim.alpha-copy", vector(0.99, 0.05, 0)),
  embedding(initialized.repo_id, "claim.distinct", vector(0, 1, 0)),
  embedding(initialized.repo_id, "claim.superseded", vector(1, 0, 0)),
]);

const result = await service.auditDuplicateClaims(repo);
assert.equal(result.total_claims, 3, "superseded claims must not count as active");
assert.equal(result.groups.length, 1);
assert.equal(result.groups[0].claim_id, "claim.alpha");
assert.deepEqual(
  result.groups[0].duplicates.map(({ claim_id }) => claim_id),
  ["claim.alpha-copy"],
);
assert.equal(
  result.groups.some((group) =>
    group.claim_id === "claim.superseded" ||
    group.duplicates.some(({ claim_id }) => claim_id === "claim.superseded")),
  false,
);
db.close();

const output = execFileSync(process.execPath, [cliPath, "graph", "audit", "duplicates"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, GREPLICA_HOME: process.env.GREPLICA_HOME },
});
assert.match(output, /Duplicate claims audit:/);
assert.match(output, /Total active claims checked: 3/);
assert.match(output, /Total duplicate pairs found: 1/);
assert.match(output, /claim\.alpha-copy/);
assert.doesNotMatch(output, /claim\.superseded/);

const managedResult = {
  total_claims: 2,
  groups: [{
    claim_id: "claim.one",
    claim_text: "One",
    duplicates: [{ claim_id: "claim.two", claim_text: "Two", similarity: 0.95 }],
  }],
};
assert.equal(Value.Check(routeSchemas.graphAuditDuplicates.response, managedResult), true);
let managedRequest;
const managedClient = new ManagedGraphMemoryClient(
  {
    ...installation,
    activeMode: "managed",
    managedRepoId: "11111111-1111-4111-8111-111111111111",
  },
  repo,
  {
    apiUrl: "https://managed.example.test",
    token: "test-token",
    fetchImpl: async (url, input) => {
      managedRequest = { url: String(url), method: input?.method };
      return new Response(JSON.stringify(managedResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
);
assert.deepEqual(await managedClient.auditDuplicateClaims(), managedResult);
assert.deepEqual(managedRequest, {
  url: "https://managed.example.test/v1/repos/11111111-1111-4111-8111-111111111111/graph/audit-duplicates",
  method: "GET",
});

await assertEmbeddingIntegrity();

console.log("Duplicate audit checks passed.");

async function assertEmbeddingIntegrity() {
  const integrityDb = openDatabase(join(temporary, "integrity.db"));
  try {
    const integrityRepository = new SqliteRepository(integrityDb);
    const integrityConfig = {
      ...embeddingConfig,
      embedding: {
        provider: "openai",
        apiKey: "test-key",
        model: "test-model",
        dimensions: 3,
        batchSize: 16,
      },
    };
    const integrityService = new KnowledgeGraphService(integrityRepository, integrityConfig);
    const integrityRepo = {
      repo_root: join(temporary, "integrity-repo"),
      repo_name: "integrity-repo",
      default_branch: "main",
    };
    const integrityInitialized = integrityService.initRepo(integrityRepo);
    const commit = integrityRepository.createMemoryCommit({
      scope_id: integrityInitialized.working_scope_id,
      title: "Seed missing embedding",
    });
    integrityRepository.createProposalRecords(integrityInitialized.working_scope_id, commit.id, {
      title: "Seed missing embedding",
      creates: { claims: [claim("claim.missing", "This claim has no stored embedding.")] },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      await assert.rejects(
        integrityService.auditDuplicateClaims(integrityRepo),
        /returned 0 vectors for 1 missing claims/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    integrityDb.close();
  }
}

function claim(id, text) {
  return {
    id,
    kind: "fact",
    text,
    truth: "source_verified",
    intent: "intended",
  };
}

function embedding(repoId, claimId, vector) {
  return {
    repo_id: repoId,
    object_type: "claim",
    object_id: claimId,
    provider: embeddingConfig.embedding.provider,
    model: embeddingConfig.embedding.model,
    dimensions: embeddingConfig.embedding.dimensions,
    embedding: Buffer.from(new Float32Array(vector).buffer),
  };
}

function vector(first, second, third) {
  const result = Array(embeddingConfig.embedding.dimensions).fill(0);
  result[0] = first;
  result[1] = second;
  result[2] = third;
  return result;
}
