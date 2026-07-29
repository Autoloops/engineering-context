import { createWriteStream, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { collectAgentMetrics } from "./metrics.js";
import type { AgentRunInput, AgentRunResult } from "./types.js";

export async function runOpenCodeAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
  const result = await runOpenCodeProcess(input, transcript);
  transcript.end();

  const elapsedMs = Date.now() - startedAt;
  const metrics = collectAgentMetrics({
    transcriptPath: input.transcriptPath,
  });

  return {
    agent: "opencode",
    model: input.model ?? "default",
    elapsed_ms: elapsedMs,
    transcript_path: input.transcriptPath,
    final_message_path: input.finalMessagePath,
    exit_code: result.exitCode,
    signal: result.signal,
    ...metrics,
  };
}

export function runOpenCodeProcess(
  input: AgentRunInput,
  transcript: NodeJS.WritableStream,
  spawnImpl: typeof spawn = spawn,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    // The opencode CLI has no stdin/file option for its prompt argument -- only
    // a literal `-p <text>` value -- and process arguments are visible to other
    // local users via `ps`/`/proc/<pid>/cmdline` for as long as the process runs.
    // input.prompt embeds the full session transcript (which may contain secrets
    // or other sensitive content), so it must never be passed directly as argv.
    // Instead, write it to a file inside the caller's private run directory
    // (created via mkdtempSync, mode 0700 per POSIX) and pass only a short,
    // non-sensitive reference on the command line; the agent reads the real
    // instructions itself via its own file tool.
    const promptPath = join(dirname(input.transcriptPath), "opencode-task-prompt.md");
    writeFileSync(promptPath, input.prompt, "utf8");
    const wrapperPrompt = `Your full task instructions are in the file at ${promptPath}. Read that file now and follow its instructions exactly.`;

    const args = ["-p", wrapperPrompt, "-f", "json", "-q"];

    const child = spawnImpl("opencode", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      transcript.once("close", () => reject(error));
      transcript.end();
    });
    child.stdout.pipe(transcript);
    child.once("close", (exitCode, signal) => {
      if (spawnError !== undefined) return;
      writeFileSync(
        input.finalMessagePath,
        `OpenCode update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve({ exitCode, signal });
    });
  });
}