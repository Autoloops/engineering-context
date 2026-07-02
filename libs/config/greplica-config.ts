import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { greplicaHome } from "./greplica-home.js";

export type EmbeddingProvider = "local" | "openai";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  batchSize: number;
}

export interface GreplicaConfig {
  version: 1;
  embedding: EmbeddingConfig;
  session: SessionConfig;
}

export interface SessionConfig {
  stopThreshold: number;
  timeThresholdMinutes: number;
  currentGraceMinutes: number;
  autoMemoryUpdates: boolean;
}

export interface EmbeddingConfigInput {
  provider: EmbeddingProvider;
  model?: string;
  dimensions?: number;
  batchSize?: number;
}

const embeddingDefaults: Record<EmbeddingProvider, EmbeddingConfig> = {
  local: {
    provider: "local",
    model: "all-mpnet-base-v2",
    dimensions: 768,
    batchSize: 16,
  },
  openai: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    batchSize: 100,
  },
};

export const defaultSessionConfig: SessionConfig = {
  stopThreshold: 7,
  timeThresholdMinutes: 40,
  currentGraceMinutes: 5,
  autoMemoryUpdates: true,
};

export const defaultGreplicaConfig: GreplicaConfig = {
  version: 1,
  embedding: { ...embeddingDefaults.local },
  session: { ...defaultSessionConfig },
};

export function defaultEmbeddingConfig(provider: EmbeddingProvider): EmbeddingConfig {
  return { ...embeddingDefaults[provider] };
}

export function greplicaConfigPath(): string {
  return join(greplicaHome(), "config.json");
}

export function ensureGreplicaConfig(path = greplicaConfigPath()): GreplicaConfig {
  if (!existsSync(path)) {
    writeGreplicaConfig(defaultGreplicaConfig, path);
    return cloneConfig(defaultGreplicaConfig);
  }
  return readGreplicaConfig(path);
}

export function readGreplicaConfig(path = greplicaConfigPath()): GreplicaConfig {
  if (!existsSync(path)) return cloneConfig(defaultGreplicaConfig);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Greplica config at ${path}: ${message}`);
  }

  return normalizeConfig(parsed, path);
}

export function writeGreplicaConfig(config: GreplicaConfig, path = greplicaConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function updateEmbeddingConfig(input: EmbeddingConfigInput, path = greplicaConfigPath()): GreplicaConfig {
  const existing = readGreplicaConfig(path);
  const base = defaultEmbeddingConfig(input.provider);
  const config: GreplicaConfig = {
    version: 1,
    embedding: {
      ...base,
      model: input.model ?? base.model,
      dimensions: input.dimensions ?? base.dimensions,
      batchSize: input.batchSize ?? base.batchSize,
    },
    session: existing.session,
  };
  writeGreplicaConfig(config, path);
  return config;
}

function normalizeConfig(value: unknown, path: string): GreplicaConfig {
  if (!isRecord(value)) throw new Error(`Invalid Greplica config at ${path}: expected an object.`);
  const version = value.version === undefined ? 1 : value.version;
  if (version !== 1) throw new Error(`Invalid Greplica config at ${path}: unsupported version ${String(version)}.`);

  const embeddingValue = value.embedding;
  if (!isRecord(embeddingValue)) {
    return cloneConfig(defaultGreplicaConfig);
  }

  const provider = parseProvider(embeddingValue.provider, path);
  const defaults = defaultEmbeddingConfig(provider);
  const model = parseString(embeddingValue.model, defaults.model, "embedding.model", path);
  const dimensions = parsePositiveInteger(embeddingValue.dimensions, defaults.dimensions, "embedding.dimensions", path);
  const batchSize = parsePositiveInteger(embeddingValue.batchSize, defaults.batchSize, "embedding.batchSize", path);
  const session = normalizeSessionConfig(value.session, path);

  return {
    version: 1,
    embedding: {
      provider,
      model,
      dimensions,
      batchSize,
    },
    session,
  };
}

function normalizeSessionConfig(value: unknown, path: string): SessionConfig {
  if (value === undefined) return { ...defaultSessionConfig };
  if (!isRecord(value)) throw new Error(`Invalid Greplica config at ${path}: session must be an object.`);
  return {
    stopThreshold: parsePositiveInteger(value.stopThreshold, defaultSessionConfig.stopThreshold, "session.stopThreshold", path),
    timeThresholdMinutes: parsePositiveInteger(
      value.timeThresholdMinutes,
      defaultSessionConfig.timeThresholdMinutes,
      "session.timeThresholdMinutes",
      path,
    ),
    currentGraceMinutes: parsePositiveInteger(
      value.currentGraceMinutes,
      defaultSessionConfig.currentGraceMinutes,
      "session.currentGraceMinutes",
      path,
    ),
    autoMemoryUpdates: parseBoolean(value.autoMemoryUpdates, defaultSessionConfig.autoMemoryUpdates, "session.autoMemoryUpdates", path),
  };
}

function parseProvider(value: unknown, path: string): EmbeddingProvider {
  if (value === "local" || value === "openai") return value;
  if (value === undefined) return defaultGreplicaConfig.embedding.provider;
  throw new Error(`Invalid Greplica config at ${path}: embedding.provider must be local or openai.`);
}

function parseString(value: unknown, fallback: string, field: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`Invalid Greplica config at ${path}: ${field} must be a non-empty string.`);
}

function parsePositiveInteger(value: unknown, fallback: number, field: string, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`Invalid Greplica config at ${path}: ${field} must be a positive integer.`);
}

function parseBoolean(value: unknown, fallback: boolean, field: string, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`Invalid Greplica config at ${path}: ${field} must be a boolean.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: GreplicaConfig): GreplicaConfig {
  return {
    version: config.version,
    embedding: { ...config.embedding },
    session: { ...config.session },
  };
}
