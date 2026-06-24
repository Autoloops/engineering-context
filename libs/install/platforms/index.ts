import type { InstallPlatform } from "../paths.js";
import { claudeInstaller } from "./claude.js";
import { codexInstaller } from "./codex.js";
import { cursorInstaller } from "./cursor.js";
import { opencodeInstaller } from "./opencode.js";
import type { HookInstallResult, PlatformInstaller, PlatformInstallResult } from "./types.js";
import type { RepoRef } from "../../knowledge-graph/service.js";

const platformInstallers: Partial<Record<InstallPlatform, PlatformInstaller>> = {
  claude: claudeInstaller,
  codex: codexInstaller,
  cursor: cursorInstaller,
  opencode: opencodeInstaller,
};

export type { HookInstallResult };

export function installPlatform(platform: InstallPlatform, repo: RepoRef): PlatformInstallResult {
  return platformInstaller(platform).install(repo);
}

export function platformInstaller(platform: InstallPlatform): PlatformInstaller {
  const installer = platformInstallers[platform];
  if (installer === undefined) throw new Error(`Unsupported install platform: ${platform}`);
  return installer;
}

export function allPlatformInstallers(): PlatformInstaller[] {
  return Object.values(platformInstallers).filter((installer): installer is PlatformInstaller => installer !== undefined);
}
