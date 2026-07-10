export type GraphScopeId = string;
export type MemoryCommitId = string;

export type ComponentId = string;
export type FlowId = string;
export type ClaimId = string;
export type EdgeId = string;
export type SourceId = string;

export type GraphObjectType = "component" | "flow" | "claim" | "edge" | "source";

export type MembershipSubjectType = "component" | "flow" | "claim" | "edge" | "source";

export type SubjectIdByType = {
  component: ComponentId;
  flow: FlowId;
  claim: ClaimId;
  edge: EdgeId;
  source: SourceId;
};

export interface Component {
  id: ComponentId;
  name: string;
  code_anchor?: string;
}

export interface Flow {
  id: FlowId;
  name: string;
}

export type SourceKind = "session";

export interface Source {
  id: SourceId;
  kind: SourceKind;
  ref: string;
  title?: string;
}
