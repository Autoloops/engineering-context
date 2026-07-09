import type Database from "better-sqlite3";
import type { GraphContextConfig } from "./graph-context/config.js";
import { graphContextConfig } from "./graph-context/config.js";
import type { KnowledgeGraphProvider, MarkMemoryCurrentInput, RecordHookEventInput } from "./provider.js";
import { KnowledgeGraphService, type RepoRef } from "./service.js";
import { HookSessionStore } from "../hooks/session-state.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { SqliteRepository } from "../storage/sqlite/repository.js";
import type { SessionConfig } from "../config/greplica-config.js";

export class LocalKnowledgeGraphProvider implements KnowledgeGraphProvider {
  readonly mode = "local" as const;
  private readonly repository: SqliteRepository;
  private readonly service: KnowledgeGraphService;

  constructor(
    private readonly db: Database.Database = openDatabase(),
    contextConfig: GraphContextConfig = graphContextConfig,
    private readonly sessionConfig?: SessionConfig,
    private readonly ownsDatabase = false,
  ) {
    this.repository = new SqliteRepository(db);
    this.service = new KnowledgeGraphService(this.repository, contextConfig);
  }

  initRepo(input: RepoRef) {
    return this.service.initRepo(input);
  }

  requireRepo(input: RepoRef) {
    return this.service.requireRepo(input);
  }

  readGraph(input: RepoRef) {
    return this.service.readGraph(input);
  }

  contextGraph(input: RepoRef, query: string) {
    return this.service.contextGraph(input, query);
  }

  buildGraphView(input: RepoRef) {
    return this.service.buildGraphView(input);
  }

  auditCodeAnchors(input: RepoRef) {
    return this.service.auditCodeAnchors(input);
  }

  validateProposal(input: RepoRef, proposal: unknown) {
    return this.service.validateProposal(input, proposal);
  }

  applyProposal(input: RepoRef, proposal: unknown) {
    return this.service.applyProposal(input, proposal);
  }

  async recordHook(input: RecordHookEventInput) {
    const installed = this.service.requireRepo(input.repo);
    return new HookSessionStore(this.db, this.sessionConfig).recordHook({
      platform: input.platform,
      repoId: installed.repo_id,
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      cwd: input.cwd,
      eventName: input.eventName,
    });
  }

  async claimDueMemoryUpdateAttempts() {
    return new HookSessionStore(this.db, this.sessionConfig).claimDueMemoryUpdateAttempts();
  }

  async markMemoryCurrent(input: MarkMemoryCurrentInput) {
    if (input.sessionId === undefined || input.sessionId.length === 0) return false;
    const installed = this.service.requireRepo(input.repo);
    return new HookSessionStore(this.db, this.sessionConfig).markMemoryCurrent({
      repoId: installed.repo_id,
      platform: input.platform,
      sessionId: input.sessionId,
    });
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}

export function createLocalKnowledgeGraphProvider(
  contextConfig: GraphContextConfig = graphContextConfig,
  sessionConfig?: SessionConfig,
): LocalKnowledgeGraphProvider {
  return new LocalKnowledgeGraphProvider(openDatabase(), contextConfig, sessionConfig, true);
}
