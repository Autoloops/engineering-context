import type { InstallPlatform } from "../paths.js";
import type { HookInput } from "../../hooks/types.js";

export interface PlatformInstallContext {
  repoRoot: string;
  hooks: boolean;
}

export interface HookInstallResult {
  platform: InstallPlatform;
  configFiles: string[];
  events: string[];
  command: string;
}

export interface RuleInstallResult {
  platform: InstallPlatform;
  configFiles: string[];
}

export interface PlatformInstallResult {
  skills: string[];
  hooks?: HookInstallResult;
  rules?: RuleInstallResult;
  supportsAutoMemoryUpdates?: boolean;
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
  install(context: PlatformInstallContext): PlatformInstallResult;
  sessionSourceRef(sessionId: string): string;
  sessionIdFromSourceRef(ref: string): string | undefined;
  transcriptToMarkdown(transcript: string): string;
  runWorkingMemoryUpdate(input: WorkingMemoryUpdateInput): Promise<void>;
  // Override when the hook input omits a transcript path. Default: hook's transcript_path.
  transcriptPathFromHook?(hook: HookInput): string | undefined;
  // Override when the transcript is not a single readable file. Default: readFileSync(path).
  loadTranscript?(transcriptPath: string): string;
}
