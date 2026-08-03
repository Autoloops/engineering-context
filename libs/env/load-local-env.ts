import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv(file = ".env.local"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;

  loadEnvFile(path);
}

export interface LoadedEnvFile {
  path: string;
  loaded_keys: string[];
  skipped_existing_keys: string[];
}

export interface LoadedRepoEnv {
  repo_root: string;
  initial_env_keys: Set<string>;
  files: LoadedEnvFile[];
}

export type EnvVarSource =
  | { kind: "environment" }
  | { kind: "file"; path: string };

export function loadRepoEnv(repoRoot: string): LoadedRepoEnv {
  const initialEnvKeys = new Set(Object.keys(process.env).filter(hasEnvValue));
  const repoEnvKeys = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]);
  const files = [".env.local", ".env"]
    .map((file) => loadEnvFile(resolve(repoRoot, file), repoEnvKeys))
    .filter((file): file is LoadedEnvFile => file !== undefined);

  return {
    repo_root: repoRoot,
    initial_env_keys: initialEnvKeys,
    files,
  };
}

export function envVarSource(name: string, env: LoadedRepoEnv): EnvVarSource | undefined {
  if (env.initial_env_keys.has(name) && hasEnvValue(name)) return { kind: "environment" };
  const loadedFromFile = env.files.find((file) => file.loaded_keys.includes(name));
  if (loadedFromFile) return { kind: "file", path: loadedFromFile.path };
  return hasEnvValue(name) ? { kind: "environment" } : undefined;
}

function loadEnvFile(path: string, allowedKeys?: ReadonlySet<string>): LoadedEnvFile | undefined {
  if (!existsSync(path)) return undefined;

  const loadedKeys: string[] = [];
  const skippedExistingKeys: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (hasEnvValue(key)) {
      skippedExistingKeys.push(key);
      continue;
    }
    process.env[key] = unquoteEnvValue(rawValue ?? "");
    loadedKeys.push(key);
  }

  return {
    path,
    loaded_keys: loadedKeys,
    skipped_existing_keys: skippedExistingKeys,
  };
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasEnvValue(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value.trim().length > 0;
}
