import type Database from "better-sqlite3";
import type { RepoInstallation } from "../install/repo-installation-store.js";
import type { RepoRef } from "./service.js";
import { KnowledgeGraphService } from "./service.js";
import type { GraphMemoryProvider } from "./provider.js";
import type { ManagedGraphView } from "../managed/protocol.js";

export class LocalGraphMemoryProvider implements GraphMemoryProvider {
  readonly mode = "local" as const;

  constructor(
    readonly installation: RepoInstallation,
    private readonly repo: RepoRef,
    private readonly service: KnowledgeGraphService,
    private readonly db: Database.Database,
  ) {
    if (installation.activeMode !== "local") throw new Error("Local provider requires a local repository installation.");
    const initialized = service.requireRepo(repo);
    if (initialized.repo_id !== installation.id) throw new Error("Resolved repository installation does not match its local graph.");
  }

  async readGraph(view?: ManagedGraphView) {
    assertLocalDefaultView(view);
    return this.service.readGraph(this.repo);
  }

  async contextGraph(query: string, view?: ManagedGraphView) {
    assertLocalDefaultView(view);
    return this.service.contextGraph(this.repo, query);
  }

  async viewData(view?: ManagedGraphView) {
    assertLocalDefaultView(view);
    return this.service.graphViewData(this.repo);
  }

  async buildGraphView(view?: ManagedGraphView) {
    assertLocalDefaultView(view);
    return this.service.buildGraphView(this.repo);
  }

  async auditCodeAnchors() {
    return this.service.auditCodeAnchors(this.repo);
  }

  async reviewProposal(proposal: unknown) {
    return this.service.validateProposal(this.repo, proposal);
  }

  async applyProposal(proposal: unknown) {
    return this.service.applyProposal(this.repo, proposal);
  }

  listProposals(): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  showProposal(_proposalId: string): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  listMemoryPrs(): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  showMemoryPr(_memoryPrId: string): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  retryMemoryPr(_memoryPrId: string): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  memoryStatus(): Promise<never> {
    return Promise.reject(managedCollaborationOnly());
  }

  close(): void {
    this.db.close();
  }
}

function assertLocalDefaultView(view: ManagedGraphView | undefined): void {
  if (view !== undefined) throw managedCollaborationOnly();
}

function managedCollaborationOnly(): Error {
  return new Error("Personal working scopes and Memory PRs require a managed Greplica repository.");
}
