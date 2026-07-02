import { detectRepoContext } from "../cli/repo-context.js";
import { ensureGreplicaConfig } from "../../libs/config/greplica-config.js";
import { loadRepoEnv } from "../../libs/env/load-local-env.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { createLocalKnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import type { GraphReadResult, KnowledgeGraphService, RepoRef } from "../../libs/knowledge-graph/service.js";
import { repoNotInstalled } from "./errors.js";
import type { Logger } from "./logger.js";

export interface InstalledRepo {
  readonly repo: RepoRef;
  readonly service: KnowledgeGraphService;
  readonly repoId: string;
}

interface CachedService {
  readonly repo: RepoRef;
  readonly service: KnowledgeGraphService;
}

interface CachedGraph {
  readonly at: number;
  readonly graph: GraphReadResult;
}

const defaultGraphTtlMs = 3_000;

/**
 * Dependency container for the MCP server. Because the server is long-lived it
 * caches one KnowledgeGraphService per repository root (keeping the SQLite handle
 * and the local embedding model warm across calls) and serves graph reads through
 * a short-TTL cache-aside layer. The TTL bounds staleness from other writers
 * (the CLI, the background hook worker) that share the same database file.
 */
export class McpContainer {
  private readonly services = new Map<string, CachedService>();
  private readonly graphCache = new Map<string, CachedGraph>();
  private readonly graphGeneration = new Map<string, number>();

  constructor(
    private readonly logger: Logger,
    private readonly graphTtlMs: number = defaultGraphTtlMs,
    private readonly now: () => number = () => Date.now(),
  ) {}

  resolveRepo(explicitRoot?: string): RepoRef {
    const root = explicitRoot ?? process.env.GREPLICA_REPO_ROOT ?? process.cwd();
    return detectRepoContext(root);
  }

  getInstalled(explicitRoot?: string): InstalledRepo {
    const repo = this.resolveRepo(explicitRoot);
    const service = this.serviceFor(repo);
    try {
      const initialized = service.requireRepo(repo);
      return { repo, service, repoId: initialized.repo_id };
    } catch (error) {
      throw repoNotInstalled(repo.repo_root, error);
    }
  }

  readGraph(installed: InstalledRepo): GraphReadResult {
    const cached = this.graphCache.get(installed.repoId);
    if (cached !== undefined && this.now() - cached.at < this.graphTtlMs) {
      return cached.graph;
    }
    // Capture the generation before reading so a concurrent invalidateGraph()
    // (e.g. from apply_proposal) prevents this read from re-caching stale data.
    const generation = this.graphGeneration.get(installed.repoId) ?? 0;
    const graph = installed.service.readGraph(installed.repo);
    if ((this.graphGeneration.get(installed.repoId) ?? 0) === generation) {
      this.graphCache.set(installed.repoId, { at: this.now(), graph });
    }
    return graph;
  }

  invalidateGraph(repoId: string): void {
    this.graphCache.delete(repoId);
    this.graphGeneration.set(repoId, (this.graphGeneration.get(repoId) ?? 0) + 1);
  }

  private serviceFor(repo: RepoRef): KnowledgeGraphService {
    // detectRepoContext always resolves a root; fail fast rather than fall back
    // to repo_name, which could route two different checkouts to one database.
    const key = repo.repo_root;
    if (key === undefined) {
      throw new Error(`Could not resolve a repository root for ${repo.repo_name}.`);
    }
    const cached = this.services.get(key);
    if (cached !== undefined) return cached.service;

    // NOTE: this cache-miss path must stay fully synchronous. An await between
    // the get() above and the set() below would let concurrent calls open (and
    // leak) duplicate SQLite handles for the same repository root.
    const config = ensureGreplicaConfig();
    if (config.embedding.provider === "openai") {
      // Loads OPENAI_* keys from the repo's .env.local/.env into process.env.
      // Keys already present always win, so in a multi-repo session the first
      // repo's credentials stick — surface that instead of failing silently.
      const alreadySet = process.env.OPENAI_API_KEY !== undefined;
      loadRepoEnv(key);
      if (alreadySet && this.services.size > 0) {
        this.logger.warn("container.env_not_overridden", {
          repo: repo.repo_name,
          detail: "OPENAI_API_KEY was already set; this repo's .env values are ignored",
        });
      }
    }
    const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
    this.services.set(key, { repo, service });
    this.logger.debug("container.service_created", {
      repo: repo.repo_name,
      embedding_provider: config.embedding.provider,
    });
    return service;
  }
}
