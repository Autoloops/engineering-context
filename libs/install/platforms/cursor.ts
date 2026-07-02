import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyBundledSkills } from "../skills.js";
import { greplicaHookGuidance, greplicaContextMarker } from "../../hooks/guidance.js";
import type {
  PlatformInstallContext,
  PlatformInstallResult,
  PlatformInstaller,
  WorkingMemoryUpdateInput,
} from "./types.js";

export const cursorInstaller: PlatformInstaller = {
  platform: "cursor",
  install(context: PlatformInstallContext): PlatformInstallResult {
    const cursorHome = process.env.CURSOR_HOME ?? join(homedir(), ".cursor");
    const skills = copyBundledSkills(join(cursorHome, "skills"));
    if (!context.hooks) return { skills };

    const rulesDir = join(context.repoRoot, ".cursor", "rules");
    const rulePath = join(rulesDir, "greplica.mdc");

    const frontmatter = `---
description: Greplica rule for repo-memory search
globs: *
alwaysApply: true
---
`;
    const cursorGuidance = `Greplica provides local, searchable repository memory for this repo.
- Before broad manual exploration, run \`greplica graph context "<question>"\` with a focused natural-language query.
- Greplica installs shared agent skills under \`~/.cursor/skills/\`; use \`greplica-bootstrap\` for initial repo memory and \`greplica-update-working-memory\` near the end of useful sessions.
- When Greplica provides useful context, mention that you used it and briefly say what it helped with.`;

    const ruleContent = `${frontmatter}${cursorGuidance}\n`;

    if (!existsSync(rulePath)) {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(rulePath, ruleContent, "utf8");
    } else {
      const existing = readFileSync(rulePath, "utf8");
      if (!existing.includes("Greplica provides local, searchable repository memory")) {
        // Append safely avoiding destructive overwrites
        writeFileSync(rulePath, `${existing.trim()}\n\n${cursorGuidance}\n`, "utf8");
      }
    }

    return {
      skills,
    };
  },
  sessionSourceRef(_sessionId: string): string {
    throw new Error("Cursor session source refs are not supported yet.");
  },
  sessionIdFromSourceRef(_ref: string): string | undefined {
    return undefined;
  },
  transcriptToMarkdown(_transcript: string): string {
    throw new Error("Cursor transcript projection is not supported yet.");
  },
  async runWorkingMemoryUpdate(_input: WorkingMemoryUpdateInput): Promise<void> {
    throw new Error("Cursor background working-memory updates are not supported yet.");
  },
};
