#!/usr/bin/env node
// Focused smoke check for `greplica install --platform openhands`.
// Verifies OpenHands-compatible guidance (skills + hooks) is generated in the
// expected repo-local locations, that the UserPromptSubmit hook emits
// OpenHands-native guidance, and that re-install is non-destructive.
//
// Hermetic: GREPLICA_HOME points at a temp dir so it never touches ~/.greplica.
// Usage: node scripts/smoke-openhands-install.mjs [--keep-temp] [--result-json <path>]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const command = "greplica hook ingest --platform openhands";

const args = parseArgs(process.argv.slice(2));
const ownsTempDir = args.keepTemp !== true;
const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-openhands-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "home");

const env = { ...process.env, GREPLICA_HOME: greplicaHome };
delete env.GREPLICA_HOOK_DISABLE;

let checks = [];
try {
  if (!existsSync(cli)) throw new Error(`Built CLI not found at ${cli}. Run "npm run build" first.`);

  runOrThrow(["git", "init", "-q", workspace], repoRoot);
  runOrThrow(["node", cli, "install", "--platform", "openhands", "--embedding", "local"], workspace);

  checks.push(checkHooks());
  checks.push(checkSkills());
  checks.push(checkGuidanceOutput());
  checks.push(checkNonDestructiveReinstall());
} catch (error) {
  checks = [{ id: "smoke_script", passed: false, details: [error instanceof Error ? error.stack ?? error.message : String(error)] }];
} finally {
  const passed = checks.filter((check) => check.passed).length;
  const result = { success: passed === checks.length, passed_checks: passed, total_checks: checks.length, workspace, checks };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.resultJson !== undefined) writeFileSync(args.resultJson, serialized);
  process.stdout.write(serialized);
  if (ownsTempDir) rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = result.success ? 0 : 1;
}

function checkHooks() {
  const details = [];
  const hooksPath = resolve(workspace, ".openhands/hooks.json");
  if (!existsSync(hooksPath)) {
    details.push(".openhands/hooks.json was not created");
    return { id: "hooks_installed", passed: false, details };
  }
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    if (!commandPresent(hooks[event], command)) details.push(`${event} hook missing command "${command}"`);
  }
  return { id: "hooks_installed", passed: details.length === 0, details };
}

function checkSkills() {
  const details = [];
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory"]) {
    const skillPath = resolve(workspace, ".agents/skills", skill, "SKILL.md");
    if (!existsSync(skillPath)) details.push(`missing skill ${skillPath}`);
  }
  return { id: "skills_installed", passed: details.length === 0, details };
}

function checkGuidanceOutput() {
  const details = [];
  const hookInput = JSON.stringify({ event_type: "UserPromptSubmit", working_dir: workspace, session_id: "smoke-session" });
  const result = run(["node", cli, "hook", "ingest", "--platform", "openhands"], workspace, hookInput);
  let payload;
  try {
    payload = JSON.parse((result.stdout ?? "").trim());
  } catch {
    details.push(`hook ingest did not emit JSON. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
    return { id: "guidance_output", passed: false, details };
  }
  if (typeof payload.additionalContext !== "string" || payload.additionalContext.length === 0) {
    details.push(`expected top-level string "additionalContext", got ${JSON.stringify(payload)}`);
  }
  if (payload.hookSpecificOutput !== undefined) {
    details.push("emitted Claude-style hookSpecificOutput instead of OpenHands-native additionalContext");
  }
  return { id: "guidance_output", passed: details.length === 0, details };
}

function checkNonDestructiveReinstall() {
  const details = [];
  const hooksPath = resolve(workspace, ".openhands/hooks.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  hooks.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: "echo user-custom-hook" }] });
  hooks.hooks.PreToolUse = [{ matcher: "", hooks: [{ type: "command", command: "echo user-pretool" }] }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  runOrThrow(["node", cli, "install", "--platform", "openhands", "--embedding", "local"], workspace);

  const after = readFileSync(hooksPath, "utf8");
  if (!after.includes("user-custom-hook")) details.push("user's UserPromptSubmit hook was dropped on re-install");
  if (!after.includes("user-pretool")) details.push("user's unrelated PreToolUse event was dropped on re-install");
  const occurrences = after.split(command).length - 1;
  if (occurrences !== 2) details.push(`expected greplica command exactly twice (UserPromptSubmit + Stop) after re-install, found ${occurrences}`);
  return { id: "non_destructive_reinstall", passed: details.length === 0, details };
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
}

function findRepoRoot(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/openhands.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find repo root from ${startDir}`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--result-json") parsed.resultJson = values[(index += 1)];
    else if (value === "--keep-temp") parsed.keepTemp = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}
