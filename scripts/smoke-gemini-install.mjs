#!/usr/bin/env node
// Focused smoke check for `greplica install --platform gemini`.
//
// Verifies user-level Gemini CLI skills + hooks under GEMINI_HOME, guidance output
// shape for BeforeAgent, non-destructive hook reinstall, and AfterAgent session
// tracking with a sample JSONL transcript path.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const command = "greplica hook ingest --platform gemini";
const { geminiTranscriptToMarkdown } = await import(new URL("../dist/libs/install/platforms/gemini.js", import.meta.url));

const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-gemini-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "greplica-home");
const geminiHome = resolve(tempDir, "gemini-home");
const transcriptPath = resolve(tempDir, "gemini-session.jsonl");

const env = {
  ...process.env,
  GEMINI_HOME: geminiHome,
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
    "gemini",
    "--embedding",
    "local",
  ], workspace);
  assert.match(installOutput.stdout, /Installed Greplica for Gemini CLI\./);
  assert.match(installOutput.stdout, /Hooks: installed for BeforeAgent, AfterAgent\./);

  checkSkills();
  checkHooks();
  checkGuidanceOutput();
  checkAfterAgentSessionTracking();
  checkNonDestructiveReinstall();
  checkTranscriptProjection();

  console.log(`OK: Gemini CLI skills + hooks installed under ${geminiHome}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function checkSkills() {
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    assert.ok(existsSync(resolve(geminiHome, "skills", skill, "SKILL.md")), `missing skill ${skill}`);
  }
}

function checkHooks() {
  const hooksPath = resolve(geminiHome, "settings.json");
  assert.ok(existsSync(hooksPath), "settings.json hook file was not created");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
  for (const event of ["BeforeAgent", "AfterAgent"]) {
    assert.ok(commandPresent(hooks[event], command), `${event} hook missing command "${command}"`);
  }
}

function checkGuidanceOutput() {
  const hookInput = JSON.stringify({
    hook_event_name: "BeforeAgent",
    session_id: "gemini-smoke-session",
    cwd: workspace,
    prompt: "hello",
  });
  const result = run([process.execPath, cli, "hook", "ingest", "--platform", "gemini"], workspace, hookInput);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(typeof payload.hookSpecificOutput?.additionalContext, "string");
  assert.match(payload.hookSpecificOutput.additionalContext, /Greplica hook guidance/);
  assert.equal(payload.hookSpecificOutput.hookEventName, undefined);
}

function checkAfterAgentSessionTracking() {
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "session_metadata",
        sessionId: "gemini-smoke-session",
        startTime: "2026-07-02T12:00:00.000Z",
      }),
      JSON.stringify({
        type: "user",
        id: "msg-1",
        content: [{ text: "Remember this Gemini transcript fact." }],
      }),
      JSON.stringify({
        type: "gemini",
        id: "msg-2",
        content: [{ text: "Stored Gemini transcript context." }],
      }),
    ].join("\n"),
    "utf8",
  );

  const stopInput = JSON.stringify({
    hook_event_name: "AfterAgent",
    session_id: "gemini-smoke-session",
    cwd: workspace,
    transcript_path: transcriptPath,
    prompt: "hello",
    prompt_response: "done",
  });
  const stopResult = run([process.execPath, cli, "hook", "ingest", "--platform", "gemini"], workspace, stopInput);
  assert.equal(stopResult.status, 0, stopResult.stderr);

  const markResult = run([
    process.execPath,
    cli,
    "session",
    "mark-memory-current",
    "--session-ref",
    "gemini-session:gemini-smoke-session",
  ], workspace);
  assert.equal(markResult.status, 0, markResult.stderr);
  assert.match(markResult.stdout, /Marked session memory current\./);
}

function checkNonDestructiveReinstall() {
  const hooksPath = resolve(geminiHome, "settings.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  hooks.hooks.BeforeTool = [{
    matcher: "write_file",
    hooks: [{ type: "command", command: "echo user-pretool", timeout: 3000 }],
  }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  runOrThrow([
    process.execPath,
    cli,
    "install",
    "--platform",
    "gemini",
    "--embedding",
    "local",
  ], workspace);

  const after = readFileSync(hooksPath, "utf8");
  assert.match(after, /user-pretool/, "user's unrelated BeforeTool hook was dropped on reinstall");
  const occurrences = after.split(command).length - 1;
  assert.equal(occurrences, 2, `expected greplica command exactly twice after reinstall, found ${occurrences}`);
}

function checkTranscriptProjection() {
  const markdown = geminiTranscriptToMarkdown(
    [
      JSON.stringify({ type: "session_metadata", sessionId: "abc" }),
      JSON.stringify({ type: "user", content: [{ text: "hello gemini" }] }),
      JSON.stringify({ type: "gemini", content: [{ text: "hi there" }] }),
    ].join("\n"),
  );
  assert.match(markdown, /hello gemini/);
  assert.match(markdown, /hi there/);
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
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/gemini.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find repo root from ${startDir}`);
}
