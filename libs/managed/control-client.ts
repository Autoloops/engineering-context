import {
  managedToken,
  readManagedCredentials,
  writeManagedCredentials,
  type ManagedCredentials,
} from "../config/managed-credentials.js";
import type { GreplicaConfig } from "../config/greplica-config.js";
import { managedApiUrl } from "../config/greplica-config.js";
import { RepoInstallationStore } from "../install/repo-installation-store.js";
import { openDatabase } from "../storage/sqlite/db.js";
import type {
  ManagedAccessRequest,
  ManagedInvitation,
  ManagedOrganization,
  ManagedOrgMembership,
  ManagedRepository,
  ManagedRepoInviteLink,
  ManagedRepoInviteLinkCreated,
  ManagedRepoGrant,
  ManagedUser,
} from "./protocol.js";

export interface DeviceLoginStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type DeviceLoginPoll =
  | { status: "pending"; interval: number }
  | { status: "complete"; token: string; user: ManagedUser };

export class ManagedControlClient {
  private token?: string;
  private credentials?: ManagedCredentials;
  private readonly apiUrl: string;

  constructor(
    config: GreplicaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiUrl = managedApiUrl(config);
    this.credentials = readManagedCredentials(this.apiUrl);
    this.token = managedToken(this.apiUrl, this.credentials);
  }

  startDeviceLogin(): Promise<DeviceLoginStart> {
    return this.request("POST", "/v1/auth/github/device/start", {}, false);
  }

  pollDeviceLogin(deviceCode: string): Promise<DeviceLoginPoll> {
    return this.request("POST", "/v1/auth/github/device/poll", { device_code: deviceCode }, false);
  }

  whoami(): Promise<{ user: ManagedUser }> {
    return this.request("GET", "/v1/auth/me");
  }

  createOrg(name: string, slug?: string): Promise<ManagedOrganization> {
    return this.request("POST", "/v1/orgs", { name, slug });
  }

  listOrgs(): Promise<ManagedOrganization[]> {
    return this.request("GET", "/v1/orgs");
  }

  inviteOrgMember(orgId: string, githubUser: string): Promise<ManagedInvitation> {
    return this.request("POST", `/v1/orgs/${encodeURIComponent(orgId)}/invitations`, { github_user: githubUser });
  }

  listOrgMembers(orgId: string): Promise<ManagedOrgMembership[]> {
    return this.request("GET", `/v1/orgs/${encodeURIComponent(orgId)}/members`);
  }

  updateOrgRole(orgId: string, userId: string, role: "admin" | "member" | "guest"): Promise<ManagedOrgMembership> {
    return this.request("PATCH", `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/role`, {
      user_id: userId,
      role,
    });
  }

