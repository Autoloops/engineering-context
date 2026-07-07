#!/usr/bin/env node
// Focused smoke check for `greplica install --platform opencode`.
//
// Verifies user-level OpenCode skills + hooks under XDG config, guidance output
// shape for UserPromptSubmit, non-destructive hook reinstall, Stop hook session
// tracking, and transcript bundling from file-layout session storage.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const command = "greplica hook ingest --platform opencode";

const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-opencode-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "greplica-home");
const xdgConfigHome = resolve(tempDir, "xdg-config");
const xdgDataHome = resolve(tempDir, "xdg-data");
const sessionId = "opencode-smoke-session";
const bundleOut = resolve(tempDir, "opencode-bundle.md");

const env = {
  ...process.env,
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_DATA_HOME: xdgDataHome,
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
    "opencode",
    "--embedding",
    "local",
  ], workspace);
  assert.match(installOutput.stdout, /Installed Greplica for OpenCode\./);
  assert.match(installOutput.stdout, /Hooks: installed for UserPromptSubmit, Stop\./);

  checkSkills();
  checkHooks();
  checkGuidanceOutput();
  checkStopSessionTracking();
  checkTranscriptBundle();
  checkNonDestructiveReinstall();

  console.log(`OK: OpenCode skills + hooks installed under ${xdgConfigHome}/opencode`);
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Best-effort cleanup; Windows may keep SQLite handles open briefly.
  }
}

function checkSkills() {
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    assert.ok(existsSync(resolve(xdgConfigHome, "opencode", "skills", skill, "SKILL.md")), `missing skill ${skill}`);
  }
}

function checkHooks() {
  const hooksPath = resolve(xdgConfigHome, "opencode", "hooks.json");
  assert.ok(existsSync(hooksPath), "hooks.json was not created");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    assert.ok(commandPresent(hooks[event], command), `${event} hook missing command "${command}"`);
  }
}

function checkGuidanceOutput() {
  const hookInput = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd: workspace,
  });
  const result = run([process.execPath, cli, "hook", "ingest", "--platform", "opencode"], workspace, hookInput);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const guidance = payload.additionalContext ?? payload.hookSpecificOutput?.additionalContext;
  assert.equal(typeof guidance, "string");
  assert.match(guidance, /Greplica hook guidance/);
}

function checkStopSessionTracking() {
  seedOpenCodeSession();

  const stopInput = JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    cwd: workspace,
  });
  const stopResult = run([process.execPath, cli, "hook", "ingest", "--platform", "opencode"], workspace, stopInput);
  assert.equal(stopResult.status, 0, stopResult.stderr);

  const markResult = run([
    process.execPath,
    cli,
    "session",
    "mark-memory-current",
    "--session-ref",
    `opencode-session:${sessionId}`,
  ], workspace);
  assert.equal(markResult.status, 0, markResult.stderr);
  assert.match(markResult.stdout, /Marked session memory current\./);
}

function checkTranscriptBundle() {
  const sessionFile = resolve(xdgDataHome, "opencode", "storage", "session", `${sessionId}.json`);
  const bundleResult = run([
    process.execPath,
    cli,
    "transcript",
    "bundle",
    "--platform",
    "opencode",
    "--file",
    sessionFile,
    "--out",
    bundleOut,
  ], workspace);
  assert.equal(bundleResult.status, 0, bundleResult.stderr);

  const bundle = readFileSync(bundleOut, "utf8");
  assert.match(bundle, /session_ref: opencode-session:opencode-smoke-session/);
  assert.match(bundle, /Remember this OpenCode transcript fact/);
  assert.match(bundle, /Stored OpenCode transcript context/);
}

function checkNonDestructiveReinstall() {
  const hooksPath = resolve(xdgConfigHome, "opencode", "hooks.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  hooks.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: "echo user-custom-hook", timeout: 3 }] });
  hooks.hooks.PreToolUse = [{ matcher: "", hooks: [{ type: "command", command: "echo user-pretool", timeout: 3 }] }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "opencode",
    "--embedding",
    "local",
  ], workspace);

  const after = readFileSync(hooksPath, "utf8");
  assert.match(after, /user-custom-hook/, "user's UserPromptSubmit hook was dropped on reinstall");
  assert.match(after, /user-pretool/, "user's unrelated PreToolUse hook was dropped on reinstall");
  const occurrences = after.split(command).length - 1;
  assert.equal(occurrences, 2, `expected greplica command exactly twice after reinstall, found ${occurrences}`);
}

function seedOpenCodeSession() {
  const messageDir = resolve(xdgDataHome, "opencode", "storage", "message", sessionId);
  const sessionFile = resolve(xdgDataHome, "opencode", "storage", "session", `${sessionId}.json`);
  mkdirSync(messageDir, { recursive: true });
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({ id: sessionId, directory: workspace }),
    "utf8",
  );
  writeFileSync(
    resolve(messageDir, "msg-01.json"),
    JSON.stringify({
      role: "user",
      content: "Remember this OpenCode transcript fact.",
    }),
    "utf8",
  );
  writeFileSync(
    resolve(messageDir, "msg-02.json"),
    JSON.stringify({
      role: "assistant",
      content: "Stored OpenCode transcript context.",
    }),
    "utf8",
  );
}

function commandPresent(groups, value) {
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((handler) => handler?.command === value));
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
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/opencode.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find repo root from ${startDir}`);
}
