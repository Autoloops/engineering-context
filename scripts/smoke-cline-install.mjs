#!/usr/bin/env node
// Focused smoke check for `greplica install --platform cline`.
// Verifies Cline-compatible guidance (skills + .clinerules/greplica.md) is
// generated in the expected repo-local locations and that re-install is
// non-destructive.
//
// Hermetic: GREPLICA_HOME points at a temp dir so it never touches ~/.greplica.
// Usage: node scripts/smoke-cline-install.mjs [--keep-temp] [--result-json <path>]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cli = resolve(repoRoot, "dist/apps/cli/main.js");
const guidanceMarker = "Greplica hook guidance";

const args = parseArgs(process.argv.slice(2));
const ownsTempDir = args.keepTemp !== true;
const tempDir = mkdtempSync(resolve(tmpdir(), "greplica-cline-smoke-"));
const workspace = resolve(tempDir, "repo");
const greplicaHome = resolve(tempDir, "home");

const env = { ...process.env, GREPLICA_HOME: greplicaHome };
delete env.GREPLICA_HOOK_DISABLE;

let checks = [];
try {
  if (!existsSync(cli)) throw new Error(`Built CLI not found at ${cli}. Run "npm run build" first.`);

  runOrThrow(["git", "init", "-q", workspace], repoRoot);
  runOrThrow(["node", cli, "install", "--platform", "cline", "--embedding", "local"], workspace);

  checks.push(checkSkills());
  checks.push(checkGuidanceFile());
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

function checkSkills() {
  const details = [];
  for (const skill of ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"]) {
    const skillPath = resolve(workspace, ".clinerules/greplica-skills", skill, "SKILL.md");
    if (!existsSync(skillPath)) details.push(`missing skill ${skillPath}`);
  }
  return { id: "skills_installed", passed: details.length === 0, details };
}

function checkGuidanceFile() {
  const details = [];
  const guidancePath = resolve(workspace, ".clinerules/greplica.md");
  if (!existsSync(guidancePath)) {
    details.push(".clinerules/greplica.md was not created");
    return { id: "guidance_file", passed: false, details };
  }
  const content = readFileSync(guidancePath, "utf8");
  if (!content.includes(guidanceMarker)) details.push(`greplica.md missing "${guidanceMarker}"`);
  if (!content.includes("greplica graph context")) details.push("greplica.md missing graph context guidance");
  return { id: "guidance_file", passed: details.length === 0, details };
}

function checkNonDestructiveReinstall() {
  const details = [];
  const clinerulesDir = resolve(workspace, ".clinerules");
  const guidancePath = resolve(clinerulesDir, "greplica.md");
  const customRulePath = resolve(clinerulesDir, "custom-rule.md");

  writeFileSync(customRulePath, "# User custom Cline rule\nKeep this file.\n");
  const before = readFileSync(guidancePath, "utf8");
  writeFileSync(guidancePath, `${before}\n# Extra user notes above guidance\n`);

  runOrThrow(["node", cli, "install", "--platform", "cline", "--embedding", "local"], workspace);

  if (!existsSync(customRulePath)) details.push("user's custom-rule.md was removed on re-install");
  if (!readFileSync(customRulePath, "utf8").includes("Keep this file")) {
    details.push("user's custom-rule.md content was changed on re-install");
  }

  const after = readFileSync(guidancePath, "utf8");
  if (!after.includes("Extra user notes above guidance")) {
    details.push("user content in greplica.md was clobbered on re-install");
  }
  const occurrences = after.split(guidanceMarker).length - 1;
  if (occurrences !== 1) details.push(`expected guidance marker exactly once after re-install, found ${occurrences}`);

  return { id: "non_destructive_reinstall", passed: details.length === 0, details };
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
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "libs/install/platforms/cline.ts"))) return current;
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
