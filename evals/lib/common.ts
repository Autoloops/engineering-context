import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export interface CommandResult {
  command: string[];
  exit_code: number | null;
  signal: string | null;
  stdout?: string;
  stderr?: string;
}

export interface RunOptions {
  stdio?: "pipe" | "inherit";
}

export function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, options: RunOptions = {}): CommandResult {
  const stdio = options.stdio ?? "pipe";
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    maxBuffer: 100 * 1024 * 1024,
    stdio,
  });

  return {
    command,
    exit_code: result.status,
    signal: result.signal,
    stdout: stdio === "pipe" ? result.stdout?.toString() : undefined,
    stderr: stdio === "pipe" ? result.stderr?.toString() : undefined,
  };
}

export function runOrThrow(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: RunOptions = { stdio: "inherit" },
): void {
  const result = run(command, cwd, env, options);
  if (result.exit_code !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git command failed: git ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

export function gitOptional(cwd: string, args: string[]): string | undefined {
  try {
    const output = git(cwd, args);
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

export function repoTree(cwd: string): string[] {
  const output = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (output.status !== 0) throw new Error("Failed to read target repo tree.");
  return output.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function findRepoRoot(importMetaUrl: string): string {
  const dir = dirname(fileURLToPath(importMetaUrl));
  const distIndex = dir.indexOf(`${process.platform === "win32" ? "\\" : "/"}dist${process.platform === "win32" ? "\\" : "/"}`);
  if (distIndex !== -1) return dir.slice(0, distIndex);

  return resolve(dir, "../..");
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
