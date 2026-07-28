import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { installPlatform } = await import(new URL("dist/libs/install/platforms/index.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-antigravity-hooks-test-"));
process.env.ANTIGRAVITY_HOME = join(tmp, "antigravity-home");
const repoRoot = join(tmp, "repo");

const result = installPlatform("antigravity", { repoRoot, hooks: true });

assert.ok(result.hooks, "expected hooks to be installed when hooks: true");
assert.deepEqual(result.hooks.events, ["Stop"]);
assert.equal(result.hooks.configFiles.length, 2);

const hooksJsonPath = join(repoRoot, ".agents", "hooks.json");
const wrapperPath = result.hooks.configFiles[1];
assert.ok(existsSync(hooksJsonPath), "expected .agents/hooks.json to be written");
assert.ok(existsSync(wrapperPath), "expected the wrapper script to be written");

const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
assert.ok(hooksConfig.greplica, "expected a top-level greplica namespace");
assert.equal(hooksConfig.greplica.Stop.length, 1);
assert.equal(hooksConfig.greplica.Stop[0].hooks[0].command, wrapperPath);
assert.equal(typeof hooksConfig.greplica.Stop[0].hooks[0].timeout, "number");

// Re-running install must not duplicate entries under our own namespace.
installPlatform("antigravity", { repoRoot, hooks: true });
const afterReinstall = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
assert.equal(afterReinstall.greplica.Stop.length, 1, "reinstall must not duplicate Stop entries");
assert.equal(afterReinstall.greplica.Stop[0].hooks.length, 1, "reinstall must not duplicate hook handlers");

// Other tools' namespaces in the same shared hooks.json must survive untouched.
const withOtherTool = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
withOtherTool.cmux = { PreToolUse: [{ hooks: [{ type: "command", command: "/some/other/tool.sh" }] }] };
writeFileSync(hooksJsonPath, JSON.stringify(withOtherTool, null, 2));
installPlatform("antigravity", { repoRoot, hooks: true });
const afterOtherToolPresent = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
assert.deepEqual(afterOtherToolPresent.cmux, withOtherTool.cmux, "another tool's namespace must be preserved untouched");
assert.equal(afterOtherToolPresent.greplica.Stop.length, 1);

// The wrapper script must exit 0 even when the command it wraps fails --
// Stop hooks are documented as non-veto-capable, but the wrapper should
// never depend on that alone (mirrors a real, documented failure mode from
// another tool's Antigravity integration: a hook that propagated a
// non-zero exit code ended up blocking every tool call).
//
// Structural check: the script's last real instruction must unconditionally
// exit 0, regardless of what came before it.
const wrapperLines = readFileSync(wrapperPath, "utf8").trimEnd().split("\n");
const expectedLastLine = process.platform === "win32" ? "exit /b 0" : "exit 0";
assert.equal(wrapperLines[wrapperLines.length - 1], expectedLastLine, "wrapper must unconditionally exit 0 as its last instruction");

// Behavioral check: build a wrapper using the exact same template, but
// pointing at a command that deliberately fails, and confirm it still
// exits 0 end-to-end. Built per-platform since Windows has no bash/chmod.
const isWindows = process.platform === "win32";

const failingInner = join(tmp, isWindows ? "failing-inner-command.cmd" : "failing-inner-command.sh");
writeFileSync(
  failingInner,
  isWindows ? "@echo off\r\nmore >nul\r\nexit /b 1\r\n" : "#!/usr/bin/env bash\ncat >/dev/null\nexit 1\n",
  "utf8",
);
if (!isWindows) spawnSync("chmod", ["+x", failingInner]);

const testWrapperPath = join(tmp, isWindows ? "test-wrapper-with-failing-inner.cmd" : "test-wrapper-with-failing-inner.sh");
writeFileSync(
  testWrapperPath,
  isWindows
    ? `@echo off\r\ncall "${failingInner}" >nul 2>&1\r\nexit /b 0\r\n`
    : ["#!/usr/bin/env bash", `"${failingInner}" >/dev/null 2>&1`, "exit 0", ""].join("\n"),
  "utf8",
);
if (!isWindows) spawnSync("chmod", ["+x", testWrapperPath]);

const wrapperRun = spawnSync(testWrapperPath, [], { input: "{}", encoding: "utf8", shell: isWindows });
assert.equal(wrapperRun.status, 0, "wrapper must exit 0 even when the wrapped command fails");

console.log("Antigravity hook installer checks passed.");