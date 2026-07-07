import { createWriteStream, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

function runOpenCodeProcess(
  input: AgentRunInput,
  transcript: NodeJS.WritableStream,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", input.prompt, "-f", "json", "-q"];

    const child = spawn("opencode", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    child.once("error", reject);
    child.stdout.pipe(transcript);
    child.once("close", (exitCode, signal) => {
      writeFileSync(
        input.finalMessagePath,
        `OpenCode update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve({ exitCode, signal });
    });
  });
}
