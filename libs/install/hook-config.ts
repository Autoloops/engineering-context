import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InstallPlatform } from "./paths.js";

export const hookEvents = ["UserPromptSubmit", "Stop"] as const;
export type HookEvent = (typeof hookEvents)[number];

export function hookCommand(platform: InstallPlatform): string {
  return `greplica hook ingest --platform ${platform}`;
}

export function mergeHookConfig(
  base: Record<string, unknown>,
  platform: InstallPlatform,
  command: string,
): Record<string, unknown> {
  const hooks = isRecord(base.hooks) ? { ...base.hooks } : {};

  for (const event of hookEvents) {
    const existingGroups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const keptGroups = existingGroups.map((group) => removeCommandFromHookGroup(group, command)).filter(groupHasHandlers);
    hooks[event] = [
      ...keptGroups,
      {
        matcher: "",
        hooks: [commandHook(platform, command, event)],
      },
    ];
  }

  return { ...base, hooks };
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8").trim();
  if (content.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON at ${path}: ${message}`);
  }

  if (!isRecord(parsed)) throw new Error(`Invalid JSON at ${path}: expected an object.`);
  return parsed;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeCommandFromHookGroup(group: unknown, command: string): unknown {
  if (!isRecord(group)) return group;
  if (!Array.isArray(group.hooks)) return group;

  return {
    ...group,
    hooks: group.hooks.filter((handler) => !isRecord(handler) || handler.command !== command),
  };
}

function groupHasHandlers(group: unknown): boolean {
  if (!isRecord(group)) return true;
  return !Array.isArray(group.hooks) || group.hooks.length > 0;
}

function commandHook(platform: InstallPlatform, command: string, event: HookEvent): Record<string, unknown> {
  const hook: Record<string, unknown> = {
    type: "command",
    command,
    timeout: 5,
  };

  if (platform === "codex") {
    hook.statusMessage = event === "UserPromptSubmit" ? "Recording Greplica session activity" : "Recording Greplica turn completion";
  }

  return hook;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
