import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ManagedReconciliationCodeEvidence,
  ManagedReconciliationCodeEvidenceEntry,
} from "../../managed/protocol.js";
import type { ClaimCodeAnchor } from "../claim.js";
import { fingerprintAnchor } from "./fingerprint.js";
import { CodeAnchorResolver } from "./resolver.js";

export const reconciliationCodeEvidenceLimits = {
  maxEntries: 128,
  maxPathBytes: 512,
  maxSymbolBytes: 512,
  maxSnippetBytes: 4_096,
  maxSnippetLines: 80,
  maxTotalSnippetBytes: 65_536,
  maxReadableFileBytes: 1_048_576,
} as const;

export interface VersionedCodeAnchor {
  versionId: string;
  objectType: "claim" | "component";
  anchor: ClaimCodeAnchor;
}

export interface BuildReconciliationCodeEvidenceInput {
  managedRepoId: string;
  repository: string;
  attestedGitSha: string;
  anchors: VersionedCodeAnchor[];
}

export type ReconciliationCodeEvidencePayload =
  Omit<ManagedReconciliationCodeEvidence, "evidence_sha256">;
type OmissionReason = NonNullable<ManagedReconciliationCodeEvidenceEntry["omission_reason"]>;

interface AttestedTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

/**
 * Build a bounded, deterministic packet from the exact clean checkout used by
 * reconciliation. Only candidate-provided anchors are inspected; this function
 * never scans the repository for content or writes it.
 */
export async function buildReconciliationCodeEvidence(
  repoRoot: string,
  input: BuildReconciliationCodeEvidenceInput,
): Promise<ManagedReconciliationCodeEvidence> {
  validateEnvelope(input);
  const canonicalRoot = realpathSync(resolve(repoRoot));
  assertExactEvidenceCheckout(canonicalRoot, input.attestedGitSha);

  const anchors = normalizeAndDedupeAnchors(input.anchors);
  if (anchors.length > reconciliationCodeEvidenceLimits.maxEntries) {
    throw new Error(
      `Reconciliation code evidence exceeds ${reconciliationCodeEvidenceLimits.maxEntries} unique anchors.`,
    );
  }

  const resolver = new CodeAnchorResolver();
  const treeEntries = attestedTreeEntriesForAnchors(
    canonicalRoot,
    input.attestedGitSha,
    anchors,
  );
  const entries: ManagedReconciliationCodeEvidenceEntry[] = [];
  let remainingSnippetBytes = reconciliationCodeEvidenceLimits.maxTotalSnippetBytes;
  let packetTruncated = false;

  for (const item of anchors) {
    const entry = await evidenceForAnchor(
      canonicalRoot,
      item,
      resolver,
      remainingSnippetBytes,
      treeEntries,
    );
    entries.push(entry);
    const snippetBytes = entry.snippet === undefined ? 0 : Buffer.byteLength(entry.snippet, "utf8");
    remainingSnippetBytes -= snippetBytes;
    if (
      entry.truncated === true ||
      entry.status === "omitted" ||
      entry.omission_reason === "sensitive_path" ||
      entry.omission_reason === "binary" ||
      entry.omission_reason === "file_too_large" ||
      entry.omission_reason === "unreadable" ||
      entry.omission_reason === "total_budget"
    ) {
      packetTruncated = true;
    }
  }

  const packet: ReconciliationCodeEvidencePayload = {
    managed_repo_id: input.managedRepoId,
    repository: input.repository,
    attested_git_sha: input.attestedGitSha.toLowerCase(),
    truncated: packetTruncated,
    entries,
  };
  return {
    ...packet,
    evidence_sha256: reconciliationCodeEvidenceHash(packet),
  };
}

/** Hash the canonical packet payload, intentionally excluding the hash field. */
export function reconciliationCodeEvidenceHash(
  packet: ReconciliationCodeEvidencePayload,
): string {
  return createHash("sha256").update(canonicalJson(packet), "utf8").digest("hex");
}

/** Verify the packet's canonical root hash without trusting its field order. */
export function hasValidReconciliationCodeEvidenceHash(
  packet: ManagedReconciliationCodeEvidence,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(packet.evidence_sha256)) return false;
  const { evidence_sha256, ...payload } = packet;
  return timingSafeEqual(
    Buffer.from(evidence_sha256, "hex"),
    Buffer.from(reconciliationCodeEvidenceHash(payload), "hex"),
  );
}

