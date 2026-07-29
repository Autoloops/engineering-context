import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const managedClientVersion = "0.2.1";
export const managedClientCapabilities = [
  "personal-working-v1",
  "graph-selectors-v1",
  "memory-pr-v1",
  "oidc-reconciliation-v1",
  "reconciliation-code-evidence-v1",
] as const;
export type ManagedClientCapability = (typeof managedClientCapabilities)[number];
export const managedClientVersionHeader = "x-greplica-client-version";
export const managedCapabilitiesHeader = "x-greplica-capabilities";

export const managedErrorCodes = [
  "invalid_request",
  "authentication_required",
  "forbidden",
  "not_found",
  "conflict",
  "github_pending",
  "github_denied",
  "access_pending",
  "source_suspended",
  "stale_working_head",
  "embedding_failed",
  "validation_failed",
] as const;

export type ManagedErrorCode = (typeof managedErrorCodes)[number];

export const ManagedErrorSchema = Type.Object({
  code: Type.Union(managedErrorCodes.map((code) => Type.Literal(code))),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

export const UserSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  github_user_id: Type.String(),
  github_login: Type.String(),
  created_at: Type.String({ format: "date-time" }),
});

export const OrgRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("member"),
  Type.Literal("guest"),
]);
export const RepoRoleSchema = Type.Union([
  Type.Literal("reader"),
  Type.Literal("contributor"),
  Type.Literal("memory_admin"),
]);
export const AccessStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("pending"),
  Type.Literal("suspended"),
  Type.Literal("revoked"),
]);

export const OrganizationSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  slug: Type.String(),
  name: Type.String(),
  role: OrgRoleSchema,
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

export const OrgMembershipSchema = Type.Object({
  org_id: Type.String({ format: "uuid" }),
  user: UserSchema,
  role: OrgRoleSchema,
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

export const InvitationKindSchema = Type.Union([
  Type.Literal("org_member"),
  Type.Literal("repo_reader"),
  Type.Literal("repo_contributor"),
]);
export const InvitationSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: InvitationKindSchema,
  org_id: Type.String({ format: "uuid" }),
  repo_id: Type.Optional(Type.String({ format: "uuid" })),
  target_github_user_id: Type.String(),
  target_github_login: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("revoked")]),
  created_by: Type.String({ format: "uuid" }),
  created_at: Type.String({ format: "date-time" }),
  accepted_at: Type.Optional(Type.String({ format: "date-time" })),
  revoked_at: Type.Optional(Type.String({ format: "date-time" })),
});

export const RepoInviteLinkSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  repo_id: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  created_by: Type.String({ format: "uuid" }),
  created_at: Type.String({ format: "date-time" }),
  revoked_at: Type.Optional(Type.String({ format: "date-time" })),
  claim_count: Type.Integer({ minimum: 0 }),
});

export const RepoInviteLinkCreatedSchema = Type.Object({
  link: RepoInviteLinkSchema,
  claim_url: Type.String(),
});

export const GithubSourceSchema = Type.Object({
  repository_id: Type.String(),
  owner: Type.String(),
  name: Type.String(),
  full_name: Type.String(),
  visibility: Type.Union([Type.Literal("public"), Type.Literal("private")]),
  installation_id: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("deleted")]),
  html_url: Type.Optional(Type.String()),
});

export const ManagedRepositorySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  org_id: Type.String({ format: "uuid" }),
  name: Type.String(),
  source_type: Type.Union([Type.Literal("generic"), Type.Literal("github")]),
  github_source: Type.Optional(GithubSourceSchema),
  discovery: Type.Union([Type.Literal("listed"), Type.Literal("unlisted")]),
  archived_at: Type.Optional(Type.String({ format: "date-time" })),
  effective_role: RepoRoleSchema,
  access_status: AccessStatusSchema,
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

export const RepoGrantSchema = Type.Object({
  repo_id: Type.String({ format: "uuid" }),
  user: UserSchema,
  role: RepoRoleSchema,
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

export const AccessRequestSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  repo_id: Type.String({ format: "uuid" }),
  user: UserSchema,
  status: Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"), Type.Literal("closed")]),
  created_at: Type.String({ format: "date-time" }),
  decided_at: Type.Optional(Type.String({ format: "date-time" })),
});

export const ManagedGraphViewSchema = Type.Object({
  base: Type.Literal("main"),
  working_users: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  memory_pr_id: Type.Optional(Type.String({ minLength: 1 })),
  include_quarantined: Type.Optional(Type.Boolean()),
});

export const ManagedGraphViewQuerySchema = Type.Object({
  base: Type.Optional(Type.Literal("main")),
  working_user: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))])),
  memory_pr_id: Type.Optional(Type.String({ minLength: 1 })),
  include_quarantined: Type.Optional(Type.Boolean()),
  main_only: Type.Optional(Type.Boolean()),
});

export const MemoryCommitStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("promoted"),
  Type.Literal("quarantined"),
]);
export const MemoryPrStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("awaiting_default"),
  Type.Literal("reconciling"),
  Type.Literal("merged"),
  Type.Literal("merged_with_quarantine"),
  Type.Literal("quarantined"),
]);
export const ReconciliationJobStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
]);

