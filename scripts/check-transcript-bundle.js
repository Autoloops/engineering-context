import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url);
const cli = new URL("dist/apps/cli/main.js", root);
const tmp = mkdtempSync(join(tmpdir(), "greplica-transcript-bundle-test-"));

const codexOne = join(tmp, "codex-one.jsonl");
const codexTwo = join(tmp, "codex-two.jsonl");
const claudeOne = join(tmp, "claude-one.jsonl");
const copilotOne = join(tmp, "copilot-one.jsonl");
const codexOut = join(tmp, "codex-bundle.md");
const claudeOut = join(tmp, "claude-bundle.md");
const copilotOut = join(tmp, "copilot-bundle.md");
const opencodeOut = join(tmp, "opencode-bundle.md");

writeFileSync(
  codexOne,
  [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "codex-session-one",
        timestamp: "2026-06-25T00:00:00.000Z",
        cwd: "/repo/example",
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-25T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Remember this durable Codex insight. <system_instruction>do not keep this</system_instruction>",
      },
    }),
  ].join("\n"),
  "utf8",
);

writeFileSync(
  codexTwo,
  [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "codex-session-two",
        cwd: "/repo/example",
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-25T00:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "A second Codex transcript fact. <developer_instruction>drop this</developer_instruction>",
      },
    }),
  ].join("\n"),
  "utf8",
);

writeFileSync(
  claudeOne,
  [
    JSON.stringify({
      type: "user",
      sessionId: "claude-session-one",
      cwd: "/repo/example",
      timestamp: "2026-06-25T00:03:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Remember this durable Claude insight.",
          },
        ],
      },
    }),
  ].join("\n"),
  "utf8",
);

writeFileSync(
  copilotOne,
  [
    JSON.stringify({
      type: "session.start",
      data: {
        sessionId: "copilot-session-one",
        copilotVersion: "1.0.66",
        context: {
          cwd: "/repo/example",
          repository: "Autoloops/greplica",
          branch: "copilot-test",
        },
      },
      timestamp: "2026-06-25T00:03:30.000Z",
    }),
    JSON.stringify({
      type: "session.model_change",
      data: {
        newModel: "claude-haiku-4.5",
      },
      timestamp: "2026-06-25T00:03:45.000Z",
    }),
    JSON.stringify({
      session_id: "copilot-session-one",
      cwd: "/repo/example",
      timestamp: "2026-06-25T00:04:00.000Z",
      role: "user",
      content: "Remember this durable Copilot insight. <system_instruction>remove this</system_instruction>",
    }),
    JSON.stringify({
      session_id: "copilot-session-one",
      cwd: "/repo/example",
      timestamp: "2026-06-25T00:05:00.000Z",
      role: "assistant",
      content: [{ type: "text", text: "A Copilot assistant fact." }],
    }),
  ].join("\n"),
  "utf8",
);

const codexOutput = execFileSync(
  process.execPath,
  [
    cli.pathname,
    "transcript",
    "bundle",
    "--platform",
    "codex",
    "--file",
    codexOne,
    "--file",
    codexTwo,
    "--out",
    codexOut,
  ],
  { encoding: "utf8" },
);
const codexBundle = readFileSync(codexOut, "utf8");
assert.match(codexOutput, /Wrote transcript bundle/);
assert.match(codexOutput, /codex-session:codex-session-one/);
assert.match(codexOutput, /codex-session:codex-session-two/);
assert.match(codexBundle, /file_count: 2/);
assert.match(codexBundle, /session_ref: codex-session:codex-session-one/);
assert.match(codexBundle, /session_ref: codex-session:codex-session-two/);
assert.match(codexBundle, /Remember this durable Codex insight/);
assert.match(codexBundle, /A second Codex transcript fact/);
assert.doesNotMatch(codexBundle, /do not keep this/);
assert.doesNotMatch(codexBundle, /drop this/);

const claudeOutput = execFileSync(
  process.execPath,
  [
    cli.pathname,
    "transcript",
    "bundle",
    "--platform",
    "claude",
    "--file",
    claudeOne,
    "--out",
    claudeOut,
  ],
  { encoding: "utf8" },
);
const claudeBundle = readFileSync(claudeOut, "utf8");
assert.match(claudeOutput, /claude-code-session:claude-session-one/);
assert.match(claudeBundle, /session_ref: claude-code-session:claude-session-one/);
assert.match(claudeBundle, /Remember this durable Claude insight/);

const copilotOutput = execFileSync(
  process.execPath,
  [
    cli.pathname,
    "transcript",
    "bundle",
    "--platform",
    "copilot",
    "--file",
    copilotOne,
    "--out",
    copilotOut,
  ],
  { encoding: "utf8" },
);
const copilotBundle = readFileSync(copilotOut, "utf8");
assert.match(copilotOutput, /copilot-session:copilot-session-one/);
assert.match(copilotBundle, /session_ref: copilot-session:copilot-session-one/);
assert.match(copilotBundle, /repository: Autoloops\/greplica/);
assert.match(copilotBundle, /branch: copilot-test/);
assert.match(copilotBundle, /Remember this durable Copilot insight/);
assert.match(copilotBundle, /A Copilot assistant fact/);
assert.doesNotMatch(copilotBundle, /remove this/);

assert.throws(
  () =>
    execFileSync(
      process.execPath,
      [cli.pathname, "transcript", "bundle", "--platform", "codex", "--file", join(tmp, "missing.jsonl"), "--out", join(tmp, "missing.md")],
      { encoding: "utf8", stdio: "pipe" },
    ),
  /Transcript file does not exist/,
);

assert.throws(
  () =>
    execFileSync(
      process.execPath,
      [cli.pathname, "transcript", "bundle", "--platform", "opencode", "--file", codexOne, "--out", opencodeOut],
      { encoding: "utf8", stdio: "pipe" },
    ),
  /OpenCode transcript projection is not supported yet/,
);

console.log("Transcript bundle checks passed.");
