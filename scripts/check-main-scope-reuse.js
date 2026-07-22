import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Caller: package.json "test". Covers ensureScope main-scope reuse when default_branch changes.
// User: follow-up commits for code-review high/medium/low items.

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-main-scope-reuse-"));
const db = openDatabase(join(tmp, "graph.db"));
const repository = new SqliteRepository(db);

const { repo } = repository.upsertRepo({
  repo_root: tmp,
  repo_name: "scope-reuse",
  default_branch: "main",
});

const mainFirst = repository.ensureScope({
  repo_id: repo.id,
  kind: "main",
  name: "main",
  ref: "main",
});
assert.equal(mainFirst.name, "main");

const mainSecond = repository.ensureScope({
  repo_id: repo.id,
  kind: "main",
  name: "unknown",
  ref: "unknown",
});
assert.equal(mainSecond.id, mainFirst.id, "must reuse the same main scope id");
assert.equal(mainSecond.name, "unknown");
assert.equal(mainSecond.ref, "unknown");

const mainCount = db
  .prepare("SELECT COUNT(*) AS c FROM graph_scopes WHERE repo_id = ? AND kind = 'main'")
  .get(repo.id).c;
assert.equal(mainCount, 1, "re-init with a new default_branch must not create a second main scope");

db.close();
console.log("Main scope reuse checks passed.");
