import { createHash } from "node:crypto";
import type { ClaimCodeAnchor } from "../claim.js";
import { CodeAnchorResolver } from "./resolver.js";

/**
 * Fingerprints the code a claim anchor points to, so a stored fact can later be
 * compared against the current code to detect drift. The comment-free signature
 * of the anchored span is produced by the tree-sitter resolver, so reformatting
 * and comment edits do not change the fingerprint while real changes (including
 * a literal value such as a threshold going 3 -> 8) do.
 */

/** Stable identifier for an anchor, used as the key when storing fingerprints. */
export function anchorFingerprintKey(anchor: ClaimCodeAnchor): string {
  return anchor.symbol === undefined ? anchor.file : `${anchor.file}#${anchor.symbol}`;
}

/**
 * Return the fingerprint of a single anchor, or `undefined` when the anchor
 * cannot be resolved to stable content (missing file, missing/ambiguous symbol,
 * or an unsupported language). Callers treat `undefined` as "not comparable"
 * rather than as drift.
 */
export async function fingerprintAnchor(
  repoRoot: string | undefined,
  anchor: ClaimCodeAnchor,
  resolver: CodeAnchorResolver,
): Promise<string | undefined> {
  const signature = await resolver.codeSignatureForAnchor(repoRoot, anchor);
  return signature === undefined ? undefined : hashText(signature);
}

/**
 * Fingerprint every anchor of a claim, keyed by {@link anchorFingerprintKey}.
 * Anchors that cannot be resolved are omitted so they are never mistaken for
 * drift; broken anchors are surfaced separately by the anchor audit.
 */
export async function fingerprintClaimAnchors(
  repoRoot: string | undefined,
  anchors: ClaimCodeAnchor[] | undefined,
  resolver: CodeAnchorResolver = new CodeAnchorResolver(),
): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const anchor of anchors ?? []) {
    const hash = await fingerprintAnchor(repoRoot, anchor, resolver);
    if (hash !== undefined) fingerprints[anchorFingerprintKey(anchor)] = hash;
  }
  return fingerprints;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
