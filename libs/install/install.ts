import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { envVarSource, loadRepoEnv } from "../env/load-local-env.js";
import {
  greplicaConfigPath,
  updateEmbeddingConfig,
  updateManagedConfig,
  writeGreplicaConfig,
  type EmbeddingProvider,
  type GreplicaConfig,
  type GreplicaMode,
  type ManagedConfig,
  type SessionConfig,
} from "../config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../knowledge-graph/graph-context/config.js";
import { createLocalKnowledgeGraphService } from "../knowledge-graph/service.js";
import type { RepoRef } from "../knowledge-graph/service.js";
import { ManagedKnowledgeGraphClient } from "../knowledge-graph/managed-client.js";
import { installPlatform, type HookInstallResult } from "./platforms/index.js";
import {
  type InstallEmbedding,
  type InstallPlatform,
} from "./paths.js";

export interface InstallOptions {
  platform: InstallPlatform;
  mode: GreplicaMode;
  embedding: InstallEmbedding;
  hooks: boolean;
  autoMemoryUpdates: boolean;
  managed?: ManagedConfig;
  repo: RepoRef;
}

export interface InstallResult {
  platform: InstallPlatform;
  skills: string[];
  hooks?: HookInstallResult;
  hooksRequested: boolean;
  embedding: InstallEmbedding;
  mode: GreplicaMode;
  session: SessionConfig;
  configFile: string;
  statePath: string;
  notes: string[];
}

export async function installGreplica(options: InstallOptions): Promise<InstallResult> {
  const configured = options.mode === "managed"
    ? configureManaged(options)
    : configureEmbedding(options.embedding, options.repo);
  configured.config.session.autoMemoryUpdates = options.autoMemoryUpdates;
  writeGreplicaConfig(configured.config);
  const init = await initInstalledRepo(options, configured.config);
  const platformInstall = installPlatform(options.platform, {
    repoRoot: options.repo.repo_root ?? process.cwd(),
    hooks: options.hooks,
  });
  if (platformInstall.hooks === undefined && configured.config.session.autoMemoryUpdates) {
    configured.config.session.autoMemoryUpdates = false;
    writeGreplicaConfig(configured.config);
  }

  const notes: string[] = [];
  if (options.mode === "managed") {
    notes.push("Managed mode is API-backed; graph and session state will be stored by the configured Greplica API.");
  } else if (options.embedding === "local") {
    if (startLocalEmbeddingPrewarm()) {
      notes.push("Local embedding model prewarm was queued in the background; if another prewarm is already running, this one will skip. The first query may still download the model if prewarm has not finished.");
    } else {
      notes.push("Local embeddings were configured, but background prewarm could not be started; the first query may download the local model.");
    }
  }

  return {
    platform: options.platform,
    skills: platformInstall.skills,
    hooks: platformInstall.hooks,
    hooksRequested: options.hooks,
    embedding: options.embedding,
    mode: options.mode,
    session: configured.config.session,
    configFile: configured.configPath,
    statePath: options.mode === "managed" ? configured.config.managed?.apiUrl ?? "" : init.database_path,
    notes,
  };
}

export function platformDisplayName(platform: InstallPlatform): string {
  if (platform === "codex") return "Codex";
  if (platform === "copilot") return "GitHub Copilot CLI";
  if (platform === "opencode") return "OpenCode";
  if (platform === "openhands") return "OpenHands";
  if (platform === "factory-droid") return "Factory Droid";
  return "Claude Code";
}

function configureEmbedding(provider: EmbeddingProvider, repo: RepoRef): { config: ReturnType<typeof updateEmbeddingConfig>; configPath: string } {
  const repoRoot = repo.repo_root ?? process.cwd();
  if (provider === "openai") {
    const env = loadRepoEnv(repoRoot);
    if (envVarSource("OPENAI_API_KEY", env) === undefined) {
      throw new Error("OPENAI_API_KEY is required for --embedding openai. Set it in the shell, target-root .env.local, or target-root .env.");
    }
  }

  const config = updateEmbeddingConfig({ provider });
  return {
    config,
    configPath: resolve(greplicaConfigPath()),
  };
}

function configureManaged(options: InstallOptions): { config: ReturnType<typeof updateManagedConfig>; configPath: string } {
  if (options.managed === undefined) {
    throw new Error("--mode managed requires --api-url. Set --token or GREPLICA_API_TOKEN when the API requires authentication.");
  }
  const config = updateManagedConfig(options.managed);
  return {
    config,
    configPath: resolve(greplicaConfigPath()),
  };
}

async function initInstalledRepo(options: InstallOptions, config: GreplicaConfig): Promise<{ database_path: string }> {
  if (options.mode === "managed") {
    if (config.managed === undefined) throw new Error("Managed config was not written.");
    const client = new ManagedKnowledgeGraphClient(config.managed);
    const init = await client.initRepo(options.repo);
    return { database_path: init.database_path };
  }

  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
  return service.initRepo(options.repo);
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
    child.on("error", () => {
      // Local model prewarm is best-effort; install should never fail because of it.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
