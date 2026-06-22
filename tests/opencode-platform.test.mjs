import test from "node:test";
import assert from "node:assert/strict";
import { opencodeInstaller } from "../dist/libs/install/platforms/opencode.js";

test("maps OpenCode session refs to stable source refs", () => {
  assert.equal(opencodeInstaller.sessionSourceRef("session-123"), "opencode-session:session-123");
  assert.equal(opencodeInstaller.sessionIdFromSourceRef("opencode-session:session-123"), "session-123");
  assert.equal(opencodeInstaller.sessionIdFromSourceRef("other:session-123"), undefined);
});

test("projects simple OpenCode JSONL transcripts to filtered markdown", () => {
  const markdown = opencodeInstaller.transcriptToMarkdown(
    [
      JSON.stringify({
        sessionID: "session-123",
        directory: "/repo",
        type: "message.updated",
        role: "user",
        content: "Please inspect the storage flow.",
      }),
      JSON.stringify({
        type: "message.updated",
        role: "assistant",
        content: [{ text: "The storage flow writes graph records." }],
      }),
    ].join("\n"),
  );

  assert.match(markdown, /session_id: session-123/);
  assert.match(markdown, /cwd: \/repo/);
  assert.match(markdown, /Please inspect the storage flow/);
  assert.match(markdown, /The storage flow writes graph records/);
});
