export interface GcStaleComponent {
  id: string;
  name: string;
  code_anchor: string;
}

export interface GcOrphanedEntity {
  id: string;
  type: "component" | "flow" | "claim";
  name?: string;
}

export interface GcDanglingEdge {
  id: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  kind: string;
  broken_end: "from" | "to";
  missing_id: string;
  missing_type: string;
}

export interface GcScanResult {
  stale_components: GcStaleComponent[];
  orphaned_components: GcOrphanedEntity[];
  orphaned_claims: GcOrphanedEntity[];
  orphaned_flows: GcOrphanedEntity[];
  dangling_edges: GcDanglingEdge[];
}

export interface GcApplyResult {
  dry_run: boolean;
  scan: GcScanResult;
  deleted: {
    components: number;
    claims: number;
    flows: number;
    edges: number;
    memberships: number;
    embeddings: number;
  };
}
