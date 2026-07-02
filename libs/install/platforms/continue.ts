import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { greplicaHookGuidance } from "../../hooks/guidance.js";
import { hookCommand, hookEvents, mergeHookConfig, readJsonObject, writeJson } from "../hook-config.js";
import { copyBundledSkills } from "../skills.js";
import { claudeTranscriptToMarkdown } from "./claude.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

const sessionRefPrefix = "continue-session:";
const greplicaRuleFileName = "greplica-guidance.md";

export const continueInstaller: PlatformInstaller = {
  platform: "continue",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const { repoRoot } = context;
    const userSkills = copyBundledSkills(join(continueHome(), "skills"));
    const repoSkills = copyBundledSkills(join(repoRoot, ".continue", "skills"));
    writeGreplicaRule(repoRoot);

    if (!context.hooks) {
      return { skills: [...userSkills, ...repoSkills] };
    }

    const hookConfigPath = join(repoRoot, ".continue", "settings.json");
    const command = hookCommand("continue");
    const hookConfig = mergeHookConfig(readJsonObject(hookConfigPath), "continue", command);
    writeJson(hookConfigPath, hookConfig);

    return {
      skills: [...userSkills, ...repoSkills],
      hooks: {
        platform: "continue",
        configFiles: [hookConfigPath],
        events: [...hookEvents],
        command,
      },
    };
  },
  sessionSourceRef(sessionId: string): string {
    return `${sessionRefPrefix}${sessionId}`;
  },
  sessionIdFromSourceRef(ref: string): string | undefined {
    return ref.startsWith(sessionRefPrefix) ? ref.slice(sessionRefPrefix.length) : undefined;
  },
  transcriptToMarkdown(transcript: string): string {
    return claudeTranscriptToMarkdown(transcript);
  },
  async runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void> {
    await runContinueHeadless(input);
  },
};

function continueHome(): string {
  return process.env.CONTINUE_HOME ?? join(homedir(), ".continue");
}

function writeGreplicaRule(repoRoot: string): void {
  const rulesDir = join(repoRoot, ".continue", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(rulesDir, greplicaRuleFileName),
    `---
name: Greplica guidance
alwaysApply: true
description: Query Greplica repo memory before broad exploration
---

${greplicaHookGuidance}
`,
    "utf8",
  );
}

function runContinueHeadless(input: WorkingMemoryUpdateInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    const args = [
      "-p",
      "--silent",
      "--allow",
      "Write",
      "--allow",
      "Edit",
      "--allow",
      "Bash",
    ];

    const child = spawn("cn", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const stdoutChunks: Buffer[] = [];
    child.once("error", (error) => {
      transcript.end();
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      transcript.end();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      writeFileSync(input.finalMessagePath, stdout, "utf8");
      writeFileSync(
        input.transcriptPath,
        `${JSON.stringify({
          type: "continue_run",
          timestamp: new Date().toISOString(),
          exit_code: exitCode,
          signal,
          output: stdout.trim(),
        })}\n`,
        "utf8",
      );
      resolve();
    });
  });
}
