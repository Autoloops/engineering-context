import { execFileSync, spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  deleteManagedCredentials,
  readManagedCredentials,
} from "../../libs/config/managed-credentials.js";
import {
  ensureGreplicaConfig,
  updateManagedApiUrl,
  type GreplicaConfig,
} from "../../libs/config/greplica-config.js";
import { RepoInstallationStore } from "../../libs/install/repo-installation-store.js";
import { ManagedControlClient } from "../../libs/managed/control-client.js";
import type { ManagedRepository } from "../../libs/managed/protocol.js";
import { createLocalKnowledgeGraphService, type RepoRef } from "../../libs/knowledge-graph/service.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { fingerprintClaimAnchors } from "../../libs/knowledge-graph/code-anchors/fingerprint.js";
import { openDatabase } from "../../libs/storage/sqlite/db.js";
import { detectRepoContext } from "./repo-context.js";

export interface ManagedInstallResolution {
  repository?: ManagedRepository;
  pending: boolean;
}

export async function runLogin(args: string[]): Promise<void> {
  const apiUrl = optional(args, "--api-url");
  if (apiUrl !== undefined) updateManagedApiUrl(apiUrl);
  const config = ensureGreplicaConfig();
  const client = new ManagedControlClient(config);
  const start = await client.startDeviceLogin();
  console.log(`Open ${start.verification_uri}`);
  console.log(`GitHub code: ${start.user_code}`);
  openUrl(start.verification_uri);
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = start.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const poll = await client.pollDeviceLogin(start.device_code);
    if (poll.status === "pending") {
      interval = poll.interval;
      continue;
    }
    const previous = readManagedCredentials();
    if (previous !== undefined && previous.user.id !== poll.user.id) invalidateRoleCache();
    client.setAuthenticatedUser(poll);
    console.log(`Logged in as ${poll.user.github_login}.`);
    return;
  }
  throw new Error("GitHub device login expired. Run 'greplica login' again.");
}

export function runLogout(args: string[]): void {
  requireNoArgs(args, "Usage: greplica logout");
  deleteManagedCredentials();
  console.log("Logged out of managed Greplica on this machine.");
}

export async function runWhoami(args: string[]): Promise<void> {
  requireNoArgs(args, "Usage: greplica whoami");
  const { user } = await controlClient().whoami();
  console.log(`${user.github_login} (${user.github_user_id})`);
  console.log(`Managed user: ${user.id}`);
}

export async function runOrgCreate(args: string[]): Promise<void> {
  const organization = await controlClient().createOrg(required(args, "--name"), optional(args, "--slug"));
  printOrganization(organization);
}

export async function runOrgList(args: string[]): Promise<void> {
  requireNoArgs(args, "Usage: greplica org list");
  for (const organization of await controlClient().listOrgs()) printOrganization(organization);
}

export async function runOrgInvite(args: string[]): Promise<void> {
  const invitation = await controlClient().inviteOrgMember(required(args, "--org"), required(args, "--github-user"));
  console.log(`Invitation ${invitation.id} targets ${invitation.target_github_login}.`);
}

export async function runOrgMembers(args: string[]): Promise<void> {
  const members = await controlClient().listOrgMembers(required(args, "--org"));
  for (const member of members) console.log(`${member.user.github_login}\t${member.role}\t${member.user.id}`);
}

export async function runOrgRole(args: string[]): Promise<void> {
  const role = required(args, "--role");
  if (role !== "admin" && role !== "member" && role !== "guest") throw new Error("--role must be admin, member, or guest.");
  const member = await controlClient().updateOrgRole(required(args, "--org"), required(args, "--user"), role);
  console.log(`${member.user.github_login} is now ${member.role}.`);
}

export async function runOrgRemoveMember(args: string[]): Promise<void> {
  const result = await controlClient().removeOrgMember(required(args, "--org"), required(args, "--user"));
  console.log(result.removed ? "Organization member removed." : "Organization member was not present.");
}

export async function runOrgLeave(args: string[]): Promise<void> {
  const result = await controlClient().leaveOrg(required(args, "--org"));
  console.log(result.removed ? "Left organization." : "Organization membership was not present.");
}

