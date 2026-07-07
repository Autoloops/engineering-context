import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallPlatform = "codex" | "claude" | "opencode" | "openhands" | "factory-droid" | "copilot" | "antigravity" | "cursor";
export type InstallEmbedding = "local" | "openai";

export const installPlatforms = ["codex", "claude", "copilot", "cursor", "opencode", "openhands", "factory-droid", "antigravity"] as const satisfies readonly InstallPlatform[];
export const installPlatformUsage = installPlatforms.join("|");
export const installCommandSuggestion = `greplica install --platform <${installPlatformUsage}> --embedding local`;

export const skillNames = ["greplica-bootstrap", "greplica-update-working-memory", "greplica-fast-session-bootstrap"] as const;
export type SkillName = (typeof skillNames)[number];

export function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== dirname(current)) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "skills"))) return current;
    current = dirname(current);
  }
  throw new Error("Could not locate Greplica package root with bundled skills.");
}
