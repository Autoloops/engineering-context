import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const { CodeAnchorResolver } = await import(new URL("dist/libs/knowledge-graph/code-anchors/resolver.js", root));
const { fingerprintClaimAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/fingerprint.js", root));
const { auditClaimCodeAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/audit.js", root));
const { detectRepoContext } = await import(new URL("dist/apps/cli/repo-context.js", root));
const { RepoInstallationStore } = await import(new URL("dist/libs/install/repo-installation-store.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
const file = join(repo, "mod.py");
const anchor = { file: "mod.py", symbol: "foo" };
const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

mkdirSync(join(repo, "src"));
assert.deepEqual(
  await fingerprintClaimAnchors(repo, [{ file: "src" }], new CodeAnchorResolver()),
  {},
  "directory component anchors remain valid navigation targets without crashing fingerprinting",
);

// Baseline fingerprint captured when the fact was "written".
writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

async function driftedIds(variant) {
  writeFileSync(file, variant);
  const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
  return result.drifted.map((issue) => issue.claim_id);
}

// Unchanged code does not drift.
assert.deepEqual(await driftedIds("def foo():\n    # returns the threshold\n    return 3\n"), []);

// A real value change (3 -> 8) drifts.
assert.deepEqual(await driftedIds("def foo():\n    # returns the threshold\n    return 8\n"), ["claim.foo"]);

// Comment-only edits do not drift.
assert.deepEqual(await driftedIds("def foo():\n    # returns the configured threshold value\n    return 3\n"), []);

// Whitespace-only edits do not drift.
assert.deepEqual(await driftedIds("def foo():\n\n    # returns the threshold\n    return 3\n\n"), []);

// A claim with no stored baseline is treated as unknown, never drifted.
const noBaseline = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver());
assert.deepEqual(noBaseline.drifted, []);

// Extensions with a bundled tree-sitter grammar (toml, css, html, ...) must
// get the same comment-insensitive fingerprint as languages like Python,
// instead of falling back to whitespace-only normalization.
async function assertCommentInsensitive(fileName, anchorSymbol, base, commentOnlyEdit, semanticEdit) {
  const filePath = join(repo, fileName);
  const anchor = { file: fileName, symbol: anchorSymbol };
  const drift = { id: `claim.${fileName}`, kind: "fact", text: "value is set", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

  writeFileSync(filePath, base);
  const baselineFp = new Map([[drift.id, await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

  async function driftedFor(variant) {
    writeFileSync(filePath, variant);
    const result = await auditClaimCodeAnchors(repo, [drift], new CodeAnchorResolver(), baselineFp);
    return result.drifted.map((issue) => issue.claim_id);
  }

  assert.deepEqual(await driftedFor(commentOnlyEdit), [], `${fileName}: comment-only edit should not drift`);
  assert.deepEqual(await driftedFor(semanticEdit), [drift.id], `${fileName}: real value change should drift`);
}

await assertCommentInsensitive(
  "Cargo.toml",
  undefined,
  "# threshold\nlimit = 3\n",
  "# the configured threshold\nlimit = 3\n",
  "# threshold\nlimit = 8\n",
);

await assertCommentInsensitive(
  "theme.css",
  undefined,
  "/* threshold */\n.limit { z-index: 3; }\n",
  "/* the configured threshold */\n.limit { z-index: 3; }\n",
  "/* threshold */\n.limit { z-index: 8; }\n",
);

await assertCommentInsensitive(
  "index.html",
  undefined,
  "<!-- threshold -->\n<div data-limit=\"3\"></div>\n",
  "<!-- the configured threshold -->\n<div data-limit=\"3\"></div>\n",
  "<!-- threshold -->\n<div data-limit=\"8\"></div>\n",
);

for (const fileName of ["settings.ex", "settings.exs"]) {
  await assertCommentInsensitive(
    fileName,
    undefined,
    "# threshold\nlimit = 3\n",
    "# the configured threshold\nlimit = 3\n",
    "# threshold\nlimit = 8\n",
  );
}

await assertCommentInsensitive(
  "Limits.sol",
  undefined,
  "// threshold\ncontract Limits { uint256 constant LIMIT = 3; }\n",
  "// the configured threshold\ncontract Limits { uint256 constant LIMIT = 3; }\n",
  "// threshold\ncontract Limits { uint256 constant LIMIT = 8; }\n",
);

await assertCommentInsensitive(
  "limits.zig",
  undefined,
  "// threshold\nconst limit: u8 = 3;\n",
  "// the configured threshold\nconst limit: u8 = 3;\n",
  "// threshold\nconst limit: u8 = 8;\n",
);

for (const fileName of ["limits.hh", "limits.hxx"]) {
  await assertCommentInsensitive(
    fileName,
    undefined,
    "// threshold\nconstexpr int limit = 3;\n",
    "// the configured threshold\nconstexpr int limit = 3;\n",
    "// threshold\nconstexpr int limit = 8;\n",
  );
}

// The user-facing audit must surface content drift and fail even when every
// anchor still resolves, so automation cannot mistake changed code for a
// structurally clean graph.
const greplicaHome = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-cli-home-"));
const repoRef = detectRepoContext(repo);
const db = openDatabase(join(greplicaHome, "graph.db"));
try {
  new RepoInstallationStore(db).activateLocal(repoRef, {
    hooksEnabled: false,
    autoMemoryUpdates: false,
  });
  const repository = new SqliteRepository(db);
  const initialized = new KnowledgeGraphService(repository).initRepo(repoRef);
  const working = repository.requireWorkingScope(initialized.repo_id);
  const commit = repository.createMemoryCommit({
    scope_id: working.id,
    title: "Seed content drift CLI check",
  });
  repository.createProposalRecords(
    working.id,
    commit.id,
    {
      title: "Seed content drift CLI check",
      creates: { claims: [claim] },
    },
    baseline,
  );
} finally {
  db.close();
}

writeFileSync(file, "def foo():\n    # returns the threshold\n    return 8\n");
const cliAudit = spawnSync(process.execPath, [cliPath, "graph", "audit", "anchors"], {
  cwd: repo,
  encoding: "utf8",
  env: { ...process.env, GREPLICA_HOME: greplicaHome },
});
assert.equal(cliAudit.status, 1, cliAudit.stderr);
assert.match(cliAudit.stdout, /Content drift:\n- claim\.foo -> mod\.py#foo/);
assert.match(cliAudit.stdout, /Invalid files:\n- None\./);
assert.match(cliAudit.stdout, /Missing symbols:\n- None\./);

console.log("check-anchor-drift: ok");
