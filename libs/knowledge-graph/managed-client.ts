import { auditClaimCodeAnchors } from "./code-anchors/audit.js";
import type { ClaimAnchorAuditResult } from "./code-anchors/types.js";
import type { GraphContextResult } from "./graph-context/types.js";
import { buildGraphViewHtml } from "./graph-view/build-graph-view.js";
import type { KnowledgeGraphProvider, MarkMemoryCurrentInput, RecordHookEventInput } from "./provider.js";
import type {
  ApplyProposalResult,
  GraphReadResult,
  InitRepoResult,
  RepoRef,
} from "./service.js";
import type { ProposalValidationResult } from "./validate-proposal.js";
import type { ClaimedMemoryUpdateAttempt, RecordHookResult } from "../hooks/session-state.js";

export interface ManagedKnowledgeGraphClientOptions {
  apiUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export class ManagedKnowledgeGraphClient implements KnowledgeGraphProvider {
  readonly mode = "managed" as const;
  private readonly apiUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ManagedKnowledgeGraphClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.authToken = options.authToken ?? process.env.GREPLICA_API_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  initRepo(input: RepoRef): Promise<InitRepoResult> {
    return this.post("/v1/repos/init", { repo: input });
  }

  requireRepo(input: RepoRef): Promise<InitRepoResult> {
    return this.post("/v1/repos/require", { repo: input });
  }

  readGraph(input: RepoRef): Promise<GraphReadResult> {
    return this.post("/v1/graph/read", { repo: input });
  }

  contextGraph(input: RepoRef, query: string): Promise<GraphContextResult> {
    return this.post("/v1/graph/context", { repo: input, query });
  }

  async buildGraphView(input: RepoRef): Promise<string> {
    const graph = await this.readGraph(input);
    return buildGraphViewHtml(graph, [], [], { repoName: input.repo_name });
  }

  async auditCodeAnchors(input: RepoRef): Promise<ClaimAnchorAuditResult> {
    const graph = await this.readGraph(input);
    return auditClaimCodeAnchors(input.repo_root, graph.claims);
  }

  validateProposal(input: RepoRef, proposal: unknown): Promise<ProposalValidationResult> {
    return this.post("/v1/proposals/validate", { repo: input, proposal });
  }

  applyProposal(input: RepoRef, proposal: unknown): Promise<ApplyProposalResult> {
    return this.post("/v1/proposals/apply", { repo: input, proposal });
  }

  recordHook(input: RecordHookEventInput): Promise<RecordHookResult> {
    return this.post("/v1/hooks/record", input);
  }

  claimDueMemoryUpdateAttempts(): Promise<ClaimedMemoryUpdateAttempt[]> {
    return this.post("/v1/hooks/claim-due-memory-updates", {});
  }

  markMemoryCurrent(input: MarkMemoryCurrentInput): Promise<boolean> {
    return this.post("/v1/sessions/mark-memory-current", input);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (this.apiUrl.length === 0) throw new Error("Greplica managed API URL is not configured.");
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await managedApiError(response));
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.authToken !== undefined && this.authToken.length > 0) {
      headers.authorization = `Bearer ${this.authToken}`;
    }
    return headers;
  }
}

async function managedApiError(response: Response): Promise<string> {
  const fallback = `Greplica managed API request failed: ${response.status} ${response.statusText}`;
  const text = await response.text();
  if (text.trim().length === 0) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    return `${fallback}\n${text}`;
  }
  return `${fallback}\n${text}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