export async function runInviteList(args: string[]): Promise<void> {
  requireNoArgs(args, "Usage: greplica invite list");
  for (const invite of await controlClient().listInvites()) {
    console.log(`${invite.id}\t${invite.kind}\t${invite.repo_id ?? invite.org_id}\t${invite.target_github_login}`);
  }
}

export async function runInviteAccept(args: string[]): Promise<void> {
  const invite = await controlClient().acceptInvite(requiredPositional(args, "Usage: greplica invite accept <id>"));
  console.log(`Accepted ${invite.kind} invitation ${invite.id}.`);
}

export async function runInviteRevoke(args: string[]): Promise<void> {
  const invite = await controlClient().revokeInvite(requiredPositional(args, "Usage: greplica invite revoke <id>"));
  console.log(`Revoked invitation ${invite.id}.`);
}

export async function runRepoCreate(args: string[]): Promise<void> {
  printRepository(await controlClient().createGenericRepo(required(args, "--org"), required(args, "--name")));
}

export async function runRepoList(args: string[]): Promise<void> {
  requireNoArgs(args, "Usage: greplica repo list");
  for (const repository of await controlClient().listRepos()) printRepository(repository);
}

export async function runRepoConnect(args: string[]): Promise<void> {
  const managedRepoId = required(args, "--managed-repo");
  const allowModeSwitch = args.includes("--confirm-mode-switch");
  const allowRebind = args.includes("--confirm-rebind");
  const client = controlClient();
  const repository = (await client.listRepos()).find((candidate) => candidate.id === managedRepoId);
  if (repository === undefined) throw new Error("Managed repository is not accessible.");
  const repo = detectRepoContext();
  const db = openDatabase();
  try {
    const store = new RepoInstallationStore(db);
    const existing = store.find(repo);
    if (existing === undefined) throw new Error("Run 'greplica install --mode managed' before connecting this folder.");
    const installation = store.activateManaged(repo, {
      managedRepoId: repository.id,
      managedRole: repository.effective_role,
      managedAccessStatus: repository.access_status,
      hooksEnabled: existing.hooksEnabled,
      autoMemoryUpdates: existing.autoMemoryUpdates,
      allowModeSwitch,
      allowRebind,
    });
    console.log(`Connected ${installation.repoName} to ${repository.name} (${repository.id}).`);
  } finally {
    db.close();
  }
}

export async function runRepoArchive(args: string[]): Promise<void> {
  printRepository(await controlClient().archiveRepo(repoBinding().managedRepoId));
}

export async function runRepoRestore(args: string[]): Promise<void> {
  printRepository(await controlClient().restoreRepo(repoBinding().managedRepoId));
}

export async function runRepoDiscovery(args: string[]): Promise<void> {
  const discovery = required(args, "--discovery");
  if (discovery !== "listed" && discovery !== "unlisted") throw new Error("--discovery must be listed or unlisted.");
  printRepository(await controlClient().setDiscovery(repoBinding().managedRepoId, discovery));
}

export async function runRepoGithubInstall(args: string[]): Promise<void> {
  requireNoArgs(args, "Usage: greplica repo github-install");
  const installationId = await completeGithubInstallation(controlClient());
  console.log(`GitHub App installation ${installationId} connected.`);
}

async function completeGithubInstallation(client: ManagedControlClient): Promise<string> {
  const start = await client.startGithubInstallation();
  console.log(`Open ${start.url}`);
  openUrl(start.url);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const poll = await client.pollGithubInstallation(start.setup_id);
    if (poll.status === "pending") continue;
    return poll.installation_id;
  }
  throw new Error("GitHub App installation expired. Start it again.");
}

export async function runRepoEnrollGithub(args: string[]): Promise<void> {
  printRepository(await controlClient().enrollGithubRepo(
    required(args, "--org"),
    required(args, "--installation"),
    required(args, "--github-repo"),
    optional(args, "--name"),
  ));
}