export const ManagedObjectOriginSchema = Type.Object({
  version_id: Type.String(),
  scope_kind: Type.Optional(Type.Union([
    Type.Literal("main"),
    Type.Literal("working"),
    Type.Literal("memory_pr"),
    Type.Literal("quarantine"),
  ])),
  scope_name: Type.Optional(Type.String()),
  author_user_id: Type.Optional(Type.String({ format: "uuid" })),
  author_github_login: Type.Optional(Type.String()),
  author_github_login_snapshot: Type.Optional(Type.String()),
  proposal_id: Type.Optional(Type.String()),
  memory_commit_id: Type.Optional(Type.String()),
  memory_commit_state: Type.Optional(MemoryCommitStateSchema),
  session_refs: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    agent_platform: Type.Optional(Type.String()),
  }))),
  agent_platform: Type.Optional(Type.String()),
  git_head: Type.Optional(Type.String()),
  head_repository: Type.Optional(Type.String()),
  head_ref: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  dirty: Type.Optional(Type.Boolean()),
  code_pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
  memory_pr_id: Type.Optional(Type.String()),
  commit_role: Type.Optional(Type.Union([
    Type.Literal("direct"),
    Type.Literal("dependency"),
    Type.Literal("repair"),
  ])),
  promotion_id: Type.Optional(Type.String()),
  quarantine_reason: Type.Optional(Type.String()),
});

export const ManagedObjectProvenanceSchema = Type.Object({
  version_id: Type.String(),
  scope_kind: Type.Union([
    Type.Literal("main"),
    Type.Literal("working"),
    Type.Literal("memory_pr"),
    Type.Literal("quarantine"),
  ]),
  scope_name: Type.Optional(Type.String()),
  author_user_id: Type.Optional(Type.String({ format: "uuid" })),
  author_github_login: Type.Optional(Type.String()),
  author_github_login_snapshot: Type.Optional(Type.String()),
  proposal_id: Type.Optional(Type.String()),
  memory_commit_id: Type.Optional(Type.String()),
  memory_commit_state: Type.Optional(MemoryCommitStateSchema),
  session_refs: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    agent_platform: Type.Optional(Type.String()),
  }))),
  agent_platform: Type.Optional(Type.String()),
  git_head: Type.Optional(Type.String()),
  head_repository: Type.Optional(Type.String()),
  head_ref: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  dirty: Type.Optional(Type.Boolean()),
  code_pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
  memory_pr_id: Type.Optional(Type.String()),
  commit_role: Type.Optional(Type.Union([
    Type.Literal("direct"),
    Type.Literal("dependency"),
    Type.Literal("repair"),
  ])),
  promotion_id: Type.Optional(Type.String()),
  quarantine_reason: Type.Optional(Type.String()),
  origins: Type.Optional(Type.Array(ManagedObjectOriginSchema)),
});

export const CodeAnchorSchema = Type.Object({
  file: Type.String(),
  symbol: Type.Optional(Type.String()),
});
export const ComponentSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  code_anchor: Type.Optional(Type.String()),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});
export const FlowSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});
export const ClaimSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("fact"),
    Type.Literal("requirement"),
    Type.Literal("decision"),
    Type.Literal("task"),
    Type.Literal("question"),
    Type.Literal("risk"),
  ]),
  text: Type.String(),
  truth: Type.Union([Type.Literal("code_verified"), Type.Literal("source_verified"), Type.Literal("unknown")]),
  intent: Type.Union([Type.Literal("intended"), Type.Literal("accidental"), Type.Literal("unknown")]),
  code_anchors: Type.Optional(Type.Array(CodeAnchorSchema)),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});
export const SourceSchema = Type.Object({
  id: Type.String(),
  kind: Type.Literal("session"),
  ref: Type.String(),
  title: Type.Optional(Type.String()),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});
export const GraphObjectTypeSchema = Type.Union([
  Type.Literal("component"),
  Type.Literal("flow"),
  Type.Literal("claim"),
  Type.Literal("edge"),
  Type.Literal("source"),
]);
export const EdgeSchema = Type.Object({
  id: Type.String(),
  from_id: Type.String(),
  from_type: GraphObjectTypeSchema,
  to_id: Type.String(),
  to_type: GraphObjectTypeSchema,
  kind: Type.Union([
    Type.Literal("about"),
    Type.Literal("contains"),
    Type.Literal("touches"),
    Type.Literal("supersedes"),
    Type.Literal("evidenced_by"),
  ]),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});

export const GraphReadSchema = Type.Object({
  components: Type.Array(ComponentSchema),
  flows: Type.Array(FlowSchema),
  claims: Type.Array(ClaimSchema),
  sources: Type.Array(SourceSchema),
  edges: Type.Array(EdgeSchema),
});

export const MemoryProposalSchema = Type.Object({}, { additionalProperties: true });

