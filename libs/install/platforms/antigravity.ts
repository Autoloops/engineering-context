import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

// Antigravity CLI (the `agy` binary) reads global skills from
// ~/.gemini/antigravity-cli/skills/ -- it shares the ~/.gemini namespace
// with Gemini CLI, which it's built on top of. ANTIGRAVITY_HOME is not a
// documented Antigravity setting; Greplica checks it purely so installs can
// be redirected in tests, matching the override convention already used by
// the other platform installers (FACTORY_HOME, COPILOT_HOME, etc).
function antigravityHome(): string {
  return process.env.ANTIGRAVITY_HOME ?? join(homedir(), ".gemini", "antigravity-cli");
}

// Confirmed from a Google Cloud Community deep-dive with tested working
// examples (not just prose docs): Antigravity CLI hooks live in a
// project-local .agents/hooks.json, namespaced per tool at the top level
// (so multiple tools -- cmux, claude-mem, greplica -- can share one file
// without clobbering each other), e.g.:
//
//   { "greplica": { "Stop": [{ "hooks": [{ "type": "command", "command": "<abs path>", "timeout": 30 }] }] } }
//
// Two things this differs from the shared mergeHookConfig()/hooks.json shape
// every other installer uses:
//   1. No single top-level "hooks" key -- each tool's entries live under its
//      own name at the root instead.
//   2. "command" must be an absolute path to a directly-executable script
//      file, not a shell command string with arguments -- so we generate a
//      small wrapper script here rather than writing an inline command.
//
// Scope of this first pass: only the Stop event. It's the one event that's
// consistent across every source found (official docs, real production
// integrations, live bug reports) with zero contradictions, and it's
// confirmed to have no veto power (unlike PreToolUse-style gating events,
// where a failing hook can block a tool call or, per one source, an entire
// session). SessionStart is deliberately left out: some real hooks.json
// dumps show it, but Google's own documented event list doesn't include it,
// and that contradiction isn't worth resolving for what Greplica needs --
// Stop alone is enough to trigger the background working-memory update.
const antigravityHookNamespace = "greplica";

export const antigravityInstaller: PlatformInstaller = {
  platform: "antigravity",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const skills = copyBundledSkills(join(antigravityHome(), "skills"));
    if (!context.hooks) return { skills };

    // process.argv[1] is the currently-running greplica entrypoint -- the
    // same self-reference install.ts already uses to relaunch itself for
    // the embedding prewarm. Without it we can't build an absolute command,
    // so hooks are skipped rather than writing something broken.
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) return { skills };

    const wrapperPath = writeStopHookScript(context.repoRoot, process.execPath, scriptPath);
    const command = `${process.execPath} ${scriptPath} hook ingest --platform antigravity`;

    const hookConfigPath = join(context.repoRoot, ".agents", "hooks.json");
    const config = readJsonObject(hookConfigPath);
    config[antigravityHookNamespace] = {
      Stop: [
        {
          hooks: [{ type: "command", command: wrapperPath, timeout: 30 }],
        },
      ],
    };
    writeJson(hookConfigPath, config);

    return {
      skills,
      hooks: {
        platform: "antigravity",
        configFiles: [hookConfigPath, wrapperPath],
        events: ["Stop"],
        command,
      },
    };
  },
  sessionSourceRef(_sessionId: string): string {
    throw new Error("Antigravity session source refs are not supported yet.");
  },
  sessionIdFromSourceRef(_ref: string): string | undefined {
    return undefined;
  },
  transcriptToMarkdown(_transcript: string): string {
    throw new Error("Antigravity transcript projection is not supported yet.");
  },
  async runWorkingMemoryUpdate(_input: WorkingMemoryUpdateInput): Promise<void> {
    throw new Error("Antigravity background working-memory updates are not supported yet.");
  },
};

// Antigravity spawns the "command" path directly rather than interpreting a
// shell string, so the greplica CLI invocation (which needs a node
// executable + script path + args) has to live inside a small wrapper
// script instead of being written inline. The wrapper always exits 0
// regardless of what the inner command does: Stop hooks aren't
// veto-capable in Antigravity as far as every source agrees, but there's no
// reason to risk it -- a real, documented cmux bug shows exactly what
// happens when a hook that was never supposed to gate anything propagates
// a non-zero exit code into Antigravity's hook runner.
function writeStopHookScript(repoRoot: string, execPath: string, scriptPath: string): string {
  const hooksDir = join(repoRoot, ".agents", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const isWindows = process.platform === "win32";
  const wrapperPath = join(hooksDir, isWindows ? "greplica-stop.cmd" : "greplica-stop.sh");

  const content = isWindows
    ? [
        "@echo off",
        "rem Greplica Stop hook for Antigravity CLI. Always exits 0 -- Stop has no",
        "rem veto power in Antigravity, and a failing side-effect must never surface",
        "rem as a hook error to the user.",
        `"${execPath}" "${scriptPath}" hook ingest --platform antigravity >nul 2>&1`,
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env bash",
        "# Greplica Stop hook for Antigravity CLI. Always exits 0 -- Stop has no",
        "# veto power in Antigravity, and a failing side-effect must never surface",
        "# as a hook error to the user.",
        `"${execPath}" "${scriptPath}" hook ingest --platform antigravity >/dev/null 2>&1`,
        "exit 0",
        "",
      ].join("\n");

  writeFileSync(wrapperPath, content, "utf8");
  if (!isWindows) chmodSync(wrapperPath, 0o755);

  return wrapperPath;
}
