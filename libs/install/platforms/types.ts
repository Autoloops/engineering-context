import type { InstallPlatform } from "../paths.js";
import type { RepoRef } from "../../knowledge-graph/service.js";

export interface HookInstallResult {
  platform: InstallPlatform;
  configFiles: string[];
  events: string[];
  command: string;
}

export interface PlatformInstallResult {
  skills: string[];
  hooks?: HookInstallResult;
  guidanceFiles?: string[];
}

export interface PlatformInstallInput {
  repo: RepoRef;
}

export interface WorkingMemoryUpdateInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  transcriptPath: string;
  finalMessagePath: string;
}

export interface PlatformInstaller {
  platform: InstallPlatform;
  install(input: PlatformInstallInput): PlatformInstallResult;
  sessionSourceRef(sessionId: string): string;
  sessionIdFromSourceRef(ref: string): string | undefined;
  transcriptToMarkdown(transcript: string): string;
  runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void>;
}
