import type { RepoRef } from "../../knowledge-graph/service.js";
import type { InstallPlatform } from "../paths.js";

export interface HookInstallResult {
  platform: InstallPlatform;
  configFiles: string[];
  events: string[];
  command: string;
}

export interface PlatformInstallResult {
  skills: string[];
  hooks?: HookInstallResult;
  rules?: RuleInstallResult;
  notes?: string[];
}

export interface RuleInstallResult {
  platform: InstallPlatform;
  configFiles: string[];
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
  install(repo: RepoRef): PlatformInstallResult;
  sessionSourceRef(sessionId: string): string;
  sessionIdFromSourceRef(ref: string): string | undefined;
  transcriptToMarkdown(transcript: string): string;
  runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void>;
}
