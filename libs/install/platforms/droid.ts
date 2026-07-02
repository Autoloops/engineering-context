import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import { claudeTranscriptToMarkdown } from "./claude.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

function factoryHome(): string {
  return process.env.FACTORY_HOME ?? join(homedir(), ".factory");
}

export const droidInstaller: PlatformInstaller = {
  platform: "factory-droid",
  // Factory Droid loads skills and hooks from the user home dir, not the repo.
  install(context: PlatformInstallContext): PlatformInstallResult {
    const home = factoryHome();
    const skills = copyBundledSkills(join(home, "skills"));
    if (!context.hooks) return { skills };

    const hookConfigPath = join(home, "hooks.json");
    const command = hookCommand("factory-droid");
    const hookConfig = mergeHookConfig(readJsonObject(hookConfigPath), "factory-droid", command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills,
      hooks: {
        platform: "factory-droid",
        configFiles: [hookConfigPath],
        events: [...hookEvents],
        command,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `factory-droid-session:${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith("factory-droid-session:") ? ref.slice("factory-droid-session:".length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    // Factory Droid writes Claude-style JSONL session transcripts, so the
    // Claude projection applies unchanged.
    return claudeTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runDroidExec(input);
  },
};

function runDroidExec(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    const args = [
      "exec",
      "--output-format",
      "json",
      "--skip-permissions-unsafe",
      "--cwd",
      input.cwd,
    ];

    const child = spawn(
      "droid",
      args,
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );

    child.once("error", (error) => {
      transcript.end();
      reject(error);
    });
    child.stdout.pipe(transcript);
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      transcript.end();
      writeFileSync(
        input.finalMessagePath,
        `Factory Droid update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve();
    });
  });
}
