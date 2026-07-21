import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface RepoIdentityInput {
  repo_root?: string;
  remote_url?: string;
}

export function canonicalRepoKey(input: RepoIdentityInput): string {
  if (input.remote_url !== undefined && input.remote_url.trim().length > 0) {
    return `git:${canonicalRemote(input.remote_url)}`;
  }
  if (input.repo_root !== undefined && input.repo_root.trim().length > 0) {
    return `path:${canonicalRepoPath(input.repo_root)}`;
  }
  throw new Error("Repo memory needs either a remote URL or a root path.");
}

export function canonicalRepoPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function canonicalRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/^git\+/, "");
  const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp !== null && !trimmed.includes("://") && !looksLikeWindowsPath(trimmed)) {
    return normalizeRemoteParts(scp[1], scp[2]);
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "file:") return `file${canonicalRepoPath(decodeURIComponent(url.pathname))}`;
    return normalizeRemoteParts(url.hostname, url.pathname, url.port);
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

function normalizeRemoteParts(host: string, rawPath: string, port = ""): string {
  const normalizedHost = host.toLowerCase();
  const normalizedPort = port.length > 0 && !isDefaultPort(port) ? `:${port}` : "";
  let path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (normalizedHost === "github.com") path = path.toLowerCase();
  return `${normalizedHost}${normalizedPort}/${path}`;
}

function isDefaultPort(port: string): boolean {
  return port === "22" || port === "80" || port === "443";
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}