export async function runRepoLinkGithub(args: string[]): Promise<void> {
  const binding = repoBinding();
  printRepository(await controlClient().linkGithubRepo(
    binding.managedRepoId,
    required(args, "--installation"),
    required(args, "--github-repo"),
  ));
}

export async function runRepoInviteReader(args: string[]): Promise<void> {
  const invite = await controlClient().inviteRepoReader(repoBinding().managedRepoId, required(args, "--github-user"));
  console.log(`Reader invitation ${invite.id} targets ${invite.target_github_login}.`);
}

export async function runRepoGrantMemoryAdmin(args: string[]): Promise<void> {
  const grant = await controlClient().grantRepoRole(repoBinding().managedRepoId, required(args, "--user"), "memory_admin");
  console.log(`${grant.user.github_login} is now memory_admin for this memory.`);
}

export async function runRepoRevokeMemoryAdmin(args: string[]): Promise<void> {
  const result = await controlClient().revokeRepoRole(repoBinding().managedRepoId, required(args, "--user"), "memory_admin");
  console.log(result.revoked ? "memory_admin grant revoked." : "No memory_admin grant existed.");
}

export async function runRepoAccessRequest(args: string[]): Promise<void> {
  const request = await controlClient().requestAccess(required(args, "--managed-repo"));
  console.log(`Access request ${request.id} is ${request.status}.`);
}

export async function runRepoAccessList(args: string[]): Promise<void> {
  for (const request of await controlClient().listAccessRequests(repoBinding().managedRepoId)) {
    console.log(`${request.id}\t${request.status}\t${request.user.github_login}\t${request.user.id}`);
  }
}

export async function runRepoAccessDecision(args: string[], decision: "approve" | "deny"): Promise<void> {
  const request = await controlClient().decideAccessRequest(
    repoBinding().managedRepoId,
    required(args, "--request"),
    decision,
  );
  console.log(`Access request ${request.id} is ${request.status}.`);
}

export async function runRepoPublish(args: string[]): Promise<void> {
  if (!args.includes("--from-local")) throw new Error("Usage: greplica repo publish --from-local");
  const repo = detectRepoContext();
  const binding = repoBinding(repo);
  const config = ensureGreplicaConfig();
  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
  try {
    const graph = service.readGraph(repo);
    const auditResult = await service.auditCodeAnchors(repo);
    const errors = auditResult.missing_anchors.length + auditResult.missing_files.length + auditResult.missing_symbols.length +
      auditResult.ambiguous_symbols.length + auditResult.unsupported_languages.length;
    if (errors > 0) throw new Error("Local memory has invalid code anchors. Run 'greplica graph audit anchors' before publishing.");
    const fingerprints: Record<string, Record<string, string>> = {};
    for (const claim of graph.claims) {
      if (claim.code_anchors === undefined || claim.code_anchors.length === 0) continue;
      const values = await fingerprintClaimAnchors(repo.repo_root, claim.code_anchors);
      if (Object.keys(values).length > 0) fingerprints[claim.id] = values;
    }
    const result = await controlClient(config).importLocalGraph(
      binding.managedRepoId,
      graph,
      { result: auditResult, fingerprints },
      gitState(repo.repo_root),
    );
    console.log("Published one local memory snapshot into managed main memory.");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    service.close();
  }
}

