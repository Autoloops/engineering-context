import { redactSecrets } from "./redact.js";

export interface SessionTranscriptProjection {
  metadata: Record<string, string>;
  messages: SessionTranscriptMessage[];
}

export interface SessionTranscriptMessage {
  timestamp: string | undefined;
  role: "human" | "agent";
  phase: string | undefined;
  message: string;
}

export function renderSessionTranscriptMarkdown(projection: SessionTranscriptProjection): string {
  const sections = ["# Filtered Session Transcript", ""];

  sections.push("## Metadata", "");
  for (const [key, value] of Object.entries(projection.metadata)) {
    sections.push(`- ${key}: ${redactSecrets(value)}`);
  }
  sections.push("", "## Messages", "");

  for (const message of projection.messages) {
    const details = [message.timestamp, message.phase].filter((item): item is string => item !== undefined);
    const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
    sections.push(`### ${message.role}${suffix}`, "", message.message.trim(), "");
  }

  return `${sections.join("\n").trimEnd()}\n`;
}

/** Strips injected instruction tags and best-effort redacts secret-shaped strings. */
export function sanitizeTranscriptMessage(message: string): string {
  const withoutInjectedInstructions = message
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>\s*/g, "")
    .replace(/<developer_instruction>[\s\S]*?<\/developer_instruction>\s*/g, "")
    .trim();

  return redactSecrets(withoutInjectedInstructions);
}

export function copyStringField(
  target: Record<string, string>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = source[sourceKey];
  if (typeof value === "string" && value.trim().length > 0) {
    target[targetKey] = value;
  }
}

export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
