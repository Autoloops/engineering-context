import { homedir } from "node:os";
import { join } from "node:path";
import { copyBundledSkills } from "../skills.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

export const opencodeInstaller: PlatformInstaller = {
  platform: "opencode",
  install(_context: PlatformInstallContext): PlatformInstallResult {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return {
      skills: copyBundledSkills(join(configHome, "opencode", "skills")),
    };
  },
  sessionSourceRef(_sessionId: string): string {
    throw new Error("OpenCode session source refs are not supported yet.");
  },
  sessionIdFromSourceRef(_ref: string): string | undefined {
    return undefined;
  },
  transcriptToMarkdown(_transcript: string): string {
    throw new Error("OpenCode transcript projection is not supported yet.");
  },
  async runWorkingMemoryUpdate(_input: WorkingMemoryUpdateInput): Promise<void> {
    throw new Error("OpenCode background working-memory updates are not supported yet.");
  },
};