export const ReconciliationCodeEvidenceOmissionReasonSchema = Type.Union([
  Type.Literal("missing_file"),
  Type.Literal("no_resolved_span"),
  Type.Literal("sensitive_path"),
  Type.Literal("binary"),
  Type.Literal("file_too_large"),
  Type.Literal("unreadable"),
  Type.Literal("total_budget"),
  Type.Literal("submodule"),
  Type.Literal("sensitive_content"),
  Type.Literal("not_in_attested_tree"),
  Type.Literal("symlink"),
  Type.Literal("not_regular_blob"),
]);

export const AnchorAuditIssueSchema = Type.Object({
  claim_id: Type.String(),
  anchor: Type.Optional(CodeAnchorSchema),
  status: Type.Union([
    Type.Literal("missing_anchors"),
    Type.Literal("missing_file"),
    Type.Literal("missing_symbol"),
    Type.Literal("ambiguous_symbol"),
    Type.Literal("unsupported_language"),
    Type.Literal("drifted"),
    Type.Literal("unverifiable"),
  ]),
  omission_reason: Type.Optional(ReconciliationCodeEvidenceOmissionReasonSchema),
});
export const AnchorAuditSchema = Type.Object({
  missing_anchors: Type.Array(AnchorAuditIssueSchema),
  missing_files: Type.Array(AnchorAuditIssueSchema),
  missing_symbols: Type.Array(AnchorAuditIssueSchema),
  ambiguous_symbols: Type.Array(AnchorAuditIssueSchema),
  unsupported_languages: Type.Array(AnchorAuditIssueSchema),
  drifted: Type.Array(AnchorAuditIssueSchema),
  unverifiable: Type.Optional(Type.Array(AnchorAuditIssueSchema)),
});
export const ProposalAnchorAuditSchema = Type.Object({
  result: AnchorAuditSchema,
  fingerprints: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
});

export const ReconciliationCodeEvidenceAnchorSchema = Type.Object({
  file: Type.String({ minLength: 1, maxLength: 512 }),
  symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

export const ReconciliationCodeEvidenceEntrySchema = Type.Object({
  version_id: Type.String({ minLength: 1, maxLength: 512 }),
  object_type: Type.Union([Type.Literal("claim"), Type.Literal("component")]),
  anchor: ReconciliationCodeEvidenceAnchorSchema,
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("file_only"),
    Type.Literal("missing_file"),
    Type.Literal("missing_symbol"),
    Type.Literal("ambiguous_symbol"),
    Type.Literal("unsupported_language"),
    Type.Literal("omitted"),
  ]),
  normalized_path: Type.String({ minLength: 1, maxLength: 512 }),
  anchor_start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  anchor_end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  snippet_start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  snippet_end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  snippet: Type.Optional(Type.String({ maxLength: 4096 })),
  snippet_sha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  anchor_fingerprint: Type.Optional(Type.String({ pattern: "^[0-9a-f]{16}$" })),
  truncated: Type.Optional(Type.Boolean()),
  omission_reason: Type.Optional(ReconciliationCodeEvidenceOmissionReasonSchema),
});

export const ReconciliationCodeEvidenceSchema = Type.Object({
  managed_repo_id: Type.String({ format: "uuid" }),
  repository: Type.String({ minLength: 3, maxLength: 255 }),
  attested_git_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
  truncated: Type.Boolean(),
  entries: Type.Array(ReconciliationCodeEvidenceEntrySchema, { maxItems: 128 }),
  evidence_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
});

export const ProposalReviewSchema = Type.Object({
  valid: Type.Boolean(),
  errors: Type.Array(Type.String()),
  duplicate_warnings: Type.Record(
    Type.String(),
    Type.Array(Type.Object({ claim_id: Type.String(), similarity: Type.Number() })),
  ),
  working_head: Type.String(),
  working_revision: Type.Optional(Type.Integer({ minimum: 0 })),
  main_head: Type.Optional(Type.String()),
});

export const ApplyProposalResultSchema = Type.Object({
  memory_commit_id: Type.String(),
  scope_id: Type.String(),
  proposal_id: Type.Optional(Type.String()),
  author: Type.Optional(UserSchema),
  working_scope_revision: Type.Optional(Type.Integer({ minimum: 0 })),
  memory_commit_state: Type.Optional(MemoryCommitStateSchema),
  memory_pr_id: Type.Optional(Type.String()),
  embedding_status: Type.Object({
    checked_objects: Type.Integer({ minimum: 0 }),
    created: Type.Integer({ minimum: 0 }),
    reused: Type.Integer({ minimum: 0 }),
  }),
  created: Type.Object({
    components: Type.Integer({ minimum: 0 }),
    flows: Type.Integer({ minimum: 0 }),
    claims: Type.Integer({ minimum: 0 }),
    sources: Type.Integer({ minimum: 0 }),
    edges: Type.Integer({ minimum: 0 }),
  }),
});

export const EmbeddingStatusSchema = Type.Object({
  checked_objects: Type.Integer({ minimum: 0 }),
  created: Type.Integer({ minimum: 0 }),
  reused: Type.Integer({ minimum: 0 }),
});

