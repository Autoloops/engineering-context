import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), "greplica-hook-worker-failures-"));
const greplicaHomeDir = join(temporary, "greplica-home");
const workspace = join(temporary, "repo");
const transcriptPath = join(temporary, "session.jsonl");
const savedHome = process.env.GREPLICA_HOME;
const savedPath = process.env.PATH;

mkdirSync(greplicaHomeDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
  transcriptPath,
  `${JSON.stringify({
    type: "user",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello from hook failure test" }] },
  })}\n`,
  "utf8",
);

process.env.GREPLICA_HOME = greplicaHomeDir;
// Force spawn("claude") to fail so runWorkingMemoryUpdate rejects.
process.env.PATH = join(temporary, "empty-bin");

try {
  const { maybeUpdateWorkingMemory } = await import(new URL("dist/libs/hooks/worker.js", root));

  await maybeUpdateWorkingMemory({
    reason: "stop_threshold",
    session: {
      platform: "claude",
      session_id: "hook-failure-session",
      repo_id: "repo-test",
      transcript_path: transcriptPath,
      cwd: workspace,
      guidance_injected_at: null,
      stops_since_memory_current: 1,
      last_seen_at: new Date().toISOString(),
      last_memory_current_at: null,
    },
  });

  // Allow platform spawn close handlers to finish writing into the temp runDir
  // before assertions (retention copies first; OS temp cleanup is delayed).
  await new Promise((resolve) => setTimeout(resolve, 250));

  const logPath = join(greplicaHomeDir, "logs", "hook-worker.jsonl");
  assert.equal(existsSync(logPath), true, "expected hook-worker.jsonl after failure");
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length >= 1, true, "expected at least one failure log line");
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.platform, "claude");
  assert.equal(entry.session_id, "hook-failure-session");
  assert.equal(typeof entry.phase, "string");
  assert.equal(typeof entry.error, "string");
  assert.ok(entry.error.length > 0, "error message should be non-empty");
  assert.equal(typeof entry.timestamp, "string");

  const runsDir = join(greplicaHomeDir, "logs", "runs");
  assert.equal(existsSync(runsDir), true, "expected retained run artifacts under logs/runs");
  const retained = readdirSync(runsDir);
  assert.equal(retained.length >= 1, true, "expected at least one retained run directory");
  const retainedPath = join(runsDir, retained[0]);
  assert.equal(existsSync(retainedPath), true);

  console.log("check-hook-worker-failures: ok");
} finally {
  if (savedHome === undefined) delete process.env.GREPLICA_HOME;
  else process.env.GREPLICA_HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  rmSync(temporary, { recursive: true, force: true });
}
