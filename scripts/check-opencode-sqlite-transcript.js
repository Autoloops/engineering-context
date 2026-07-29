import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const repoRoot = resolve(root.pathname);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const dir = mkdtempSync(join(tmpdir(), "greplica-opencode-sqlite-test-"));
const workspace = join(dir, "repo");
const greplicaHome = join(dir, "greplica-home");
const xdgConfigHome = join(dir, "xdg-config");
const xdgDataHome = join(dir, "xdg#data");
const dbPath = join(xdgDataHome, "opencode", "opencode.db");
const fakeBin = join(dir, "bin");
const runnerMarker = join(dir, "opencode-runner.json");
const sessionId = "session-abc";

const env = {
  ...process.env,
  GREPLICA_HOME: greplicaHome,
  GREPLICA_INSTALL_SKIP_PREWARM: "1",
  OPENCODE_TEST_MARKER: runnerMarker,
  PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_DATA_HOME: xdgDataHome,
};

process.env.XDG_DATA_HOME = xdgDataHome;
const { opencodeInstaller } = await import(new URL("dist/libs/install/platforms/opencode.js", root));

try {
  seedSqliteDatabase();
  checkSqliteProjection();
  checkFailureCases();
  checkFileLayout();
  checkWorkerEndToEnd();
  console.log("check-opencode-sqlite-transcript: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function seedSqliteDatabase() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run(sessionId, workspace);

  const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  insertMessage.run("message-user", sessionId, 1000, 1000, JSON.stringify({ role: "user" }));
  insertMessage.run("message-agent", sessionId, 2000, 2000, JSON.stringify({ role: "assistant" }));

  const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  insertPart.run("part-user-text", "message-user", sessionId, 1001, 1001, JSON.stringify({ type: "text", text: "first user message" }));
  insertPart.run("part-tool", "message-agent", sessionId, 2001, 2001, JSON.stringify({ type: "tool", text: "excluded tool payload" }));
  insertPart.run("part-reasoning", "message-agent", sessionId, 2002, 2002, JSON.stringify({ type: "reasoning", text: "excluded reasoning" }));
  insertPart.run("part-agent-text-a", "message-agent", sessionId, 2003, 2003, JSON.stringify({ type: "text", text: "second agent message" }));
  insertPart.run("part-agent-text-b", "message-agent", sessionId, 2004, 2004, JSON.stringify({ type: "text", text: "third agent message" }));
  db.close();
}

function checkSqliteProjection() {
  const pointer = `sqlite:${dbPath}#${sessionId}`;
  const transcript = opencodeInstaller.loadTranscript(pointer);
  const events = transcript.split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map(({ role, content }) => [role, content]), [
    ["user", "first user message"],
    ["assistant", "second agent message"],
    ["assistant", "third agent message"],
  ]);

  const markdown = opencodeInstaller.transcriptToMarkdown(transcript);
  assert.match(markdown, /### human[\s\S]*first user message/);
  assert.match(markdown, /### agent[\s\S]*second agent message[\s\S]*third agent message/);
  assert.doesNotMatch(markdown, /excluded tool payload|excluded reasoning/);
}

function checkFailureCases() {
  assert.equal(opencodeInstaller.loadTranscript(`sqlite:${dbPath}#missing-session`), "");
  assert.equal(opencodeInstaller.loadTranscript(`sqlite:${join(dir, "missing.db")}#${sessionId}`), "");
  assert.equal(opencodeInstaller.loadTranscript("sqlite:missing-separator"), "");

  const corruptDbPath = join(dir, "corrupt.db");
  writeFileSync(corruptDbPath, "not a sqlite database");
  assert.equal(opencodeInstaller.loadTranscript(`sqlite:${corruptDbPath}#${sessionId}`), "");
}

function checkFileLayout() {
  const fileSessionId = "file-session";
  const sessionFile = join(xdgDataHome, "opencode", "storage", "session", `${fileSessionId}.json`);
  const messageDir = join(xdgDataHome, "opencode", "storage", "message", fileSessionId);
  mkdirSync(messageDir, { recursive: true });
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ id: fileSessionId, directory: workspace }));
  writeFileSync(join(messageDir, "message.json"), JSON.stringify({ role: "user", content: "file layout message" }));
  const markdown = opencodeInstaller.transcriptToMarkdown(opencodeInstaller.loadTranscript(sessionFile));
  assert.match(markdown, /file layout message/);
}

function checkWorkerEndToEnd() {
  mkdirSync(fakeBin, { recursive: true });
  const fakeOpenCode = join(fakeBin, "opencode");
  writeFileSync(fakeOpenCode, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OPENCODE_TEST_MARKER, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{"type":"done"}\\n');
`);
  chmodSync(fakeOpenCode, 0o755);

  runOrThrow(["git", "init", "-q", workspace]);
  runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "opencode",
    "--embedding",
    "local",
    "--auto-memory",
    "disabled",
  ], workspace);

  const configPath = join(greplicaHome, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.session.stopThreshold = 1;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const hookInput = JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    cwd: workspace,
  });
  runOrThrow([process.execPath, cli, "hook", "ingest", "--platform", "opencode"], workspace, hookInput);
  assert.equal(existsSync(runnerMarker), false, "disabled automatic updates should not spawn a worker");
  const graphDb = new Database(join(greplicaHome, "graph.db"));
  graphDb.prepare("UPDATE repos SET auto_memory_updates = 1").run();
  graphDb.close();
  runOrThrow([process.execPath, cli, "hook", "worker"], workspace);

  const args = JSON.parse(readFileSync(runnerMarker, "utf8"));
  const prompt = args[args.indexOf("-p") + 1];
  assert.equal(typeof prompt, "string");
  assert.match(prompt, /first user message/);
  assert.match(prompt, /second agent message/);
  assert.match(prompt, /third agent message/);
  assert.doesNotMatch(prompt, /excluded tool payload|excluded reasoning/);
}

function runOrThrow(command, cwd = repoRoot, input) {
  const result = spawnSync(command[0], command.slice(1), { cwd, env, input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command.join(" ")}\n${result.stderr ?? ""}`);
  }
  return result;
}