export const GraphContextSourceSchema = Type.Object({
  id: Type.String(),
  edge_kind: Type.String(),
  weight: Type.Number(),
  score: Type.Number(),
  raw_score: Type.Number(),
});

export const ContextSignalsSchema = Type.Object({
  semantic_score: Type.Number(),
  semantic_raw_score: Type.Number(),
  semantic_rank: Type.Union([Type.Integer(), Type.Null()]),
  bm25_score: Type.Number(),
  bm25_raw_score: Type.Number(),
  bm25_rank: Type.Union([Type.Integer(), Type.Null()]),
  weighted_score: Type.Number(),
  weighted_raw_score: Type.Number(),
  pre_coherence_score: Type.Number(),
  graph_score: Type.Number(),
  graph_raw_score: Type.Number(),
  graph_sources: Type.Array(GraphContextSourceSchema),
  coherence_score: Type.Number(),
  coherence_raw_score: Type.Number(),
  coherence_sources: Type.Array(GraphContextSourceSchema),
});

export const GraphAboutSchema = Type.Object({
  type: Type.Union([Type.Literal("component"), Type.Literal("flow")]),
  id: Type.String(),
});

export const ResolvedCodeAnchorSchema = Type.Object({
  file: Type.String(),
  symbol: Type.Optional(Type.String()),
  start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("file_only"),
    Type.Literal("missing_file"),
    Type.Literal("missing_symbol"),
    Type.Literal("ambiguous_symbol"),
    Type.Literal("unsupported_language"),
  ]),
});

export const ClaimContextSchema = Type.Object({
  rank: Type.Integer({ minimum: 1 }),
  score: Type.Number(),
  signals: ContextSignalsSchema,
  object: ClaimSchema,
  about: Type.Array(GraphAboutSchema),
  evidence: Type.Array(Type.Object({ source: SourceSchema, reason: Type.String() })),
  code_anchors: Type.Array(ResolvedCodeAnchorSchema),
});

function graphObjectContextSchema<TObject extends TSchema>(object: TObject) {
  return Type.Object({
    rank: Type.Integer({ minimum: 1 }),
    score: Type.Number(),
    context_relation: Type.Union([Type.Literal("primary"), Type.Literal("additional")]),
    direct_score: Type.Number(),
    direct_raw_score: Type.Number(),
    claim_support_score: Type.Number(),
    claim_support_raw_score: Type.Number(),
    signals: ContextSignalsSchema,
    object,
    matched_claim_ids: Type.Array(Type.String()),
  });
}

export const ComponentContextSchema = graphObjectContextSchema(ComponentSchema);
export const FlowContextSchema = graphObjectContextSchema(FlowSchema);
export const RankedGraphContextSchema = Type.Union([
  Type.Intersect([Type.Object({ type: Type.Literal("component") }), ComponentContextSchema]),
  Type.Intersect([Type.Object({ type: Type.Literal("flow") }), FlowContextSchema]),
  Type.Intersect([Type.Object({ type: Type.Literal("claim") }), ClaimContextSchema]),
]);

function rankedContextDebugSchema<TObject extends TSchema>(object: TObject) {
  return Type.Object({
    rank: Type.Integer({ minimum: 1 }),
    score: Type.Number(),
    signals: ContextSignalsSchema,
    object,
    about: Type.Array(GraphAboutSchema),
  });
}

export const GraphContextSchema = Type.Object({
  query: Type.String(),
  search_config_version: Type.String(),
  embedding_status: EmbeddingStatusSchema,
  claims: Type.Array(ClaimContextSchema),
  components: Type.Array(ComponentContextSchema),
  flows: Type.Array(FlowContextSchema),
  ranked_results: Type.Array(RankedGraphContextSchema),
  sources: Type.Array(SourceSchema),
  debug: Type.Optional(Type.Object({
    ranked_results: Type.Array(RankedGraphContextSchema),
    base_ranked_claims: Type.Optional(Type.Array(rankedContextDebugSchema(ClaimSchema))),
    base_ranked_components: Type.Optional(Type.Array(rankedContextDebugSchema(ComponentSchema))),
    base_ranked_flows: Type.Optional(Type.Array(rankedContextDebugSchema(FlowSchema))),
    ranked_claims: Type.Array(rankedContextDebugSchema(ClaimSchema)),
    ranked_components: Type.Array(rankedContextDebugSchema(ComponentSchema)),
    ranked_flows: Type.Array(rankedContextDebugSchema(FlowSchema)),
  })),
});

export const GraphViewClaimRowSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  kind: Type.String(),
  session: Type.String(),
  source: Type.Union([Type.Literal("code"), Type.Literal("session")]),
  freshness: Type.Union([Type.Literal("active"), Type.Literal("superseded")]),
  componentIds: Type.Array(Type.String()),
  flowIds: Type.Array(Type.String()),
  createdAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  memoryCommitId: Type.Union([Type.String(), Type.Null()]),
  provenance: Type.Optional(ManagedObjectProvenanceSchema),
});

