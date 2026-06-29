import { createWriteStream, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { collectAgentMetrics } from "./metrics.js";
import type { AgentRunInput, AgentRunResult } from "./types.js";

export async function runOpenHandsAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
  const result = await runOpenHandsProcess(input, transcript);
  transcript.end();

  const elapsedMs = Date.now() - startedAt;
  const metrics = collectAgentMetrics({
    transcriptPath: input.transcriptPath,
  });

  return {
    agent: "openhands",
    model: input.model ?? "default",
    elapsed_ms: elapsedMs,
    transcript_path: input.transcriptPath,
    final_message_path: input.finalMessagePath,
    exit_code: result.exitCode,
    signal: result.signal,
    ...metrics,
  };
}

function runOpenHandsProcess(
  input: AgentRunInput,
  transcript: NodeJS.WritableStream,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    // Headless mode reads the task from a file and streams JSONL events to stdout.
    const taskFile = join(dirname(input.transcriptPath), "openhands-task.md");
    writeFileSync(taskFile, input.prompt, "utf8");

    const args = ["--headless", "--json", "-f", taskFile];

    const child = spawn(
      "openhands",
      args,
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    child.once("error", reject);
    child.stdout.pipe(transcript);
    child.once("close", (exitCode, signal) => {
      writeFileSync(
        input.finalMessagePath,
        `OpenHands update runner exited with code ${exitCode ?? "null"} and signal ${signal ?? "null"}.\n`,
        "utf8",
      );
      resolve({ exitCode, signal });
    });
  });
}
