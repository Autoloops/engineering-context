import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const { opencodeInstaller } = await import(new URL("dist/libs/install/platforms/opencode.js", root));

const dir = mkdtempSync(join(tmpdir(), "greplica-opencode-sqlite-test-"));
const dbPath = join(dir, "opencode.db");

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE messages (
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
  .run("session-abc", "user", "please fix the flaky retry logic", "2026-07-01T00:00:00.000Z");
db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
  .run("session-abc", "assistant", "done, added a bounded backoff", "2026-07-01T00:00:05.000Z");
db.close();

const pointer = `sqlite:${dbPath}#session-abc`;

// A pointer to a real database file with a matching session id is recognized as present.
assert.equal(opencodeInstaller.transcriptExists(pointer), true);

// A session id absent from an otherwise valid database is not treated as present.
assert.equal(opencodeInstaller.transcriptExists(`sqlite:${dbPath}#no-such-session`), false);

// A pointer to a database file that was never created is not treated as present.
assert.equal(opencodeInstaller.transcriptExists(`sqlite:${join(dir, "missing.db")}#session-abc`), false);

// Plain filesystem paths (the file-based OpenCode layout) still use a normal existence check.
const fileTranscript = join(dir, "session.json");
assert.equal(opencodeInstaller.transcriptExists(fileTranscript), false);
writeFileSync(fileTranscript, "{}");
assert.equal(opencodeInstaller.transcriptExists(fileTranscript), true);

// Once a sqlite pointer is recognized as present, it still loads and projects to non-empty
// markdown through the existing loadTranscript / transcriptToMarkdown pipeline.
const transcript = opencodeInstaller.loadTranscript(pointer);
const markdown = opencodeInstaller.transcriptToMarkdown(transcript);
assert.ok(markdown.trim().length > 0);

// A file that exists at the expected path but isn't a valid sqlite database (e.g. truncated
// or corrupted mid-write) must fail closed rather than throw and take down the worker.
const corruptDbPath = join(dir, "corrupt.db");
writeFileSync(corruptDbPath, "not a sqlite database");
const corruptPointer = `sqlite:${corruptDbPath}#session-abc`;
assert.equal(opencodeInstaller.transcriptExists(corruptPointer), false);
assert.equal(opencodeInstaller.loadTranscript(corruptPointer), "");

rmSync(dir, { recursive: true, force: true });

console.log("check-opencode-sqlite-transcript: ok");