export const GraphViewDataSchema = Type.Object({
  generatedAt: Type.String({ format: "date-time" }),
  view: Type.Optional(ManagedGraphViewSchema),
  counts: Type.Object({
    components: Type.Integer({ minimum: 0 }),
    flows: Type.Integer({ minimum: 0 }),
    claims: Type.Integer({ minimum: 0 }),
    superseded: Type.Integer({ minimum: 0 }),
  }),
  components: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    folder: Type.String(),
    anchors: Type.Array(Type.String()),
    flowCount: Type.Integer({ minimum: 0 }),
    claimCount: Type.Integer({ minimum: 0 }),
    subcomponentCount: Type.Integer({ minimum: 0 }),
    provenance: Type.Optional(ManagedObjectProvenanceSchema),
  })),
  flows: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    folder: Type.String(),
    touchedComponentFolders: Type.Array(Type.String()),
    claimCount: Type.Integer({ minimum: 0 }),
    provenance: Type.Optional(ManagedObjectProvenanceSchema),
  })),
  claims: Type.Array(GraphViewClaimRowSchema),
  supersededClaims: Type.Array(GraphViewClaimRowSchema),
  claimsTimeline: Type.Object({
    summary: Type.Object({ total: Type.Integer({ minimum: 0 }), sessionPct: Type.Number(), codePct: Type.Number() }),
    events: Type.Array(Type.Object({
      memoryCommitId: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
      added: Type.Integer({ minimum: 0 }),
      sessionPct: Type.Number(),
      codePct: Type.Number(),
    })),
  }),
});

export const MemoryCommitMetadataSchema = Type.Object({
  git_head: Type.Optional(Type.String()),
  head_repository: Type.Optional(Type.String()),
  head_ref: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  dirty: Type.Optional(Type.Boolean()),
});

export const ProposalContextSchema = Type.Intersect([
  MemoryCommitMetadataSchema,
  Type.Object({
    session_refs: Type.Optional(Type.Array(Type.Object({
      id: Type.String(),
      agent_platform: Type.Optional(Type.String()),
    }))),
    agent_platform: Type.Optional(Type.String()),
  }),
]);

export const CodePrReferenceSchema = Type.Object({
  id: Type.Optional(Type.String()),
  number: Type.Integer({ minimum: 1 }),
  url: Type.Optional(Type.String()),
  head_repository: Type.Optional(Type.String()),
  head_ref: Type.Optional(Type.String()),
  head_sha: Type.Optional(Type.String()),
  base_ref: Type.Optional(Type.String()),
  merge_sha: Type.Optional(Type.String()),
});

export const MemoryCommitRecordSchema = Type.Object({
  id: Type.String(),
  proposal_id: Type.Optional(Type.String()),
  scope_id: Type.String(),
  scope_name: Type.String(),
  state: MemoryCommitStateSchema,
  author: UserSchema,
  author_github_login_snapshot: Type.Optional(Type.String()),
  session_refs: Type.Array(Type.Object({
    id: Type.String(),
    agent_platform: Type.Optional(Type.String()),
  })),
  agent_platform: Type.Optional(Type.String()),
  git: Type.Optional(MemoryCommitMetadataSchema),
  code_pr: Type.Optional(CodePrReferenceSchema),
  memory_pr_id: Type.Optional(Type.String()),
  created_at: Type.String({ format: "date-time" }),
  promoted_at: Type.Optional(Type.String({ format: "date-time" })),
  quarantined_at: Type.Optional(Type.String({ format: "date-time" })),
  quarantine_reason: Type.Optional(Type.String()),
});

export const ProposalRecordSchema = Type.Object({
  id: Type.String(),
  memory_commit: MemoryCommitRecordSchema,
  proposal: MemoryProposalSchema,
  anchor_audit: Type.Optional(ProposalAnchorAuditSchema),
  created_at: Type.String({ format: "date-time" }),
});

export const PromotionCleanupSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  new_main_head: Type.String(),
  canonical_memory_commit_id: Type.Optional(Type.String()),
  cleared_commit_ids: Type.Array(Type.String()),
  already_canonical_commit_ids: Type.Array(Type.String()),
  quarantined_commit_ids: Type.Array(Type.String()),
  cleared_by_user: Type.Record(Type.String(), Type.Object({
    user_id: Type.Optional(Type.String({ format: "uuid" })),
    github_login: Type.Optional(Type.String()),
    github_login_snapshots: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
    cleared_objects: Type.Integer({ minimum: 0 }),
    remaining_active_commits: Type.Optional(Type.Integer({ minimum: 0 })),
    remaining_active_objects: Type.Integer({ minimum: 0 }),
  })),
  promoted_at: Type.String({ format: "date-time" }),
});

