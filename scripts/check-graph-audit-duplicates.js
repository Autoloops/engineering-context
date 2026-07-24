import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const tmp = mkdtempSync(join(tmpdir(), "greplica-audit-duplicates-"));
process.env.GREPLICA_HOME = tmp;

const { defaultGreplicaConfig } = await import(new URL("dist/libs/config/greplica-config.js", root));
const { graphContextConfigFromGreplicaConfig } = await import(
  new URL("dist/libs/knowledge-graph/graph-context/config.js", root)
);
const { float32ArrayToBuffer } = await import(new URL("dist/libs/knowledge-graph/graph-context/vector.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { RepoInstallationStore } = await import(new URL("dist/libs/install/repo-installation-store.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { detectRepoContext } = await import(new URL("dist/apps/cli/repo-context.js", root));

const config = graphContextConfigFromGreplicaConfig(defaultGreplicaConfig);
const db = openDatabase(join(tmp, "graph.db"));

function embedding(x, y) {
  const values = Array(config.embedding.dimensions).fill(0);
  values[0] = x;
  values[1] = y;
  return float32ArrayToBuffer(values);
}

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository, config);
  const repo = detectRepoContext(rootPath);
  new RepoInstallationStore(db).activateLocal(repo, { hooksEnabled: false, autoMemoryUpdates: false });
  const initialized = service.initRepo(repo);
  const working = repository.requireWorkingScope(initialized.repo_id);
  const memoryCommit = repository.createMemoryCommit({
    scope_id: working.id,
    title: "Seed duplicate audit chain",
  });

  repository.createProposalRecords(working.id, memoryCommit.id, {
    title: "Seed duplicate audit chain",
    creates: {
      claims: [
        {
          id: "claim.audit_a",
          kind: "fact",
          text: "Claim A is similar to B but distinct from C.",
          truth: "source_verified",
          intent: "intended",
        },
        {
          id: "claim.audit_b",
          kind: "fact",
          text: "Claim B bridges the duplicate audit chain.",
          truth: "source_verified",
          intent: "intended",
        },
        {
          id: "claim.audit_c",
          kind: "fact",
          text: "Claim C is similar to B but distinct from A.",
          truth: "source_verified",
          intent: "intended",
        },
      ],
    },
  });

  repository.insertGraphObjectEmbeddings([
    {
      repo_id: initialized.repo_id,
      object_type: "claim",
      object_id: "claim.audit_a",
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      embedding: embedding(1, 0),
    },
    {
      repo_id: initialized.repo_id,
      object_type: "claim",
      object_id: "claim.audit_b",
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      embedding: embedding(0.8660254, 0.5),
    },
    {
      repo_id: initialized.repo_id,
      object_type: "claim",
      object_id: "claim.audit_c",
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      embedding: embedding(0.5, 0.8660254),
    },
  ]);

  const audit = await service.auditDuplicateClaims(repo);
  const pairs = audit.groups.flatMap((group) =>
    group.duplicates.map((duplicate) => `${group.claim_id}->${duplicate.claim_id}`),
  );
  assert.deepEqual(
    new Set(pairs),
    new Set(["claim.audit_a->claim.audit_b", "claim.audit_b->claim.audit_c"]),
    "duplicate audit should report every later duplicate pair without suppressing matched claims globally",
  );
  assert.equal(pairs.length, 2);
} finally {
  db.close();
}

const cli = spawnSync(process.execPath, [fileURLToPath(new URL("dist/apps/cli/main.js", root)), "graph", "audit", "duplicates"], {
  cwd: rootPath,
  env: { ...process.env, GREPLICA_HOME: tmp },
  encoding: "utf8",
});

assert.equal(cli.status, 1, `expected duplicate audit CLI to exit 1, stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`);
assert.match(
  cli.stdout,
  /Total duplicate pairs found: 2/,
  `expected duplicate audit CLI output to include pair count, stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
);

console.log("Graph duplicate audit checks passed.");
