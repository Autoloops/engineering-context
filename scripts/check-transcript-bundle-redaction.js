import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const tmp = mkdtempSync(join(tmpdir(), "greplica-transcript-bundle-redaction-test-"));

const codexFile = join(tmp, "codex-secrets.jsonl");
const out = join(tmp, "codex-secrets-bundle.md");
const metadataToken = ["ghp_", "1234567890abcdef1234567890abcdef1234"].join("");
const quotedPassword = "correct horse battery staple";

writeFileSync(
  codexFile,
  [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "codex-secrets-session",
        timestamp: "2026-07-01T00:00:00.000Z",
        cwd: `https://user:${metadataToken}@github.com/example/repo`,
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message:
          `Here is my .env for reference:\nAWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\nSTRIPE_SECRET_KEY=abcdefghijklmnopqrstuvwx\nDATABASE_PASSWORD="${quotedPassword}"\nNODE_ENV=production`,
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Debugged the request with curl -H 'Authorization: Bearer abc123DEF456ghi789JKL012mno'.",
      },
    }),
  ].join("\n"),
  "utf8",
);

execFileSync(
  process.execPath,
  [cliPath, "transcript", "bundle", "--platform", "codex", "--file", codexFile, "--out", out],
);
const bundle = readFileSync(out, "utf8");

// The bundle file on disk must not contain the raw secrets.
assert.doesNotMatch(bundle, /AKIAABCDEFGHIJKLMNOP/);
assert.doesNotMatch(bundle, /abcdefghijklmnopqrstuvwx/);
assert.doesNotMatch(bundle, /abc123DEF456ghi789JKL012mno/);
assert.ok(!bundle.includes(metadataToken));
assert.ok(!bundle.includes(quotedPassword));

// Non-secret content and structure must be preserved.
assert.match(bundle, /NODE_ENV=production/);
assert.match(bundle, /Debugged the request with curl/);
assert.match(bundle, /\[REDACTED:aws-access-key-id\]/);
assert.match(bundle, /\[REDACTED:(env-assignment|stripe-key)\]/);
assert.match(bundle, /Bearer \[REDACTED:bearer-token\]/);
assert.match(bundle, /cwd: https:\/\/user:\[REDACTED:github-token\]@github\.com\/example\/repo/);
assert.match(bundle, /DATABASE_PASSWORD="\[REDACTED:env-assignment\]"/);

console.log("Transcript bundle redaction checks passed.");
