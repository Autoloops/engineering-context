import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { greplicaContextMarker, greplicaHookGuidance } from "../../hooks/guidance.js";
import { copyBundledSkills } from "../skills.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

const guidanceFileName = "greplica.md";

export const clineInstaller: PlatformInstaller = {
  platform: "cline",
  install(context: PlatformInstallContext): PlatformInstallResult {
    // Cline loads project rules from .clinerules/ in the repo, not a user home dir.
    const { repoRoot } = context;
    const clinerulesDir = join(repoRoot, ".clinerules");
    mkdirSync(clinerulesDir, { recursive: true });

    const skills = copyBundledSkills(join(clinerulesDir, "greplica-skills"));
    writeClineGuidance(join(clinerulesDir, guidanceFileName));

    return { skills };
  },
  sessionSourceRef(_sessionId: string): string {
    throw new Error(
      "Cline is a VS Code extension without Greplica session source refs; sessions live in extension state, not exportable files.",
    );
  },
  sessionIdFromSourceRef(_ref: string): string | undefined {
    return undefined;
  },
  transcriptToMarkdown(_transcript: string): string {
    throw new Error(
      "Cline is a VS Code extension without JSONL session transcripts; use greplica graph context and the skills in .clinerules/greplica-skills/ instead.",
    );
  },
  async runWorkingMemoryUpdate(_input: WorkingMemoryUpdateInput): Promise<void> {
    throw new Error(
      "Cline is a VS Code extension without Stop/UserPromptSubmit hooks; run greplica-update-working-memory manually near the end of useful sessions.",
    );
  },
};

function writeClineGuidance(path: string): void {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(greplicaContextMarker)) return;
    const separator = existing.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${existing}${separator}\n${greplicaHookGuidance}\n`, "utf8");
    return;
  }
  writeFileSync(path, `${greplicaHookGuidance}\n`, "utf8");
}