/**
 * Whether an entry can authorize repair against its exact transmitted subset.
 * Unresolved and omitted entries are diagnostic only. Even resolved/file-only
 * entries need a verified snippet and current checkout fingerprint.
 */
export function isReconciliationCodeEvidenceEntryActionable(
  entry: ManagedReconciliationCodeEvidenceEntry,
): boolean {
  if (
    entry.status !== "resolved" &&
    entry.status !== "file_only"
  ) {
    return false;
  }
  if (
    entry.snippet === undefined ||
    entry.snippet_sha256 === undefined ||
    entry.anchor_fingerprint === undefined
  ) {
    return false;
  }
  const actualSnippetHash = createHash("sha256").update(entry.snippet, "utf8").digest("hex");
  return entry.snippet_sha256 === actualSnippetHash;
}

function validateEnvelope(input: BuildReconciliationCodeEvidenceInput): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.managedRepoId)) {
    throw new Error("Reconciliation code evidence requires a valid managed repository UUID.");
  }
  if (
    input.repository.length < 3 ||
    input.repository.length > 255 ||
    !/^[^/\s]+\/[^/\s]+$/.test(input.repository)
  ) {
    throw new Error("Reconciliation code evidence requires an owner/repository name.");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.attestedGitSha)) {
    throw new Error("Reconciliation code evidence requires a full 40-character Git SHA.");
  }
}

function normalizeAndDedupeAnchors(anchors: VersionedCodeAnchor[]): VersionedCodeAnchor[] {
  const deduped = new Map<string, VersionedCodeAnchor>();
  for (const item of anchors) {
    if (
      item.versionId.length === 0 ||
      Buffer.byteLength(item.versionId, "utf8") > 512
    ) {
      throw new Error("Reconciliation code evidence version IDs must be 1-512 UTF-8 bytes.");
    }
    const file = normalizeAnchorPath(item.anchor.file);
    const symbol = normalizeAnchorSymbol(item.anchor.symbol);
    const normalized: VersionedCodeAnchor = {
      versionId: item.versionId,
      objectType: item.objectType,
      anchor: {
        file,
        ...(symbol === undefined ? {} : { symbol }),
      },
    };
    const key = JSON.stringify([
      normalized.versionId,
      normalized.objectType,
      normalized.anchor.file,
      normalized.anchor.symbol ?? "",
    ]);
    deduped.set(key, normalized);
  }
  return [...deduped.values()].sort(compareVersionedAnchors);
}

