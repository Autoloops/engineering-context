import type { InstallPlatform } from "../paths.js";
import { antigravityInstaller } from "./antigravity.js";
import { claudeInstaller } from "./claude.js";
import { copilotInstaller } from "./copilot.js";
import { codexInstaller } from "./codex.js";
import { droidInstaller } from "./droid.js";
import { opencodeInstaller } from "./opencode.js";
import { openhandsInstaller } from "./openhands.js";
import type { HookInstallResult, PlatformInstallContext, PlatformInstaller, PlatformInstallResult } from "./types.js";

const platformInstallers: Partial<Record<InstallPlatform, PlatformInstaller>> = {
  claude: claudeInstaller,
  codex: codexInstaller,
  copilot: copilotInstaller,
  opencode: opencodeInstaller,
  openhands: openhandsInstaller,
  "factory-droid": droidInstaller,
  antigravity: antigravityInstaller,
};

export type { HookInstallResult };

export function installPlatform(platform: InstallPlatform, context: PlatformInstallContext): PlatformInstallResult {
  return platformInstaller(platform).install(context);
}

export function platformInstaller(platform: InstallPlatform): PlatformInstaller {
  const installer = platformInstallers[platform];
  if (installer === undefined) throw new Error(`Unsupported install platform: ${platform}`);
  return installer;
}

export function allPlatformInstallers(): PlatformInstaller[] {
  return Object.values(platformInstallers).filter((installer): installer is PlatformInstaller => installer !== undefined);
}
