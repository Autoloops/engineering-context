#!/usr/bin/env node
// Focused smoke check for `greplica install --platform continue`.
//
// Verifies user-level skills under CONTINUE_HOME, repo-local skills/rules/hooks,
// guidance output shape for UserPromptSubmit, non-destructive hook reinstall,
// and Stop hook session tracking with a sample transcript path.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const command = "greplica hook ingest --platform continue";

const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-continue-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "greplica-home");
const continueHome = resolve(tempDir, "continue-home");
const transcriptPath = resolve(tempDir, "continue-session.jsonl");

const env = {
  ...process.env,
  CONTINUE_HOME: continueHome,
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
    "continue",
    "--embedding",
    "local",
  ], workspace);
  assert.match(installOutput.stdout, /Installed Greplica for Continue\./);
  assert.match(installOutput.stdout, /Hooks: installed for UserPromptSubmit, Stop\./);

  checkUserSkills();
  checkRepoSkills();
  checkRule();
  checkHooks();
  checkGuidanceOutput();
  checkStopSessionTracking();
  checkNonDestructiveReinstall();

  console.log(`OK: Continue skills, rules, and hooks installed under ${continueHome} and ${workspace}/.continue`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function checkUserSkills() {
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    assert.ok(existsSync(resolve(continueHome, "skills", skill, "SKILL.md")), `missing user skill ${skill}`);
  }
}

function checkRepoSkills() {
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    assert.ok(existsSync(resolve(workspace, ".continue", "skills", skill, "SKILL.md")), `missing repo skill ${skill}`);
  }
}

function checkRule() {
  const rulePath = resolve(workspace, ".continue", "rules", "greplica-guidance.md");
  assert.ok(existsSync(rulePath), "greplica-guidance.md rule was not created");
  const rule = readFileSync(rulePath, "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /Greplica hook guidance/);
}

function checkHooks() {
  const hooksPath = resolve(workspace, ".continue", "settings.json");
  assert.ok(existsSync(hooksPath), "settings.json hook file was not created");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    assert.ok(commandPresent(hooks[event], command), `${event} hook missing command "${command}"`);
  }
}

function checkGuidanceOutput() {
  const hookInput = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "continue-smoke-session",
    cwd: workspace,
  });
  const result = run([process.execPath, cli, "hook", "ingest", "--platform", "continue"], workspace, hookInput);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(typeof payload.hookSpecificOutput?.additionalContext, "string");
  assert.match(payload.hookSpecificOutput.additionalContext, /Greplica hook guidance/);
  assert.equal(payload.additionalContext, undefined);
}

function checkStopSessionTracking() {
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        session_id: "continue-smoke-session",
        cwd: workspace,
        message: { role: "user", content: [{ type: "text", text: "Remember this Continue transcript fact." }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "continue-smoke-session",
        cwd: workspace,
        message: { role: "assistant", content: [{ type: "text", text: "Stored Continue transcript context." }] },
      }),
    ].join("\n"),
    "utf8",
  );

  const stopInput = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "continue-smoke-session",
    cwd: workspace,
    transcript_path: transcriptPath,
  });
  const stopResult = run([process.execPath, cli, "hook", "ingest", "--platform", "continue"], workspace, stopInput);
  assert.equal(stopResult.status, 0, stopResult.stderr);

  const markResult = run([
    process.execPath,
    cli,
    "session",
    "mark-memory-current",
    "--session-ref",
    "continue-session:continue-smoke-session",
  ], workspace);
  assert.equal(markResult.status, 0, markResult.stderr);
  assert.match(markResult.stdout, /Marked session memory current\./);
}

function checkNonDestructiveReinstall() {
  const hooksPath = resolve(workspace, ".continue", "settings.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  hooks.hooks.PreToolUse = [{ matcher: "", hooks: [{ type: "command", command: "echo user-pretool", timeout: 3 }] }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "continue",
    "--embedding",
    "local",
  ], workspace);

  const after = readFileSync(hooksPath, "utf8");
  assert.match(after, /user-pretool/, "user's unrelated PreToolUse hook was dropped on reinstall");
  const occurrences = after.split(command).length - 1;
  assert.equal(occurrences, 2, `expected greplica command exactly twice after reinstall, found ${occurrences}`);
}

function commandPresent(entries, value) {
  if (!Array.isArray(entries)) return false;
  for (const group of entries) {
    if (!group?.hooks) continue;
    if (group.hooks.some((entry) => entry?.command === value)) return true;
  }
  return false;
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
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/continue.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find repo root from ${startDir}`);
}
