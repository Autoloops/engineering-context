import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { envVarSource, loadRepoEnv } from "../env/load-local-env.js";
import {
  ensureGreplicaConfig,
  greplicaConfigPath,
  updateEmbeddingConfig,
  type EmbeddingProvider,
} from "../config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../knowledge-graph/graph-context/config.js";
import { createLocalKnowledgeGraphService, type RepoRef } from "../knowledge-graph/service.js";
import { defaultDatabasePath, openDatabase } from "../storage/sqlite/db.js";
import type { ManagedAccessStatus, ManagedRepoRole, RepoMode } from "../storage/sqlite/repository.js";
import { RepoInstallationStore, type RepoInstallation } from "./repo-installation-store.js";
import { PlatformIntegrationStore } from "./platform-integration-store.js";
import { installPlatform, type HookInstallResult, type RuleInstallResult } from "./platforms/index.js";
import { type InstallEmbedding, type InstallPlatform } from "./paths.js";

export interface InstallOptions {
  mode: RepoMode;
  platform?: InstallPlatform;
  embedding?: InstallEmbedding;
  hooks: boolean;
  autoMemoryUpdates: boolean;
  repo: RepoRef;
  managedRepoId?: string;
  managedRole?: ManagedRepoRole;
  managedAccessStatus?: ManagedAccessStatus;
  allowModeSwitch?: boolean;
  allowRebind?: boolean;
}

export interface InstallResult {
  mode: RepoMode;
  platform: InstallPlatform;
  skills: string[];
  hooks?: HookInstallResult;
  rules?: RuleInstallResult;
  hooksRequested: boolean;
  embedding?: InstallEmbedding;
  autoMemoryUpdates: boolean;
  configFile: string;
  databasePath: string;
  installation: RepoInstallation;
  notes: string[];
}

export async function installGreplica(options: InstallOptions): Promise<InstallResult> {
  if (options.mode === "managed" && options.embedding !== undefined) {
    throw new Error("Managed installations use server-owned embeddings; omit --embedding.");
  }
  if (options.mode === "managed" && options.managedRepoId === undefined) {
    throw new Error("Managed installation requires a selected managed repository.");
  }

  const validationDb = openDatabase();
  try {
    new RepoInstallationStore(validationDb).assertCanActivate(options.repo, options.mode, {
      managedRepoId: options.managedRepoId,
      allowModeSwitch: options.allowModeSwitch,
      allowRebind: options.allowRebind,
    });
  } finally {
    validationDb.close();
  }

  const config = options.mode === "local"
    ? configureEmbedding(options.embedding ?? "local", options.repo).config
    : ensureGreplicaConfig();

  let localInit: ReturnType<ReturnType<typeof createLocalKnowledgeGraphService>["initRepo"]> | undefined;
  if (options.mode === "local") {
    const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
    try {
      localInit = service.initRepo(options.repo);
    } finally {
      service.close();
    }
  }

  const platformDb = openDatabase();
  let platform: InstallPlatform;
  try {
    const integrations = new PlatformIntegrationStore(platformDb);
    platform = options.platform ?? integrations.preferred() ?? missingPlatform();
  } finally {
    platformDb.close();
  }
  const platformInstall = installPlatform(platform, {
    repoRoot: options.repo.repo_root ?? process.cwd(),
    hooks: options.hooks,
  });
  const supportsAutoMemoryUpdates = platformInstall.hooks !== undefined && platformInstall.supportsAutoMemoryUpdates !== false;
  const autoMemoryUpdates = options.hooks && options.autoMemoryUpdates && supportsAutoMemoryUpdates;
  const db = openDatabase();
  let installation: RepoInstallation;
  try {
    const store = new RepoInstallationStore(db);
    new PlatformIntegrationStore(db).record(platform);
    installation = options.mode === "local"
      ? store.activateLocal(options.repo, {
          hooksEnabled: options.hooks,
          autoMemoryUpdates,
          allowModeSwitch: options.allowModeSwitch,
        })
      : store.activateManaged(options.repo, {
          managedRepoId: options.managedRepoId as string,
          managedRole: options.managedRole ?? "reader",
          managedAccessStatus: options.managedAccessStatus ?? "active",
          hooksEnabled: options.hooks,
          autoMemoryUpdates,
          allowModeSwitch: options.allowModeSwitch,
          allowRebind: options.allowRebind,
        });
  } finally {
    db.close();
  }

  const notes: string[] = [];
  if (options.autoMemoryUpdates && !supportsAutoMemoryUpdates && platformInstall.hooks !== undefined) {
    notes.push(`${platformDisplayName(platform)} automatic memory updates are not supported yet; installed hooks still record session activity.`);
  }
  if (options.mode === "managed" && options.managedRole !== "memory_admin" && options.autoMemoryUpdates) {
    notes.push("Managed reader access records session guidance but does not schedule memory updates.");
  }
  if (options.mode === "local" && options.embedding === "local") {
    if (startLocalEmbeddingPrewarm()) {
      notes.push("Local embedding model prewarm was queued in the background; if another prewarm is already running, this one will skip. The first query may still download the model if prewarm has not finished.");
    } else {
      notes.push("Local embeddings were configured, but background prewarm could not be started; the first query may download the local model.");
    }
  }

  return {
    mode: options.mode,
    platform,
    skills: platformInstall.skills,
    hooks: platformInstall.hooks,
    rules: platformInstall.rules,
    hooksRequested: options.hooks,
    embedding: options.mode === "local" ? (options.embedding ?? "local") : undefined,
    autoMemoryUpdates,
    configFile: resolve(greplicaConfigPath()),
    databasePath: localInit?.database_path ?? defaultDatabasePath(),
    installation,
    notes,
  };
}

function missingPlatform(): never {
  throw new Error("--platform is required until at least one global platform integration has been installed.");
}

export function platformDisplayName(platform: InstallPlatform): string {
  if (platform === "codex") return "Codex";
  if (platform === "copilot") return "GitHub Copilot CLI";
  if (platform === "opencode") return "OpenCode";
  if (platform === "openhands") return "OpenHands";
  if (platform === "factory-droid") return "Factory Droid";
  if (platform === "antigravity") return "Antigravity";
  if (platform === "cursor") return "Cursor";
  return "Claude Code";
}

function configureEmbedding(provider: EmbeddingProvider, repo: RepoRef): { config: ReturnType<typeof updateEmbeddingConfig> } {
  const repoRoot = repo.repo_root ?? process.cwd();
  if (provider === "openai") {
    const env = loadRepoEnv(repoRoot);
    if (envVarSource("OPENAI_API_KEY", env) === undefined) {
      throw new Error("OPENAI_API_KEY is required for --embedding openai. Set it in the shell, target-root .env.local, or target-root .env.");
    }
  }
  return { config: updateEmbeddingConfig({ provider }) };
}

function startLocalEmbeddingPrewarm(): boolean {
  if (process.env.GREPLICA_INSTALL_SKIP_PREWARM === "1") return false;
  const script = process.argv[1];
  if (script === undefined) return false;

  try {
    const child = spawn(process.execPath, [script, "embeddings", "prewarm"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
