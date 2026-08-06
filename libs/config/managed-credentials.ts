import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { greplicaHome } from "./greplica-home.js";

export interface ManagedUserIdentity {
  id: string;
  githubLogin: string;
  githubUserId: string;
}

export interface ManagedCredentials {
  version: 2;
  apiUrl: string;
  token: string;
  user: ManagedUserIdentity;
}

export function managedCredentialsPath(): string {
  return join(greplicaHome(), "credentials.json");
}

export function managedToken(apiUrl: string, credentials = readManagedCredentials(apiUrl)): string | undefined {
  const environmentToken = process.env.GREPLICA_MANAGED_TOKEN ?? process.env.GREPLICA_API_TOKEN;
  if (environmentToken !== undefined) return environmentToken;
  return credentials?.apiUrl === normalizeApiUrl(apiUrl) ? credentials.token : undefined;
}

export function readManagedCredentials(apiUrl?: string, path = managedCredentialsPath()): ManagedCredentials | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    throw new Error(`Invalid Greplica credentials at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) ||
      typeof parsed.token !== "string" || !isRecord(parsed.user) ||
      (parsed.version === 2 && typeof parsed.apiUrl !== "string")) {
    throw new Error(`Invalid Greplica credentials at ${path}.`);
  }
  if (
    typeof parsed.user.id !== "string" ||
    typeof parsed.user.githubLogin !== "string" ||
    typeof parsed.user.githubUserId !== "string"
  ) {
    throw new Error(`Invalid Greplica credentials at ${path}.`);
  }
  return {
    version: 2,
    apiUrl: parsed.version === 2 && typeof parsed.apiUrl === "string"
      ? normalizeApiUrl(parsed.apiUrl)
      : normalizeApiUrl(apiUrl ?? ""),
    token: parsed.token,
    user: {
      id: parsed.user.id,
      githubLogin: parsed.user.githubLogin,
      githubUserId: parsed.user.githubUserId,
    },
  };
}

export function writeManagedCredentials(credentials: ManagedCredentials, path = managedCredentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function deleteManagedCredentials(path = managedCredentialsPath()): void {
  rmSync(path, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, "");
}