export const MemoryPrSchema = Type.Object({
  id: Type.String(),
  code_pr: Type.Optional(CodePrReferenceSchema),
  state: MemoryPrStateSchema,
  direct_commit_ids: Type.Array(Type.String()),
  dependency_commit_ids: Type.Array(Type.String()),
  repair_commit_ids: Type.Array(Type.String()),
  contributor_logins: Type.Array(Type.String()),
  latest_job_state: Type.Optional(ReconciliationJobStateSchema),
  promotion: Type.Optional(PromotionCleanupSchema),
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

export const MemoryStatusSchema = Type.Object({
  queued: Type.Integer({ minimum: 0 }),
  running: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  action_verified: Type.Optional(Type.Boolean()),
  action_verified_at: Type.Optional(Type.String({ format: "date-time" })),
  action_workflow_ref: Type.Optional(Type.String()),
  action_workflow_sha: Type.Optional(Type.String()),
  repair_service: Type.Optional(Type.Union([
    Type.Literal("ready"),
    Type.Literal("degraded"),
  ])),
  repair_service_detail: Type.Optional(Type.String()),
  last_sweep_at: Type.Optional(Type.String({ format: "date-time" })),
  last_promotion_at: Type.Optional(Type.String({ format: "date-time" })),
  repair_attempts: Type.Integer({ minimum: 0 }),
  repaired_commits: Type.Integer({ minimum: 0 }),
  promoted_commits: Type.Integer({ minimum: 0 }),
  quarantined_commits: Type.Integer({ minimum: 0 }),
  cleared_working_commits: Type.Integer({ minimum: 0 }),
  remaining_active_working_commits: Type.Integer({ minimum: 0 }),
});

export const ReconciliationCandidateSchema = Type.Object({
  memory_pr_id: Type.String(),
  merge_sha: Type.String({ minLength: 7 }),
  code_merge_sha: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{40}$" })),
  code_evidence_required: Type.Optional(Type.Literal(true)),
  memory_commit_ids: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
  commits: Type.Array(Type.Object({
    memory_commit_id: Type.String(),
    git_head: Type.String({ minLength: 7 }),
    head_repository: Type.Optional(Type.String()),
    head_ref: Type.Optional(Type.String()),
    proof_mode: Type.Optional(Type.Union([
      Type.Literal("pr_head"),
      Type.Literal("default_ancestry"),
    ])),
    code_pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
    verified_head_sha: Type.Optional(Type.String({ minLength: 7 })),
    verified_base_sha: Type.Optional(Type.String({ minLength: 7 })),
  }), { minItems: 1 }),
  claim_versions: Type.Array(Type.Object({
    version_id: Type.String(),
    claim: ClaimSchema,
    baseline_fingerprints: Type.Optional(Type.Record(Type.String(), Type.String())),
  })),
  component_versions: Type.Optional(Type.Array(Type.Object({
    version_id: Type.String(),
    component: ComponentSchema,
    baseline_fingerprints: Type.Optional(Type.Record(Type.String(), Type.String())),
  }))),
});

export const ReconciliationProofSchema = Type.Object({
  memory_commit_id: Type.String(),
  git_head: Type.String({ minLength: 7 }),
  is_ancestor: Type.Boolean(),
  proof_mode: Type.Optional(Type.Union([
    Type.Literal("pr_head"),
    Type.Literal("default_ancestry"),
  ])),
  verified_head_sha: Type.Optional(Type.String({ minLength: 7 })),
  verified_base_sha: Type.Optional(Type.String({ minLength: 7 })),
});

export const ReconciliationAttestationSchema = Type.Object({
  managed_repo_id: Type.String({ format: "uuid" }),
  repository: Type.String({ minLength: 3 }),
  merge_sha: Type.String({ minLength: 7 }),
  code_merge_sha: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{40}$" })),
  code_merge_is_ancestor: Type.Optional(Type.Boolean()),
  code_evidence: Type.Optional(ReconciliationCodeEvidenceSchema),
  memory_pr_id: Type.String(),
  memory_commit_ids: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
  ancestry: Type.Array(ReconciliationProofSchema, { minItems: 1 }),
  audit_key: Type.Literal("version_id"),
  anchor_audit: ProposalAnchorAuditSchema,
  observed_default_head_sha: Type.Optional(Type.String({ minLength: 7 })),
  ref: Type.Optional(Type.String()),
  run_id: Type.Optional(Type.String()),
  run_attempt: Type.Optional(Type.String()),
});

export const ReconciliationAttestationResultSchema = Type.Object({
  accepted: Type.Boolean(),
  memory_pr_id: Type.Optional(Type.String()),
  job_id: Type.Optional(Type.String()),
  state: Type.Optional(ReconciliationJobStateSchema),
});

export const ReconciliationRejectionSchema = Type.Object({
  managed_repo_id: Type.String({ format: "uuid" }),
  repository: Type.String({ minLength: 3 }),
  merge_sha: Type.String({ minLength: 7 }),
  code_merge_sha: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{40}$" })),
  code_merge_is_ancestor: Type.Optional(Type.Boolean()),
  memory_pr_id: Type.String(),
  memory_commit_ids: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
  rejected_memory_commit_ids: Type.Array(Type.String(), { uniqueItems: true }),
  ancestry: Type.Array(ReconciliationProofSchema, { minItems: 1 }),
  reason: Type.Union([
    Type.Literal("code_merge_not_ancestor"),
    Type.Literal("git_head_not_ancestor"),
    Type.Literal("git_head_not_in_pr_delta"),
  ]),
  observed_default_head_sha: Type.String({ minLength: 7 }),
  ref: Type.Optional(Type.String()),
  run_id: Type.Optional(Type.String()),
  run_attempt: Type.Optional(Type.String()),
});

export const ReconciliationRejectionResultSchema = Type.Object({
  accepted: Type.Boolean(),
  memory_pr_id: Type.String(),
  removed_commit_ids: Type.Optional(Type.Array(Type.String())),
  remaining_commit_ids: Type.Optional(Type.Array(Type.String())),
});

export const routeSchemas = {
  authDeviceStart: route(Type.Object({}), Type.Object({
    device_code: Type.String(),
    user_code: Type.String(),
    verification_uri: Type.String(),
    expires_in: Type.Integer(),
    interval: Type.Integer(),
  })),
  authDevicePoll: route(Type.Object({ device_code: Type.String() }), Type.Union([
    Type.Object({ status: Type.Literal("pending"), interval: Type.Integer() }),
    Type.Object({ status: Type.Literal("complete"), token: Type.String(), user: UserSchema }),
  ])),
  authMe: route(Type.Object({}), Type.Object({ user: UserSchema })),
  orgCreate: route(Type.Object({ name: Type.String({ minLength: 1 }), slug: Type.Optional(Type.String()) }), OrganizationSchema),
  orgList: route(Type.Object({}), Type.Array(OrganizationSchema)),
  orgInvite: route(Type.Object({ github_user: Type.String({ minLength: 1 }) }), InvitationSchema),
  orgMembers: route(Type.Object({}), Type.Array(OrgMembershipSchema)),
  orgRole: route(Type.Object({ user_id: Type.String({ format: "uuid" }), role: OrgRoleSchema }), OrgMembershipSchema),
  orgRemoveMember: route(Type.Object({ user_id: Type.String({ format: "uuid" }) }), Type.Object({ removed: Type.Boolean() })),
  orgLeave: route(Type.Object({}), Type.Object({ removed: Type.Boolean() })),
  inviteList: route(Type.Object({}), Type.Array(InvitationSchema)),
  inviteAccept: route(Type.Object({}), InvitationSchema),
  inviteRevoke: route(Type.Object({}), InvitationSchema),
  githubInstallStart: route(Type.Object({}), Type.Object({ setup_id: Type.String({ format: "uuid" }), url: Type.String(), state: Type.String() })),
  githubInstallPoll: route(Type.Object({ setup_id: Type.String({ format: "uuid" }) }), Type.Union([
    Type.Object({ status: Type.Literal("pending") }),
    Type.Object({ status: Type.Literal("complete"), installation_id: Type.String() }),
  ])),
  repoCreate: route(Type.Object({ org_id: Type.String({ format: "uuid" }), name: Type.String({ minLength: 1 }) }), ManagedRepositorySchema),
  repoList: route(Type.Object({}), Type.Array(ManagedRepositorySchema)),
  repoConnect: route(Type.Object({
    repo_key: Type.Optional(Type.String()),
    github_repository_id: Type.Optional(Type.String()),
    upstream_github_repository_id: Type.Optional(Type.String()),
  }), Type.Array(ManagedRepositorySchema)),
  repoEnrollGithub: route(Type.Object({
    org_id: Type.String({ format: "uuid" }),
    installation_id: Type.String(),
    github_repository_id: Type.String(),
    name: Type.Optional(Type.String()),
  }), ManagedRepositorySchema),
  repoLinkGithub: route(Type.Object({ installation_id: Type.String(), github_repository_id: Type.String() }), ManagedRepositorySchema),
  repoArchive: route(Type.Object({}), ManagedRepositorySchema),
  repoRestore: route(Type.Object({}), ManagedRepositorySchema),
  repoInvite: route(Type.Object({
    github_user: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.Union([Type.Literal("reader"), Type.Literal("contributor")])),
  }), InvitationSchema),
  repoInviteLinkCreate: route(Type.Object({}), RepoInviteLinkCreatedSchema),
  repoInviteLinkList: route(Type.Object({}), Type.Array(RepoInviteLinkSchema)),
  repoInviteLinkRevoke: route(Type.Object({}), RepoInviteLinkSchema),
  repoInviteLinkClaim: route(Type.Object({ token: Type.String({ minLength: 43, maxLength: 43 }) }), ManagedRepositorySchema),
  repoGrant: route(Type.Object({ user_id: Type.String({ format: "uuid" }), role: RepoRoleSchema }), RepoGrantSchema),
  repoRevokeGrant: route(Type.Object({ user_id: Type.String({ format: "uuid" }), role: RepoRoleSchema }), Type.Object({ revoked: Type.Boolean() })),
  accessRequestCreate: route(Type.Object({}), AccessRequestSchema),
  accessRequestList: route(Type.Object({}), Type.Array(AccessRequestSchema)),
  accessRequestDecision: route(Type.Object({ decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]) }), AccessRequestSchema),
  graphRead: route(ManagedGraphViewQuerySchema, GraphReadSchema),
  graphContext: route(Type.Object({
    query: Type.String({ minLength: 1 }),
    view: Type.Optional(ManagedGraphViewSchema),
  }), GraphContextSchema),
  graphViewData: route(ManagedGraphViewQuerySchema, GraphViewDataSchema),
  graphAnchorData: route(Type.Object({}), Type.Object({
    claims: Type.Array(ClaimSchema),
    fingerprints: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
  })),
  proposalReview: route(Type.Object({
    proposal: MemoryProposalSchema,
    anchor_audit: ProposalAnchorAuditSchema,
    context: Type.Optional(ProposalContextSchema),
  }), ProposalReviewSchema),
  proposalApply: route(Type.Object({
    proposal: MemoryProposalSchema,
    working_head: Type.String(),
    working_revision: Type.Optional(Type.Integer({ minimum: 0 })),
    main_head: Type.Optional(Type.String()),
    anchor_audit: ProposalAnchorAuditSchema,
    commit: Type.Optional(MemoryCommitMetadataSchema),
    context: Type.Optional(ProposalContextSchema),
  }), ApplyProposalResultSchema),
  proposalList: route(Type.Object({}), Type.Array(ProposalRecordSchema)),
  proposalShow: route(Type.Object({}), ProposalRecordSchema),
  memoryPrList: route(Type.Object({}), Type.Array(MemoryPrSchema)),
  memoryPrShow: route(Type.Object({}), MemoryPrSchema),
  memoryPrRetry: route(Type.Object({}), MemoryPrSchema),
  memoryStatus: route(Type.Object({}), MemoryStatusSchema),
  reconciliationCandidate: route(
    Type.Object({
      merge_sha: Type.String({ minLength: 7 }),
      exclude_memory_pr: Type.Optional(Type.Union([
        Type.String({ minLength: 1 }),
        Type.Array(Type.String({ minLength: 1 })),
      ])),
    }),
    ReconciliationCandidateSchema,
  ),
  reconciliationAttest: route(ReconciliationAttestationSchema, ReconciliationAttestationResultSchema),
  reconciliationReject: route(ReconciliationRejectionSchema, ReconciliationRejectionResultSchema),
  repoImport: route(Type.Object({
    graph: GraphReadSchema,
    anchor_audit: ProposalAnchorAuditSchema,
    commit: Type.Optional(MemoryCommitMetadataSchema),
  }), ApplyProposalResultSchema),
} as const;

