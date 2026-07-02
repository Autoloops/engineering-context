#!/usr/bin/env node
// Focused smoke check for `greplica install --platform copilot`.
//
// Verifies user-level Copilot CLI skills + hooks under COPILOT_HOME, guidance
// output shape for SessionStart, non-destructive hook reinstall, and Stop hook
// session tracking with a sample transcript path.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const command = "greplica hook ingest --platform copilot";

const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-copilot-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "greplica-home");
const copilotHome = resolve(tempDir, "copilot-home");
const transcriptPath = resolve(tempDir, "copilot-session.jsonl");

const env = {
  ...process.env,
  COPILOT_HOME: copilotHome,
  GREPLICA_HOME: greplicaHome,
  GREPLICA_INSTALL_SKIP_PREWARM: "1",
};
delete env.GREPLICA_HOOK_DISABLE;

try {
  assert.ok(existsSync(cli), `Built CLI not found at ${cli}. Run "npm run build" first.`);
  runOrThrow(["git", "init", "-q", workspace], repoRoot);

  const installOutput = runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "copilot",
    "--embedding",
    "local",
  ], workspace);
  assert.match(installOutput.stdout, /Installed Greplica for GitHub Copilot CLI\./);
  assert.match(installOutput.stdout, /Hooks: installed for SessionStart, Stop\./);

  checkSkills();
  checkHooks();
  checkGuidanceOutput();
  checkStopSessionTracking();
  checkNonDestructiveReinstall();

  console.log(`OK: Copilot skills + hooks installed under ${copilotHome}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function checkSkills() {
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    assert.ok(existsSync(resolve(copilotHome, "skills", skill, "SKILL.md")), `missing skill ${skill}`);
  }
}

function checkHooks() {
  const hooksPath = resolve(copilotHome, "hooks", "greplica.json");
  assert.ok(existsSync(hooksPath), "greplica.json hook file was not created");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
  for (const event of ["SessionStart", "Stop"]) {
    assert.ok(commandPresent(hooks[event], command), `${event} hook missing command "${command}"`);
  }
}

function checkGuidanceOutput() {
  const hookInput = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "copilot-smoke-session",
    cwd: workspace,
  });
  const result = run([process.execPath, cli, "hook", "ingest", "--platform", "copilot"], workspace, hookInput);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(typeof payload.additionalContext, "string");
  assert.match(payload.additionalContext, /Greplica hook guidance/);
  assert.equal(payload.hookSpecificOutput, undefined);
}

function checkStopSessionTracking() {
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        session_id: "copilot-smoke-session",
        cwd: workspace,
        role: "user",
        content: "Remember this Copilot transcript fact.",
      }),
      JSON.stringify({
        session_id: "copilot-smoke-session",
        cwd: workspace,
        role: "assistant",
        content: "Stored Copilot transcript context.",
      }),
    ].join("\n"),
    "utf8",
  );

  const stopInput = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "copilot-smoke-session",
    cwd: workspace,
    transcript_path: transcriptPath,
  });
  const stopResult = run([process.execPath, cli, "hook", "ingest", "--platform", "copilot"], workspace, stopInput);
  assert.equal(stopResult.status, 0, stopResult.stderr);

  const markResult = run([
    process.execPath,
    cli,
    "session",
    "mark-memory-current",
    "--session-ref",
    "copilot-session:copilot-smoke-session",
  ], workspace);
  assert.equal(markResult.status, 0, markResult.stderr);
  assert.match(markResult.stdout, /Marked session memory current\./);
}

function checkNonDestructiveReinstall() {
  const hooksPath = resolve(copilotHome, "hooks", "greplica.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  hooks.hooks.SessionStart.push({ type: "command", command: "echo user-custom-hook", timeoutSec: 3 });
  hooks.hooks.preToolUse = [{ type: "command", command: "echo user-pretool", timeoutSec: 3 }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "copilot",
    "--embedding",
    "local",
  ], workspace);

  const after = readFileSync(hooksPath, "utf8");
  assert.match(after, /user-custom-hook/, "user's SessionStart hook was dropped on reinstall");
  assert.match(after, /user-pretool/, "user's unrelated preToolUse hook was dropped on reinstall");
  const occurrences = after.split(command).length - 1;
  assert.equal(occurrences, 2, `expected greplica command exactly twice after reinstall, found ${occurrences}`);
}

function commandPresent(entries, value) {
  return Array.isArray(entries) && entries.some((entry) => entry?.command === value);
}

function run(commandArgs, cwd, input) {
  return spawnSync(commandArgs[0], commandArgs.slice(1), { cwd, env, input, encoding: "utf8" });
}

function runOrThrow(commandArgs, cwd) {
  const result = run(commandArgs, cwd);
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${commandArgs.join(" ")}\n${result.stderr ?? ""}`);
  }
  return result;
}

function findRepoRoot(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/copilot.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find repo root from ${startDir}`);
}