export async function resolveManagedInstall(
  repo: RepoRef,
  requestedId?: string,
): Promise<ManagedInstallResolution> {
  await ensureAuthenticated();
  const client = controlClient();
  const accessible = await client.listRepos();
  if (requestedId !== undefined) {
    const repository = accessible.find((candidate) => candidate.id === requestedId);
    if (repository !== undefined) return { repository, pending: false };
    const invites = await client.listInvites();
    const invite = invites.find((candidate) => candidate.repo_id === requestedId);
    if (invite !== undefined) {
      if (!stdin.isTTY) throw new Error("Accept the targeted invitation first with 'greplica invite accept'.");
      if (await confirm(`Accept reader invitation for ${requestedId}?`)) {
        await client.acceptInvite(invite.id);
        return resolveManagedInstall(repo, requestedId);
      }
    }
    throw new Error("Requested managed repository is not accessible.");
  }

  if (!stdin.isTTY) throw new Error("Non-interactive managed installation requires --managed-repo.");
  const github = await publicGithubIdentity(repo.remote_url);
  if (github !== undefined) {
    const matches = await client.connectRepos(github.id, github.parentId);
    const accessibleIds = new Set(accessible.map((candidate) => candidate.id));
    const accessibleMatches = matches.filter((candidate) => accessibleIds.has(candidate.id));
    if (accessibleMatches.length === 1) return { repository: accessibleMatches[0], pending: false };
    if (accessibleMatches.length > 1) {
      return { repository: await chooseRepository(accessibleMatches), pending: false };
    }
    const invites = await client.listInvites();
    const invitedMatches = matches.filter((candidate) => invites.some((invite) => invite.repo_id === candidate.id));
    if (invitedMatches.length > 0) {
      const pending = invitedMatches.length === 1
        ? invitedMatches[0]
        : await chooseRepository(invitedMatches);
      const invite = invites.find((candidate) => candidate.repo_id === pending.id);
      if (invite !== undefined && await confirm(`Accept reader invitation for ${pending.name}?`)) {
        await client.acceptInvite(invite.id);
        return resolveManagedInstall(repo, pending.id);
      }
    }
    const requestable = matches.filter((candidate) => !invitedMatches.some((invited) => invited.id === candidate.id));
    if (requestable.length > 0) {
      const pending = requestable.length === 1
        ? requestable[0]
        : await chooseRepository(requestable);
      if (await confirm(`Request reader access to ${pending.name}?`)) {
        const request = await client.requestAccess(pending.id);
        console.log(`Access request ${request.id} is pending; no local repository state was created.`);
        return { pending: true };
      }
    }
  }

  if (accessible.length > 0) {
    const selected = await chooseRepository(accessible, true);
    if (selected !== undefined) return { repository: selected, pending: false };
  }

  const coordinates = githubCoordinates(repo.remote_url);
  if (coordinates !== undefined && await confirm(`Enroll GitHub memory for ${coordinates.owner}/${coordinates.repo}?`)) {
    const organization = await chooseOrCreateAdminOrganization(client);
    const installationId = await completeGithubInstallation(client);
    const githubRepositoryId = github?.parentId ?? github?.id ?? await prompt("GitHub numeric repository ID: ");
    if (githubRepositoryId.length === 0) throw new Error("GitHub repository ID is required for enrollment.");
    return {
      repository: await client.enrollGithubRepo(organization.id, installationId, githubRepositoryId, repo.repo_name),
      pending: false,
    };
  }

  if (await confirm("Create a generic managed memory now?")) {
    const organization = await chooseOrCreateAdminOrganization(client);
    const name = await prompt(`Memory name [${repo.repo_name}]: `) || repo.repo_name;
    return { repository: await client.createGenericRepo(organization.id, name), pending: false };
  }
  throw new Error("No accessible managed memory was found. Ask an org admin for an invite or enroll a repository.");
}

function controlClient(config: GreplicaConfig = ensureGreplicaConfig()): ManagedControlClient {
  return new ManagedControlClient(config);
}

async function ensureAuthenticated(): Promise<void> {
  try {
    await controlClient().whoami();
  } catch (error: unknown) {
    if (error instanceof Error && /not authenticated|invalid or expired/i.test(error.message)) {
      await runLogin([]);
      return;
    }
    throw error;
  }
}

function repoBinding(repo = detectRepoContext()): { managedRepoId: string } {
  const db = openDatabase();
  try {
    const installation = new RepoInstallationStore(db).find(repo);
    if (installation?.managedRepoId === undefined) throw new Error("This repository has no managed memory binding.");
    return { managedRepoId: installation.managedRepoId };
  } finally {
    db.close();
  }
}