function normalizeAnchorPath(file: string): string {
  if (
    file.length === 0 ||
    file.includes("\0") ||
    file.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(file) ||
    isAbsolute(file) ||
    /^[a-zA-Z]:/.test(file) ||
    Buffer.byteLength(file, "utf8") > reconciliationCodeEvidenceLimits.maxPathBytes
  ) {
    throw new Error(`Unsafe reconciliation code anchor path: ${JSON.stringify(file)}.`);
  }
  const normalized = posix.normalize(file);
  const segments = file.split("/");
  if (
    normalized !== file ||
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Reconciliation code anchor path is not normalized: ${JSON.stringify(file)}.`);
  }
  return normalized;
}

function normalizeAnchorSymbol(symbol: string | undefined): string | undefined {
  if (symbol === undefined) return undefined;
  if (
    symbol.length === 0 ||
    symbol.includes("\0") ||
    Buffer.byteLength(symbol, "utf8") > reconciliationCodeEvidenceLimits.maxSymbolBytes
  ) {
    throw new Error("Reconciliation code anchor symbols must be 1-512 UTF-8 bytes.");
  }
  return symbol;
}

async function evidenceForAnchor(
  repoRoot: string,
  item: VersionedCodeAnchor,
  resolver: CodeAnchorResolver,
  remainingSnippetBytes: number,
  treeEntries: Map<string, AttestedTreeEntry>,
): Promise<ManagedReconciliationCodeEvidenceEntry> {
  const base = {
    version_id: item.versionId,
    object_type: item.objectType,
    anchor: item.anchor,
    normalized_path: item.anchor.file,
  } as const;
  if (crossesGitlink(item.anchor.file, treeEntries)) {
    return omitted(base, "submodule");
  }
  const treeEntry = treeEntries.get(item.anchor.file);
  if (treeEntry?.mode === "120000") return omitted(base, "symlink");
  const contained = resolveContainedPath(repoRoot, item.anchor.file);
  if (!contained.exists) {
    return {
      ...base,
      status: "missing_file",
      omission_reason: "missing_file",
    };
  }
  if (treeEntry === undefined) return omitted(base, "not_in_attested_tree");
  if (
    treeEntry.type !== "blob" ||
    (treeEntry.mode !== "100644" && treeEntry.mode !== "100755")
  ) {
    return omitted(base, "not_regular_blob");
  }
  if (isSensitivePath(item.anchor.file) || isSensitivePath(contained.realRelativePath)) {
    return omitted(base, "sensitive_path");
  }
  if (crossesNestedGitRepository(repoRoot, item.anchor.file)) {
    return omitted(base, "submodule");
  }

  let stats;
  try {
    stats = statSync(contained.realPath);
  } catch {
    return omitted(base, "unreadable");
  }
  if (!stats.isFile()) return omitted(base, "not_regular_blob");

  const blobSize = attestedBlobSize(repoRoot, treeEntry.objectId);
  if (blobSize > reconciliationCodeEvidenceLimits.maxReadableFileBytes) {
    return omitted(base, "file_too_large");
  }
  if (stats.size !== blobSize) {
    throw new Error(
      `Reconciliation code anchor ${item.anchor.file} does not match its attested Git blob.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readAttestedBlob(repoRoot, treeEntry.objectId);
  } catch {
    return omitted(base, "unreadable");
  }
  let workingBytes: Buffer;
  try {
    workingBytes = readFileSync(contained.realPath);
  } catch {
    return omitted(base, "unreadable");
  }
  if (!workingBytes.equals(bytes)) {
    throw new Error(
      `Reconciliation code anchor ${item.anchor.file} does not match its attested Git blob.`,
    );
  }
  if (looksBinary(bytes)) return omitted(base, "binary");

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return omitted(base, "binary");
  }
  if (containsHighConfidenceSecret(source)) {
    return omitted(base, "sensitive_content");
  }

  const resolved = await resolver.resolve(repoRoot, item.anchor);
  if (resolved.status !== "resolved" && resolved.status !== "file_only") {
    return {
      ...base,
      status: resolved.status,
      ...(resolved.start_line === undefined ? {} : { anchor_start_line: resolved.start_line }),
      ...(resolved.end_line === undefined ? {} : { anchor_end_line: resolved.end_line }),
      omission_reason: resolved.status === "missing_file" ? "missing_file" : "no_resolved_span",
    };
  }

  const records = sourceLineRecords(source);
  if (records.length === 0) {
    return {
      ...base,
      status: resolved.status,
      ...(resolved.start_line === undefined ? {} : { anchor_start_line: resolved.start_line }),
      ...(resolved.end_line === undefined ? {} : { anchor_end_line: resolved.end_line }),
      omission_reason: "no_resolved_span",
    };
  }
  const anchorStart = resolved.status === "resolved"
    ? clampLine(resolved.start_line ?? 1, records.length)
    : 1;
  const anchorEnd = resolved.status === "resolved"
    ? clampLine(resolved.end_line ?? anchorStart, records.length)
    : records.length;
  const requestedStart = resolved.status === "resolved" ? Math.max(1, anchorStart - 2) : 1;
  const requestedEnd = resolved.status === "resolved"
    ? Math.min(records.length, anchorEnd + 2)
    : records.length;
  const lineEnd = Math.min(
    requestedEnd,
    requestedStart + reconciliationCodeEvidenceLimits.maxSnippetLines - 1,
  );
  const selected = records.slice(requestedStart - 1, lineEnd).join("");
  const entryBudget = Math.min(
    reconciliationCodeEvidenceLimits.maxSnippetBytes,
    remainingSnippetBytes,
  );
  if (entryBudget === 0) {
    return {
      ...base,
      status: "omitted",
      anchor_start_line: anchorStart,
      anchor_end_line: anchorEnd,
      truncated: true,
      omission_reason: "total_budget",
    };
  }
  const snippet = utf8Prefix(selected, entryBudget);
  if (snippet.length === 0) {
    return {
      ...base,
      status: "omitted",
      anchor_start_line: anchorStart,
      anchor_end_line: anchorEnd,
      truncated: true,
      omission_reason: "total_budget",
    };
  }
  const snippetBytes = Buffer.byteLength(snippet, "utf8");
  const truncatedByLines = lineEnd < requestedEnd;
  const truncatedByBytes = snippetBytes < Buffer.byteLength(selected, "utf8");
  const truncatedByTotalBudget =
    remainingSnippetBytes < reconciliationCodeEvidenceLimits.maxSnippetBytes &&
    truncatedByBytes;
  const snippetEnd = requestedStart + representedLineCount(snippet) - 1;
  const fingerprint = await fingerprintAnchor(repoRoot, item.anchor, resolver);

  return {
    ...base,
    status: resolved.status,
    anchor_start_line: anchorStart,
    anchor_end_line: anchorEnd,
    snippet_start_line: requestedStart,
    snippet_end_line: snippetEnd,
    snippet,
    snippet_sha256: createHash("sha256").update(snippet, "utf8").digest("hex"),
    ...(fingerprint === undefined ? {} : { anchor_fingerprint: fingerprint }),
    ...(!truncatedByLines && !truncatedByBytes ? {} : { truncated: true }),
    ...(truncatedByTotalBudget ? { omission_reason: "total_budget" as const } : {}),
  };
}

