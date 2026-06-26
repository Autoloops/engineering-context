import type { ClaimId } from "./schema.js";

export type ClaimKind =
  | "fact"
  | "requirement"
  | "decision"
  | "task"
  | "question"
  | "risk";

export type ClaimTruth = "code_verified" | "source_verified" | "unknown";

export type ClaimIntent = "intended" | "accidental" | "unknown";

export interface ClaimCodeAnchor {
  file: string;
  symbol?: string;
}

export interface Claim {
  id: ClaimId;
  kind: ClaimKind;
  text: string;
  truth: ClaimTruth;
  intent: ClaimIntent;
  code_anchors?: ClaimCodeAnchor[];
}
