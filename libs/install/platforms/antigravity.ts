import { homedir } from "node:os";
import { join } from "node:path";
import { copyBundledSkills } from "../skills.js";
import type { PlatformInstallContext, PlatformInstallResult, PlatformInstaller, WorkingMemoryUpdateInput } from "./types.js";

// Antigravity CLI (the `agy` binary) reads global skills from
// ~/.gemini/antigravity-cli/skills/ -- it shares the ~/.gemini namespace
// with Gemini CLI, which it's built on top of. ANTIGRAVITY_HOME is not a
// documented Antigravity setting; Greplica checks it purely so installs can
// be redirected in tests, matching the override convention already used by
// the other platform installers (FACTORY_HOME, COPILOT_HOME, etc).
function antigravityHome(): string {
  return process.env.ANTIGRAVITY_HOME ?? join(homedir(), ".gemini", "antigravity-cli");
}

export const antigravityInstaller: PlatformInstaller = {
  platform: "antigravity",
  // Antigravity CLI hooks are configured via a workspace-local
  // .agents/hooks.json and, for tool-approval events like PreToolUse, drive
  // decisions through a JSON stdin / JSON stdout allow-deny contract --
  // materially different from the command + exit-code hooks.json shape the
  // other installers share via mergeHookConfig(). Whether a plain
  // fire-and-forget SessionStart/Stop hook (what Greplica actually needs)
  // uses that same contract or something simpler isn't confirmed from
  // documentation available at the time this was written. Rather than
  // guess and risk writing a hooks.json that breaks a user's Antigravity
  // setup, this installs skills only for now, the same approach already
  // taken for OpenCode. Someone running Antigravity CLI day to day is best
  // placed to confirm the real hook contract and extend this.
  install(_context: PlatformInstallContext): PlatformInstallResult {
    return {
      skills: copyBundledSkills(join(antigravityHome(), "skills")),
    };
  },
  sessionSourceRef(_sessionId: string): string {
    throw new Error("Antigravity session source refs are not supported yet.");
  },
  sessionIdFromSourceRef(_ref: string): string | undefined {
    return undefined;
  },
  transcriptToMarkdown(_transcript: string): string {
    throw new Error("Antigravity transcript projection is not supported yet.");
  },
  async runWorkingMemoryUpdate(_input: WorkingMemoryUpdateInput): Promise<void> {
    throw new Error("Antigravity background working-memory updates are not supported yet.");
  },
};