function resolveContainedPath(
  repoRoot: string,
  normalizedPath: string,
): { exists: boolean; realPath: string; realRelativePath: string } {
  const lexicalPath = join(repoRoot, ...normalizedPath.split("/"));
  assertContained(repoRoot, lexicalPath, "lexical");
  let current = repoRoot;
  for (const segment of normalizedPath.split("/")) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) {
        return {
          exists: false,
          realPath: lexicalPath,
          realRelativePath: normalizedPath,
        };
      }
      throw new Error(`Cannot inspect reconciliation code anchor ${normalizedPath}.`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Reconciliation code anchor ${normalizedPath} escapes the repository or crosses a symlink boundary.`,
      );
    }
    let realCurrent: string;
    try {
      realCurrent = realpathSync(current);
    } catch {
      throw new Error(`Cannot resolve reconciliation code anchor ${normalizedPath}.`);
    }
    assertContained(repoRoot, realCurrent, "real");
  }
  const realPath = realpathSync(lexicalPath);
  assertContained(repoRoot, realPath, "real");
  return {
    exists: true,
    realPath,
    realRelativePath: relative(repoRoot, realPath).split(sep).join("/"),
  };
}

function attestedTreeEntriesForAnchors(
  repoRoot: string,
  attestedGitSha: string,
  anchors: VersionedCodeAnchor[],
): Map<string, AttestedTreeEntry> {
  const prefixes = new Set<string>();
  for (const { anchor } of anchors) {
    const segments = anchor.file.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      prefixes.add(segments.slice(0, index).join("/"));
    }
  }
  if (prefixes.size === 0) return new Map();
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-tree",
        "-z",
        "--full-tree",
        attestedGitSha,
        "--",
        ...[...prefixes].sort().map((prefix) => `:(literal)${prefix}`),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("Cannot inspect the attested Git tree for reconciliation code evidence.");
  }
  const entries = new Map<string, AttestedTreeEntry>();
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator === -1) {
      throw new Error("Attested Git tree returned malformed code evidence metadata.");
    }
    const metadata = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (metadata.length !== 3 || metadata.some((value) => value.length === 0)) {
      throw new Error("Attested Git tree returned malformed code evidence metadata.");
    }
    entries.set(path, {
      mode: metadata[0],
      type: metadata[1],
      objectId: metadata[2],
      path,
    });
  }
  return entries;
}

function crossesGitlink(
  normalizedPath: string,
  treeEntries: Map<string, AttestedTreeEntry>,
): boolean {
  const segments = normalizedPath.split("/");
  for (let index = 1; index <= segments.length; index += 1) {
    if (treeEntries.get(segments.slice(0, index).join("/"))?.mode === "160000") {
      return true;
    }
  }
  return false;
}

function attestedBlobSize(repoRoot: string, objectId: string): number {
  let output: string;
  try {
    output = execFileSync("git", ["-C", repoRoot, "cat-file", "-s", objectId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Cannot inspect an attested Git blob for reconciliation code evidence.");
  }
  const size = Number(output);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Attested Git blob has an invalid size.");
  }
  return size;
}

function readAttestedBlob(repoRoot: string, objectId: string): Buffer {
  return execFileSync("git", ["-C", repoRoot, "cat-file", "blob", objectId], {
    encoding: "buffer",
    maxBuffer: reconciliationCodeEvidenceLimits.maxReadableFileBytes + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function crossesNestedGitRepository(repoRoot: string, normalizedPath: string): boolean {
  let current = repoRoot;
  for (const segment of normalizedPath.split("/")) {
    current = join(current, segment);
    try {
      lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw new Error(`Cannot inspect repository boundary for code anchor ${normalizedPath}.`);
    }
    const realCurrent = realpathSync(current);
    assertContained(repoRoot, realCurrent, "real");
    let stats;
    try {
      stats = statSync(realCurrent);
    } catch {
      return false;
    }
    if (!stats.isDirectory()) continue;
    try {
      lstatSync(join(realCurrent, ".git"));
      return true;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error(`Cannot inspect nested repository boundary for code anchor ${normalizedPath}.`);
      }
    }
  }
  return false;
}

function assertContained(repoRoot: string, candidate: string, kind: "lexical" | "real"): void {
  const pathFromRoot = relative(repoRoot, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Reconciliation code anchor escapes the repository (${kind} path).`);
  }
}