  removeOrgMember(orgId: string, userId: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`);
  }

  leaveOrg(orgId: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v1/orgs/${encodeURIComponent(orgId)}/members/me`);
  }

  listInvites(): Promise<ManagedInvitation[]> {
    return this.request("GET", "/v1/invites");
  }

  acceptInvite(inviteId: string): Promise<ManagedInvitation> {
    return this.request("POST", `/v1/invites/${encodeURIComponent(inviteId)}/accept`);
  }

  revokeInvite(inviteId: string): Promise<ManagedInvitation> {
    return this.request("POST", `/v1/invites/${encodeURIComponent(inviteId)}/revoke`);
  }

  createGenericRepo(orgId: string, name: string): Promise<ManagedRepository> {
    return this.request("POST", "/v1/repos", { org_id: orgId, name });
  }

  async listRepos(): Promise<ManagedRepository[]> {
    const repositories = await this.request<ManagedRepository[]>("GET", "/v1/repos");
    const byId = new Map(repositories.map((repository) => [repository.id, repository]));
    const db = openDatabase();
    try {
      const store = new RepoInstallationStore(db);
      for (const installation of store.list()) {
        if (installation.managedRepoId === undefined) continue;
        const repository = byId.get(installation.managedRepoId);
        store.updateManagedAccess(
          installation.managedRepoId,
          repository?.effective_role,
          repository?.access_status ?? "revoked",
        );
      }
    } finally {
      db.close();
    }
    return repositories;
  }

  connectRepos(githubRepositoryId?: string, upstreamGithubRepositoryId?: string): Promise<ManagedRepository[]> {
    return this.request("POST", "/v1/repos/connect", {
      github_repository_id: githubRepositoryId,
      upstream_github_repository_id: upstreamGithubRepositoryId,
    });
  }

  enrollGithubRepo(orgId: string, installationId: string, githubRepositoryId: string, name?: string): Promise<ManagedRepository> {
    return this.request("POST", "/v1/repos/enroll/github", {
      org_id: orgId,
      installation_id: installationId,
      github_repository_id: githubRepositoryId,
      name,
    });
  }

  linkGithubRepo(repoId: string, installationId: string, githubRepositoryId: string): Promise<ManagedRepository> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/link/github`, {
      installation_id: installationId,
      github_repository_id: githubRepositoryId,
    }, true, repoId);
  }

  archiveRepo(repoId: string): Promise<ManagedRepository> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/archive`, undefined, true, repoId);
  }

  restoreRepo(repoId: string): Promise<ManagedRepository> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/restore`, undefined, true, repoId);
  }

  setDiscovery(repoId: string, discovery: "listed" | "unlisted"): Promise<ManagedRepository> {
    return this.request("PATCH", `/v1/repos/${encodeURIComponent(repoId)}/discovery`, { discovery }, true, repoId);
  }

  inviteRepoReader(repoId: string, githubUser: string): Promise<ManagedInvitation> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/invites`, { github_user: githubUser }, true, repoId);
  }

  createRepoInviteLink(repoId: string): Promise<ManagedRepoInviteLinkCreated> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/invite-links`, {}, true, repoId);
  }

  listRepoInviteLinks(repoId: string): Promise<ManagedRepoInviteLink[]> {
    return this.request("GET", `/v1/repos/${encodeURIComponent(repoId)}/invite-links`, undefined, true, repoId);
  }

  revokeRepoInviteLink(repoId: string, linkId: string): Promise<ManagedRepoInviteLink> {
    return this.request(
      "POST",
      `/v1/repos/${encodeURIComponent(repoId)}/invite-links/${encodeURIComponent(linkId)}/revoke`,
      {},
      true,
      repoId,
    );
  }

  claimRepoInviteLink(token: string): Promise<ManagedRepository> {
    return this.request("POST", "/v1/invite-links/claim", { token });
  }

  grantRepoRole(repoId: string, userId: string, role: "reader" | "memory_admin"): Promise<ManagedRepoGrant> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/grants`, { user_id: userId, role }, true, repoId);
  }

  revokeRepoRole(repoId: string, userId: string, role: "reader" | "memory_admin"): Promise<{ revoked: boolean }> {
    return this.request("DELETE", `/v1/repos/${encodeURIComponent(repoId)}/grants`, { user_id: userId, role }, true, repoId);
  }

  requestAccess(repoId: string): Promise<ManagedAccessRequest> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/access-requests`, undefined, true, repoId);
  }

  listAccessRequests(repoId: string): Promise<ManagedAccessRequest[]> {
    return this.request("GET", `/v1/repos/${encodeURIComponent(repoId)}/access-requests`, undefined, true, repoId);
  }

  decideAccessRequest(repoId: string, requestId: string, decision: "approve" | "deny"): Promise<ManagedAccessRequest> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/access-requests/${encodeURIComponent(requestId)}/decision`, {
      decision,
    }, true, repoId);
  }

  startGithubInstallation(): Promise<{ setup_id: string; url: string; state: string }> {
    return this.request("POST", "/v1/github/installations/start");
  }

  pollGithubInstallation(setupId: string): Promise<
    { status: "pending" } | { status: "complete"; installation_id: string }
  > {
    return this.request("POST", "/v1/github/installations/poll", { setup_id: setupId });
  }

  importLocalGraph(
    repoId: string,
    graph: unknown,
    anchorAudit: {
      result: unknown;
      fingerprints: Record<string, Record<string, string>>;
    },
    commit?: { git_head?: string; branch?: string; dirty?: boolean },
  ): Promise<unknown> {
    return this.request("POST", `/v1/repos/${encodeURIComponent(repoId)}/import`, {
      graph,
      anchor_audit: anchorAudit,
      commit,
    }, true, repoId);
  }

  setAuthenticatedUser(result: Extract<DeviceLoginPoll, { status: "complete" }>): void {
    this.token = result.token;
    this.credentials = {
      version: 2,
      apiUrl: this.apiUrl,
      token: result.token,
      user: {
        id: result.user.id,
        githubLogin: result.user.github_login,
        githubUserId: result.user.github_user_id,
      },
    };
    writeManagedCredentials(this.credentials);
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    authenticated = true,
    managedRepoId?: string,
  ): Promise<T> {
    if (authenticated && this.token === undefined) throw new Error("Managed Greplica is not authenticated. Run 'greplica login'.");
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.captureRenewedToken(response);
    if (managedRepoId !== undefined) this.captureRepoAccess(response, managedRepoId);
    const payload = await response.text();
    const parsed = payload.length === 0 ? {} : JSON.parse(payload) as unknown;
    if (!response.ok) {
      const message = isRecord(parsed) && typeof parsed.message === "string"
        ? parsed.message
        : `Managed Greplica request failed (${response.status}).`;
      const error = new Error(message) as Error & { status?: number; code?: string; details?: unknown };
      error.status = response.status;
      if (isRecord(parsed) && typeof parsed.code === "string") error.code = parsed.code;
      if (isRecord(parsed)) error.details = parsed.details;
      throw error;
    }
    if (managedRepoId !== undefined && isRepositoryAccessPayload(parsed, managedRepoId)) {
      this.updateRepoAccess(managedRepoId, parsed.effective_role, parsed.access_status);
    }
    return parsed as T;
  }

  private captureRenewedToken(response: Response): void {
    const token = response.headers.get("x-greplica-token");
    if (token === null || token.length === 0) return;
    this.token = token;
    if (this.credentials !== undefined) {
      this.credentials.token = token;
      writeManagedCredentials(this.credentials);
    }
  }

  private captureRepoAccess(response: Response, managedRepoId: string): void {
    const role = response.headers.get("x-greplica-repo-role");
    const status = response.headers.get("x-greplica-access-status");
    if ((role !== "reader" && role !== "memory_admin") ||
        (status !== "active" && status !== "pending" && status !== "suspended" && status !== "revoked")) return;
    this.updateRepoAccess(managedRepoId, role, status);
  }

  private updateRepoAccess(
    managedRepoId: string,
    role: "reader" | "memory_admin" | undefined,
    status: "active" | "pending" | "suspended" | "revoked",
  ): void {
    const db = openDatabase();
    try {
      new RepoInstallationStore(db).updateManagedAccess(managedRepoId, role, status);
    } finally {
      db.close();
    }
  }
}

function isRepositoryAccessPayload(
  value: unknown,
  managedRepoId: string,
): value is { id: string; effective_role: "reader" | "memory_admin"; access_status: "active" | "pending" | "suspended" | "revoked" } {
  if (!isRecord(value) || value.id !== managedRepoId) return false;
  return (value.effective_role === "reader" || value.effective_role === "memory_admin") &&
    (value.access_status === "active" || value.access_status === "pending" ||
      value.access_status === "suspended" || value.access_status === "revoked");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