export type ManagedUser = Static<typeof UserSchema>;
export type ManagedOrganization = Static<typeof OrganizationSchema>;
export type ManagedOrgMembership = Static<typeof OrgMembershipSchema>;
export type ManagedInvitation = Static<typeof InvitationSchema>;
export type ManagedRepoInviteLink = Static<typeof RepoInviteLinkSchema>;
export type ManagedRepoInviteLinkCreated = Static<typeof RepoInviteLinkCreatedSchema>;
export type ManagedRepository = Static<typeof ManagedRepositorySchema>;
export type ManagedRepoGrant = Static<typeof RepoGrantSchema>;
export type ManagedAccessRequest = Static<typeof AccessRequestSchema>;
export type ManagedGraphRead = Static<typeof GraphReadSchema>;
export type ManagedGraphContext = Static<typeof GraphContextSchema>;
export type ManagedGraphViewData = Static<typeof GraphViewDataSchema>;
export type ManagedProposalReview = Static<typeof ProposalReviewSchema>;
export type ManagedGraphView = Static<typeof ManagedGraphViewSchema>;
export type ManagedObjectOrigin = Static<typeof ManagedObjectOriginSchema>;
export type ManagedObjectProvenance = Static<typeof ManagedObjectProvenanceSchema>;
export type ManagedMemoryCommit = Static<typeof MemoryCommitRecordSchema>;
export type ManagedProposal = Static<typeof ProposalRecordSchema>;
export type ManagedMemoryPr = Static<typeof MemoryPrSchema>;
export type ManagedMemoryStatus = Static<typeof MemoryStatusSchema>;
export type ManagedPromotionCleanup = Static<typeof PromotionCleanupSchema>;
export type ManagedReconciliationCodeEvidenceEntry = Static<typeof ReconciliationCodeEvidenceEntrySchema>;
export type ManagedReconciliationCodeEvidence = Static<typeof ReconciliationCodeEvidenceSchema>;
export type ManagedReconciliationAttestation = Static<typeof ReconciliationAttestationSchema>;
export type ManagedReconciliationCandidate = Static<typeof ReconciliationCandidateSchema>;
export type ManagedReconciliationAttestationResult = Static<typeof ReconciliationAttestationResultSchema>;
export type ManagedReconciliationRejection = Static<typeof ReconciliationRejectionSchema>;
export type ManagedReconciliationRejectionResult = Static<typeof ReconciliationRejectionResultSchema>;

function route<TRequest extends TSchema, TResponse extends TSchema>(request: TRequest, response: TResponse) {
  return { request, response, error: ManagedErrorSchema } as const;
}
