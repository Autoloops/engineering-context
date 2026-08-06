import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-dedup-test-"));
const db = openDatabase(join(tmp, "graph.db"));

const originalText =
  "Rate limiting on uploads is based on file size, not request count, because upload sizes vary widely.";

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = {
    repo_root: tmp,
    repo_name: "dedup-check-repo",
    default_branch: "main",
  };

  service.initRepo(repo);

  const seedResult = await service.applyProposal(repo, {
    title: "Seed original claim",
    creates: {
      components: [
        {
          id: "component.uploads",
          name: "File upload handling",
        },
      ],
      claims: [
        {
          id: "claim.rate_limit_by_file_size",
          kind: "decision",
          text: originalText,
          truth: "source_verified",
          intent: "intended",
          about: "component.uploads",
        },
      ],
    },
  });

  assert.equal(
    Object.hasOwn(seedResult, "duplicate_warnings"),
    false,
    "proposal apply must not return duplicate warnings",
  );

  const duplicateResult = await service.validateProposal(repo, {
    title: "Rediscovered same decision",
    creates: {
      claims: [
        {
          id: "claim.file_size_rate_limit_v2",
          kind: "decision",
          text: originalText,
          truth: "source_verified",
          intent: "intended",
          about: "component.uploads",
        },
      ],
    },
  });

  assert.equal(duplicateResult.valid, true);
  assert.ok(
    duplicateResult.duplicate_warnings["claim.file_size_rate_limit_v2"]?.some(
      (match) => match.claim_id === "claim.rate_limit_by_file_size",
    ),
    "proposal validation should compare matching claim-document embeddings",
  );

  const unrelatedResult = await service.validateProposal(repo, {
    title: "Unrelated claim",
    creates: {
      claims: [
        {
          id: "claim.unrelated_logging_format",
          kind: "fact",
          text: "Application logs are written in JSON format to stdout for ingestion by the log aggregator.",
          truth: "source_verified",
          intent: "intended",
        },
      ],
    },
  });

  assert.deepEqual(unrelatedResult.duplicate_warnings, {}, "unrelated claims should not be flagged");

  const handledResult = await service.validateProposal(repo, {
    title: "Replace the existing decision",
    creates: {
      claims: [
        {
          id: "claim.rate_limit_replacement",
          kind: "decision",
          text: originalText,
          truth: "source_verified",
          intent: "intended",
          about: "component.uploads",
          supersedes: "claim.rate_limit_by_file_size",
        },
      ],
    },
  });

  assert.deepEqual(
    handledResult.duplicate_warnings,
    {},
    "a proposed supersedes edge should suppress the warning it already resolves",
  );

  const replacementResult = await service.applyProposal(repo, {
    title: "Supersede the original claim",
    creates: {
      claims: [
        {
          id: "claim.auth_sessions",
          kind: "decision",
          text: "Authentication uses short-lived signed session tokens.",
          truth: "source_verified",
          intent: "intended",
          supersedes: "claim.rate_limit_by_file_size",
        },
      ],
    },
  });

  assert.equal(
    Object.hasOwn(replacementResult, "duplicate_warnings"),
    false,
    "proposal apply must remain free of duplicate-warning output",
  );
  assert.deepEqual(
    service.readGraph(repo).claims.map((claim) => claim.id),
    ["claim.auth_sessions"],
    "the original claim should be inactive after supersession",
  );

  const inactiveResult = await service.validateProposal(repo, {
    title: "Reintroduce old wording",
    creates: {
      claims: [
        {
          id: "claim.old_wording_again",
          kind: "decision",
          text: originalText,
          truth: "source_verified",
          intent: "intended",
        },
      ],
    },
  });

  const inactiveMatches = Object.values(inactiveResult.duplicate_warnings).flat();
  assert.equal(
    inactiveMatches.some((match) => match.claim_id === "claim.rate_limit_by_file_size"),
    false,
    "inactive claims must not participate in duplicate validation",
  );
} finally {
  db.close();
}

console.log("Proposal validation dedupe checks passed.");
