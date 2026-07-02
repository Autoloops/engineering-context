import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const cli = new URL("dist/apps/cli/main.js", root);
const { greplicaHookGuidance } = await import(new URL("dist/libs/hooks/guidance.js", root));
const { shouldRunAutoMemoryUpdates } = await import(new URL("dist/libs/hooks/worker.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-install-options-test-"));

const autoSave = installInTempRepo("auto-save", ["--hooks", "enabled", "--auto-memory", "enabled"]);
assert.match(autoSave.output, /Hooks: installed for UserPromptSubmit, Stop\./);
assert.match(autoSave.output, /Automatic memory updates: enabled\./);
assert.ok(existsSync(join(autoSave.codexHome, "hooks.json")));
assert.equal(readConfig(autoSave.greplicaHome).session.autoMemoryUpdates, true);
assert.equal(shouldRunAutoMemoryUpdates(readConfig(autoSave.greplicaHome)), true);

const guidanceOnly = installInTempRepo("guidance-only", ["--hooks", "enabled", "--auto-memory", "disabled"]);
assert.match(guidanceOnly.output, /Hooks: installed for UserPromptSubmit, Stop\./);
assert.match(guidanceOnly.output, /Automatic memory updates: disabled\./);
assert.ok(existsSync(join(guidanceOnly.codexHome, "hooks.json")));
assert.equal(readConfig(guidanceOnly.greplicaHome).session.autoMemoryUpdates, false);
assert.equal(shouldRunAutoMemoryUpdates(readConfig(guidanceOnly.greplicaHome)), false);

const hookOutput = execFileSync(
  process.execPath,
  [cli.pathname, "hook", "ingest", "--platform", "codex"],
  {
    cwd: guidanceOnly.repo,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "guidance-only-session",
      cwd: guidanceOnly.repo,
    }),
    env: guidanceOnly.env,
  },
);
assert.match(hookOutput, /Greplica hook guidance/);
assert.match(hookOutput, /greplica graph context/);

const noHooks = installInTempRepo("no-hooks", ["--hooks", "disabled"]);
assert.match(noHooks.output, /Hooks: not installed\./);
assert.match(noHooks.output, /Automatic memory updates: disabled\./);
assert.match(noHooks.output, /To give future agents Greplica guidance without hooks/);
assert.ok(noHooks.output.includes(greplicaHookGuidance));
assert.equal(existsSync(join(noHooks.codexHome, "hooks.json")), false);
assert.equal(readConfig(noHooks.greplicaHome).session.autoMemoryUpdates, false);

const unsupportedHooks = installInTempRepo("unsupported-hooks", ["--hooks", "enabled", "--auto-memory", "enabled"], "opencode");
assert.match(unsupportedHooks.output, /Hooks: not installed for this platform\./);
assert.match(unsupportedHooks.output, /Automatic memory updates: disabled\./);
assert.equal(readConfig(unsupportedHooks.greplicaHome).session.autoMemoryUpdates, false);

const copilotHooks = installInTempRepo("copilot-hooks", ["--hooks", "enabled", "--auto-memory", "enabled"], "copilot");
assert.match(copilotHooks.output, /Installed Greplica for GitHub Copilot CLI\./);
assert.match(copilotHooks.output, /Hooks: installed for SessionStart, Stop\./);
assert.match(copilotHooks.output, /Automatic memory updates: enabled\./);
assert.ok(existsSync(join(copilotHooks.copilotHome, "hooks", "greplica.json")));
assert.equal(readConfig(copilotHooks.greplicaHome).session.autoMemoryUpdates, true);

const cursorHooks = installInTempRepo("cursor-hooks", ["--hooks", "enabled", "--auto-memory", "disabled"], "cursor");
assert.match(cursorHooks.output, /Installed Greplica for Cursor\./);
assert.match(cursorHooks.output, /Cursor rules: installed to \.cursor\/rules\/greplica\.mdc\./);
assert.match(cursorHooks.output, /Automatic memory updates: disabled\./);
assert.ok(existsSync(join(cursorHooks.cursorHome, "skills", "greplica-bootstrap", "SKILL.md")));
assert.ok(existsSync(join(cursorHooks.repo, ".cursor", "rules", "greplica.mdc")));

// Test non-destructive behavior for Cursor rules
const customRepo = join(tmp, "cursor-non-destructive", "repo");
const customGreplicaHome = join(tmp, "cursor-non-destructive", "greplica-home");
const customCursorHome = join(tmp, "cursor-non-destructive", "cursor-home");
mkdirSync(join(customRepo, ".cursor", "rules"), { recursive: true });
const existingRuleContent = "My custom rule content\n";
const ruleFilePath = join(customRepo, ".cursor", "rules", "greplica.mdc");
writeFileSync(ruleFilePath, existingRuleContent, "utf8");

const customEnv = {
  ...process.env,
  GREPLICA_HOME: customGreplicaHome,
  CURSOR_HOME: customCursorHome,
  GREPLICA_INSTALL_SKIP_PREWARM: "1",
};

execFileSync("git", ["init", "--quiet"], { cwd: customRepo, encoding: "utf8" });
execFileSync(
  process.execPath,
  [cli.pathname, "install", "--platform", "cursor", "--embedding", "local"],
  {
    cwd: customRepo,
    encoding: "utf8",
    env: customEnv,
  },
);

const updatedRuleContent = readFileSync(ruleFilePath, "utf8");
assert.ok(updatedRuleContent.includes("My custom rule content"));
assert.ok(updatedRuleContent.includes("Greplica provides local, searchable repository memory"));

const invalid = spawnSync(
  process.execPath,
  [
    cli.pathname,
    "install",
    "--platform",
    "codex",
    "--embedding",
    "local",
    "--hooks",
    "disabled",
    "--auto-memory",
    "enabled",
  ],
  {
    cwd: noHooks.repo,
    encoding: "utf8",
    env: noHooks.env,
  },
);
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /--auto-memory enabled requires --hooks enabled/);

const invalidValue = spawnSync(
  process.execPath,
  [cli.pathname, "install", "--platform", "codex", "--embedding", "local", "--hooks", "sometimes"],
  {
    cwd: noHooks.repo,
    encoding: "utf8",
    env: noHooks.env,
  },
);
assert.notEqual(invalidValue.status, 0);
assert.match(invalidValue.stderr, /expected enabled or disabled/);

console.log("Install option checks passed.");

function installInTempRepo(name, flags, platform = "codex") {
  const repo = join(tmp, name, "repo");
  const greplicaHome = join(tmp, name, "greplica-home");
  const codexHome = join(tmp, name, "codex-home");
  const copilotHome = join(tmp, name, "copilot-home");
  const cursorHome = join(tmp, name, "cursor-home");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8" });

  const env = {
    ...process.env,
    GREPLICA_HOME: greplicaHome,
    CODEX_HOME: codexHome,
    COPILOT_HOME: copilotHome,
    CURSOR_HOME: cursorHome,
    XDG_CONFIG_HOME: join(tmp, name, "xdg-config-home"),
    GREPLICA_INSTALL_SKIP_PREWARM: "1",
  };
  const output = execFileSync(
    process.execPath,
    [cli.pathname, "install", "--platform", platform, "--embedding", "local", ...flags],
    {
      cwd: repo,
      encoding: "utf8",
      env,
    },
  );
  execFileSync(process.execPath, [cli.pathname, "doctor"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  return { repo, greplicaHome, codexHome, copilotHome, cursorHome, output, env };
}

function readConfig(greplicaHome) {
  return JSON.parse(readFileSync(join(greplicaHome, "config.json"), "utf8"));
}