function isSensitivePath(file: string): boolean {
  const segments = file.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.includes(".git") ||
    segments.includes(".ssh") ||
    segments.includes(".aws") ||
    segments.includes(".gnupg") ||
    segments.includes(".kube")
  ) {
    return true;
  }
  if (
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    basename === "credentials" ||
    basename === "credentials.json" ||
    basename === "secret.json" ||
    basename === "secrets.json" ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(basename) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(basename)
  ) {
    return true;
  }
  if (/^\.env(?:\.|$)/.test(basename)) {
    return !/\.(?:example|sample|template)$/.test(basename);
  }
  return false;
}

function looksBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.1;
}

function containsHighConfidenceSecret(source: string): boolean {
  const secretPatterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{20,}\b/,
    /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  ];
  return secretPatterns.some((pattern) => pattern.test(source));
}

function sourceLineRecords(source: string): string[] {
  if (source.length === 0) return [];
  return source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((record) => record.length > 0) ?? [];
}

function utf8Prefix(value: string, maxBytes: number): string {
  let used = 0;
  let prefix = "";
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    prefix += character;
    used += bytes;
  }
  return prefix;
}

function representedLineCount(snippet: string): number {
  const newlines = snippet.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlines + (/(?:\r\n|\r|\n)$/.test(snippet) ? 0 : 1);
}

function clampLine(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, value));
}

function omitted(
  base: {
    version_id: string;
    object_type: "claim" | "component";
    anchor: ClaimCodeAnchor;
    normalized_path: string;
  },
  reason: OmissionReason,
): ManagedReconciliationCodeEvidenceEntry {
  return {
    ...base,
    status: "omitted",
    truncated: true,
    omission_reason: reason,
  };
}

function compareVersionedAnchors(left: VersionedCodeAnchor, right: VersionedCodeAnchor): number {
  return compareStrings(left.versionId, right.versionId) ||
    compareStrings(left.objectType, right.objectType) ||
    compareStrings(left.anchor.file, right.anchor.file) ||
    compareStrings(left.anchor.symbol ?? "", right.anchor.symbol ?? "");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactEvidenceCheckout(repoRoot: string, attestedGitSha: string): void {
  const git = (arguments_: string[]): string => execFileSync("git", ["-C", repoRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const head = git(["rev-parse", "HEAD"]).toLowerCase();
  if (head !== attestedGitSha.toLowerCase()) {
    throw new Error(
      `Reconciliation code evidence checkout ${head} does not equal attested SHA ${attestedGitSha}.`,
    );
  }
  if (git(["status", "--porcelain", "--untracked-files=all"]).length > 0) {
    throw new Error("Reconciliation code evidence requires a clean exact-SHA checkout.");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot canonicalize undefined reconciliation evidence.");
  return serialized;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
