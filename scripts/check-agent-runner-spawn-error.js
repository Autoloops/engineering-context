import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { runCodexAgent } = await import(new URL("dist/libs/agent-runner/codex.js", root));
const { runOpenCodeAgent } = await import(new URL("dist/libs/agent-runner/opencode.js", root));
const { runOpenHandsAgent } = await import(new URL("dist/libs/agent-runner/openhands.js", root));

const runners = [
  ["codex", runCodexAgent],
  ["opencode", runOpenCodeAgent],
  ["openhands", runOpenHandsAgent],
];

for (const [name, runAgent] of runners) {
  const runDir = mkdtempSync(join(tmpdir(), `greplica-${name}-spawn-error-`));
  const emptyPath = mkdtempSync(join(tmpdir(), `greplica-${name}-empty-path-`));
  const transcriptPath = join(runDir, "agent-events.jsonl");

  await assert.rejects(
    () =>
      runAgent({
        cwd: runDir,
        env: { PATH: emptyPath },
        prompt: "test prompt",
        transcriptPath,
        finalMessagePath: join(runDir, "final-message.md"),
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.code, "ENOENT");
      return true;
    },
  );

  rmSync(runDir, { recursive: true });
  rmSync(emptyPath, { recursive: true });
  assert.equal(existsSync(runDir), false, `${name} transcript directory must be removable after spawn failure`);
}

console.log("Agent runner spawn-error cleanup checks passed.");
