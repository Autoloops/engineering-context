import type { ResolvedCodeAnchor, ResolvedCodeAnchorStatus } from "./types.js";

export type StaleReason = "structural" | "content";

export interface AnchorCheck {
  anchor: ResolvedCodeAnchor;
  storedHash: string | undefined;
  currentHash: string | undefined;
}

const structuralStatuses: ReadonlySet<ResolvedCodeAnchorStatus> = new Set([
  "missing_file",
  "missing_symbol",
  "ambiguous_symbol",
]);

/** Return why a claim is proven stale, or undefined when staleness is not proven. */
export function classifyStale(checks: AnchorCheck[]): StaleReason | undefined {
  if (checks.length === 0) return undefined;
  if (checks.every((check) => isStructurallyBroken(check.anchor))) return "structural";
  if (checks.some(hasContentDrift)) return "content";
  return undefined;
}

export function isStructurallyBroken(anchor: ResolvedCodeAnchor): boolean {
  return structuralStatuses.has(anchor.status);
}

/** True when both hashes are known and the current anchor code no longer matches the baseline. */
export function anchorContentDrift(
  storedHash: string | undefined,
  currentHash: string | undefined,
): boolean {
  if (storedHash === undefined || currentHash === undefined) return false;
  return currentHash !== storedHash;
}

function hasContentDrift(check: AnchorCheck): boolean {
  if (isStructurallyBroken(check.anchor)) return false;
  return anchorContentDrift(check.storedHash, check.currentHash);
}
