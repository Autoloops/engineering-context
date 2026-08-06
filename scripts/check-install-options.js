import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const { installCommandSuggestion, installPlatformUsage } = await import(new URL("dist/libs/install/paths.js", root));
const { greplicaHookGuidance } = await import(new URL("dist/libs/hooks/guidance.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-install-options-test-"));

const autoSave = installInTempRepo("auto-save", ["--hooks", "enabled", "--auto-memory", "enabled"]);
assert.match(autoSave.output, /Hooks: installed for UserPromptSubmit, Stop\./);
assert.match(autoSave.output, /Automatic memory updates: enabled\./);
assert.ok(existsSync(join(autoSave.codexHome, "hooks.json")));
assert.equal(readRepoInstall(autoSave.greplicaHome).auto_memory_updates, 1);

const guidanceOnly = installInTempRepo("guidance-only", ["--hooks", "enabled", "--auto-memory", "disabled"]);
assert.match(guidanceOnly.output, /Hooks: installed for UserPromptSubmit, Stop\./);
assert.match(guidanceOnly.output, /Automatic memory updates: disabled\./);
assert.ok(existsSync(join(guidanceOnly.codexHome, "hooks.json")));
assert.equal(readRepoInstall(guidanceOnly.greplicaHome).auto_memory_updates, 0);

const hookOutput = execFileSync(
  process.execPath,
  [cliPath, "hook", "ingest", "--platform", "codex"],
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
assert.equal(readRepoInstall(noHooks.greplicaHome).auto_memory_updates, 0);

const opencodeHooks = installInTempRepo("opencode-hooks", ["--hooks", "enabled", "--auto-memory", "enabled"], "opencode");
assert.match(opencodeHooks.output, /Installed Greplica for OpenCode\./);
assert.match(opencodeHooks.output, /Hooks: installed for UserPromptSubmit, Stop\./);
assert.match(opencodeHooks.output, /Automatic memory updates: enabled\./);
assert.ok(existsSync(join(opencodeHooks.xdgConfigHome, "opencode", "hooks.json")));
assert.equal(readRepoInstall(opencodeHooks.greplicaHome).auto_memory_updates, 1);

const copilotHooks = installInTempRepo("copilot-hooks", ["--hooks", "enabled", "--auto-memory", "enabled"], "copilot");
assert.match(copilotHooks.output, /Installed Greplica for GitHub Copilot CLI\./);
assert.match(copilotHooks.output, /Hooks: installed for SessionStart, Stop\./);
assert.match(copilotHooks.output, /Automatic memory updates: enabled\./);
assert.ok(existsSync(join(copilotHooks.copilotHome, "hooks", "greplica.json")));
assert.equal(readRepoInstall(copilotHooks.greplicaHome).auto_memory_updates, 1);

const cursorHooks = installInTempRepo("cursor-hooks", ["--hooks", "enabled", "--auto-memory", "enabled"], "cursor");
assert.match(cursorHooks.output, /Installed Greplica for Cursor\./);
assert.match(cursorHooks.output, /Hooks: installed for beforeSubmitPrompt, stop\./);
assert.match(cursorHooks.output, /Project rules: .*\.cursor\/rules\/greplica\.mdc/);
assert.match(cursorHooks.output, /Automatic memory updates: enabled\./);
assert.doesNotMatch(cursorHooks.output, /automatic memory updates are not supported yet/);
assert.ok(existsSync(join(cursorHooks.cursorHome, "hooks.json")));
assert.ok(existsSync(join(cursorHooks.repo, ".cursor", "rules", "greplica.mdc")));
assert.equal(readRepoInstall(cursorHooks.greplicaHome).auto_memory_updates, 1);

const invalid = spawnSync(
  process.execPath,
  [
    cliPath,
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
  [cliPath, "install", "--platform", "codex", "--embedding", "local", "--hooks", "sometimes"],
  {
    cwd: noHooks.repo,
    encoding: "utf8",
    env: noHooks.env,
  },
);
assert.notEqual(invalidValue.status, 0);
assert.match(invalidValue.stderr, /expected enabled or disabled/);

const notInstalledRepo = join(tmp, "not-installed", "repo");
const notInstalledHome = join(tmp, "not-installed", "greplica-home");
mkdirSync(notInstalledRepo, { recursive: true });
execFileSync("git", ["init", "--quiet"], { cwd: notInstalledRepo, encoding: "utf8" });
const notInstalled = spawnSync(process.execPath, [cliPath, "graph", "read"], {
  cwd: notInstalledRepo,
  encoding: "utf8",
  env: {
    ...process.env,
    GREPLICA_HOME: notInstalledHome,
  },
});
assert.notEqual(notInstalled.status, 0);
assert.match(notInstalled.stderr, /Greplica is not installed for this repo/);
assert.ok(notInstalled.stderr.includes(installCommandSuggestion), "not installed error should use shared install guidance");
assert.ok(notInstalled.stderr.includes(installPlatformUsage), "not installed error should include every install platform");
assert.match(notInstalled.stderr, /openhands/);
assert.match(notInstalled.stderr, /factory-droid/);
assert.match(notInstalled.stderr, /antigravity/);

console.log("Install option checks passed.");

function installInTempRepo(name, flags, platform = "codex") {
  const repo = join(tmp, name, "repo");
  const greplicaHome = join(tmp, name, "greplica-home");
  const codexHome = join(tmp, name, "codex-home");
  const copilotHome = join(tmp, name, "copilot-home");
  const cursorHome = join(tmp, name, "cursor-home");
  const xdgConfigHome = join(tmp, name, "xdg-config-home");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8" });

  const env = {
    ...process.env,
    GREPLICA_HOME: greplicaHome,
    CODEX_HOME: codexHome,
    COPILOT_HOME: copilotHome,
    CURSOR_HOME: cursorHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    GREPLICA_INSTALL_SKIP_PREWARM: "1",
  };
  const output = execFileSync(
    process.execPath,
    [cliPath, "install", "--platform", platform, "--embedding", "local", ...flags],
    {
      cwd: repo,
      encoding: "utf8",
      env,
    },
  );
  execFileSync(process.execPath, [cliPath, "doctor"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  return { repo, greplicaHome, codexHome, copilotHome, cursorHome, xdgConfigHome, output, env };
}

function readConfig(greplicaHome) {
  return JSON.parse(readFileSync(join(greplicaHome, "config.json"), "utf8"));
}

function readRepoInstall(greplicaHome) {
  const db = new Database(join(greplicaHome, "graph.db"), { readonly: true });
  try {
    return db.prepare("SELECT * FROM repos").get();
  } finally {
    db.close();
  }
}
