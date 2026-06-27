import { createWriteStream, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AgentRunInput, AgentRunResult } from "./types.js";

// Runs Claude Code in headless print mode (`claude -p`), streaming newline-delimited
// JSON events. Authentication uses ANTHROPIC_API_KEY from the provided env (or whatever
// auth the local `claude` CLI is configured with). Tool use is allowed without prompts
// via --dangerously-skip-permissions so the agent can run greplica commands itself.
export async function runClaudeAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
  const { exitCode, signal, stdout } = await runClaudeProcess(input, transcript);
  transcript.end();
  const elapsedMs = Date.now() - startedAt;

  const parsed = parseClaudeStream(stdout);
  writeFileSync(input.finalMessagePath, parsed.finalMessage, "utf8");

  return {
    agent: "claude",
    model: input.model ?? "default",
    elapsed_ms: elapsedMs,
    tool_calls: parsed.tool_calls,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    total_tokens: parsed.total_tokens,
    transcript_path: input.transcriptPath,
    final_message_path: input.finalMessagePath,
    exit_code: exitCode,
    signal,
  };
}

function runClaudeProcess(
  input: AgentRunInput,
  transcript: NodeJS.WritableStream,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (input.model !== undefined) args.push("--model", input.model);

    const child = spawn("claude", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    let stdout = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      transcript.write(text);
    });
    child.stdin.end(input.prompt);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout });
    });
  });
}

interface ParsedClaudeStream {
  finalMessage: string;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

function parseClaudeStream(stdout: string): ParsedClaudeStream {
  let finalMessage = "";
  let toolCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const line of stdout.split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;

    if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (isRecord(block) && block.type === "tool_use") toolCalls += 1;
      }
    }

    if (event.type === "result") {
      if (typeof event.result === "string") finalMessage = event.result;
      if (isRecord(event.usage)) {
        inputTokens = sumTokens(
          event.usage.input_tokens,
          event.usage.cache_read_input_tokens,
          event.usage.cache_creation_input_tokens,
        );
        outputTokens = typeof event.usage.output_tokens === "number" ? event.usage.output_tokens : null;
      }
    }
  }

  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  return { finalMessage, tool_calls: toolCalls, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
}

function sumTokens(...values: unknown[]): number | null {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value === "number") {
      sum += value;
      seen = true;
    }
  }
  return seen ? sum : null;
}

function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
