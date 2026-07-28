import type { Claim } from "./claim.js";
import type { GraphReadResult } from "./service.js";

export type MaybePromise<T> = T | Promise<T>;

export interface ClaimProvenanceRecord {
  claim_id: string;
  created_at: string;
  memory_commit_id: string;
}

export interface GraphReadRepository {
  readGraphView(repoId: string): MaybePromise<GraphReadResult>;
  readSupersededClaims(repoId: string): MaybePromise<Claim[]>;
  readClaimProvenance(repoId: string): MaybePromise<ClaimProvenanceRecord[]>;
  readClaimAnchorFingerprints(repoId: string, ids: string[]): MaybePromise<Map<string, Record<string, string>>>;
}

export interface ManagedGraphWriteMetadata {
  actorUserId?: string;
  gitHead?: string;
  branch?: string;
  dirty?: boolean;
}
