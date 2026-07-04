export type AgentKind = "codex" | "openhands" | "opencode";

export interface AgentRunInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  prompt: string;
  transcriptPath: string;
  finalMessagePath: string;
  proposalPath?: string;
}

export interface AgentRunResult {
  agent: AgentKind;
  model: string;
  elapsed_ms: number;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  transcript_path: string;
  final_message_path: string;
  exit_code: number | null;
  signal: string | null;
}