async function publicGithubIdentity(remoteUrl: string | undefined): Promise<{ id: string; parentId?: string } | undefined> {
  const coordinates = githubCoordinates(remoteUrl);
  if (coordinates === undefined) return undefined;
  try {
    const response = await fetch(`https://api.github.com/repos/${coordinates.owner}/${coordinates.repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "greplica-cli" },
    });
    if (!response.ok) return undefined;
    const value = await response.json() as { id?: number; parent?: { id?: number } };
    if (typeof value.id !== "number") return undefined;
    return { id: String(value.id), parentId: typeof value.parent?.id === "number" ? String(value.parent.id) : undefined };
  } catch {
    return undefined;
  }
}

function githubCoordinates(remoteUrl: string | undefined): { owner: string; repo: string } | undefined {
  if (remoteUrl === undefined) return undefined;
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match === null ? undefined : { owner: match[1], repo: match[2] };
}

function chooseRepository(repositories: ManagedRepository[]): Promise<ManagedRepository>;
function chooseRepository(repositories: ManagedRepository[], allowCreation: true): Promise<ManagedRepository | undefined>;
async function chooseRepository(
  repositories: ManagedRepository[],
  allowCreation = false,
): Promise<ManagedRepository | undefined> {
  console.log("Available managed memory:");
  repositories.forEach((repository, index) => console.log(`${index + 1}. ${repository.name} (${repository.id})`));
  if (allowCreation) console.log(`${repositories.length + 1}. Create or enroll another memory`);
  const index = Number(await prompt("Select memory: ")) - 1;
  if (allowCreation && index === repositories.length) return undefined;
  const selected = repositories[index];
  if (selected === undefined) throw new Error("Invalid managed memory selection.");
  return selected;
}

async function chooseOrCreateAdminOrganization(client: ManagedControlClient): Promise<{ id: string; name: string }> {
  const organizations = (await client.listOrgs()).filter((organization) => organization.role === "admin");
  if (organizations.length === 1) return organizations[0];
  if (organizations.length > 1) {
    organizations.forEach((organization, index) => console.log(`${index + 1}. ${organization.name} (${organization.id})`));
    console.log(`${organizations.length + 1}. Create organization`);
    const index = Number(await prompt("Select organization: ")) - 1;
    if (index >= 0 && index < organizations.length) return organizations[index];
    if (index !== organizations.length) throw new Error("Invalid organization selection.");
  } else if (!await confirm("Create an organization for this memory?")) {
    throw new Error("Organization admin access is required to create managed memory.");
  }
  const name = await prompt("Organization name: ");
  if (name.length === 0) throw new Error("Organization name is required.");
  return client.createOrg(name);
}

async function confirm(question: string): Promise<boolean> {
  return /^(y|yes)$/i.test(await prompt(`${question} [y/N] `));
}

async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

function required(args: string[], name: string): string {
  const value = optional(args, name);
  if (value === undefined) throw new Error(`Missing ${name}.`);
  return value;
}

function optional(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
      return value;
    }
    if (args[index]?.startsWith(`${name}=`)) return args[index]?.slice(name.length + 1);
  }
  return undefined;
}

function requiredPositional(args: string[], usage: string): string {
  const value = args.find((arg) => !arg.startsWith("--"));
  if (value === undefined) throw new Error(usage);
  return value;
}

function requireNoArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new Error(usage);
}

function printOrganization(organization: { id: string; name: string; slug: string; role: string }): void {
  console.log(`${organization.name}\t${organization.role}\t${organization.id}\t${organization.slug}`);
}

function printRepository(repository: ManagedRepository): void {
  const source = repository.github_source?.full_name ?? "generic";
  console.log(`${repository.name}\t${repository.effective_role}\t${repository.access_status}\t${repository.id}\t${source}`);
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}

function invalidateRoleCache(): void {
  const db = openDatabase();
  try {
    new RepoInstallationStore(db).invalidateManagedRoleCache();
  } finally {
    db.close();
  }
}

function gitState(repoRoot: string | undefined): { git_head?: string; branch?: string; dirty?: boolean } | undefined {
  if (repoRoot === undefined) return undefined;
  const git = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  const gitHead = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const status = git(["status", "--porcelain"]);
  if (gitHead === undefined && branch === undefined && status === undefined) return undefined;
  return { git_head: gitHead || undefined, branch: branch || undefined, dirty: status !== undefined && status.length > 0 };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
