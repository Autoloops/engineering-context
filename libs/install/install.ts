import { resolve } from "node:path";
import { envVarSource, loadRepoEnv } from "../env/load-local-env.js";
import { greplicaConfigPath, updateEmbeddingConfig, type EmbeddingProvider, type SessionConfig } from "../config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../knowledge-graph/graph-context/config.js";
import { createLocalKnowledgeGraphService } from "../knowledge-graph/service.js";
import type { RepoRef } from "../knowledge-graph/service.js";
import { installPlatform, type HookInstallResult } from "./platforms/index.js";
import {
  type InstallEmbedding,
  type InstallPlatform,
} from "./paths.js";

export interface InstallOptions {
  platform: InstallPlatform;
  embedding: InstallEmbedding;
  repo: RepoRef;
}

export interface InstallResult {
  platform: InstallPlatform;
  skills: string[];
  hooks?: HookInstallResult;
  embedding: InstallEmbedding;
  session: SessionConfig;
  configFile: string;
  databasePath: string;
  notes: string[];
}

export async function installGreplica(options: InstallOptions): Promise<InstallResult> {
  const embedding = configureEmbedding(options.embedding, options.repo);
  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(embedding.config));
  const init = service.initRepo(options.repo);
  const platformInstall = installPlatform(options.platform, {
    repoRoot: options.repo.repo_root ?? process.cwd(),
  });

  const notes: string[] = [];
  if (options.embedding === "local") {
    notes.push("Local embeddings were configured without prewarming; the first graph-context query may download the local model.");
  }

  return {
    platform: options.platform,
    skills: platformInstall.skills,
    hooks: platformInstall.hooks,
    embedding: options.embedding,
    session: embedding.config.session,
    configFile: embedding.configPath,
    databasePath: init.database_path,
    notes,
  };
}

export function platformDisplayName(platform: InstallPlatform): string {
  if (platform === "codex") return "Codex";
  if (platform === "opencode") return "OpenCode";
  if (platform === "openhands") return "OpenHands";
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
