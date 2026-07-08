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

function hasContentDrift(check: AnchorCheck): boolean {
  if (isStructurallyBroken(check.anchor)) return false;
  if (check.storedHash === undefined || check.currentHash === undefined) return false;
  return check.currentHash !== check.storedHash;
}
