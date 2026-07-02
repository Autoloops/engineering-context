import { z } from "zod";

/**
 * Boundary schemas for the MCP tools. These validate the *shape* of agent input
 * and give clients typed hints. Deep semantic validation (edge direction rules,
 * code-anchor resolution) stays in KnowledgeGraphService and is not duplicated here.
 */

const repoRoot = z
  .string()
  .min(1)
  .describe("Absolute path to the target repository. Defaults to GREPLICA_REPO_ROOT, then the working directory.");

const stringOrStringArray = z.union([z.string().min(1), z.array(z.string().min(1))]);

const codeAnchorInput = z.object({
  file: z.string().min(1).describe("Repository-relative file path. No absolute paths or line numbers."),
  symbol: z.string().min(1).optional().describe('Optional symbol, e.g. "ClassName.method".'),
});

const claimKind = z.enum(["fact", "requirement", "decision", "task", "question", "risk"]);
const claimTruth = z.enum(["code_verified", "source_verified", "unknown"]);
const claimIntent = z.enum(["intended", "accidental", "unknown"]);
const edgeKind = z.enum(["about", "contains", "touches", "supersedes", "evidenced_by"]);

const componentInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  code_anchor: z.string().min(1).optional(),
  contains: stringOrStringArray.optional(),
  supersedes: stringOrStringArray.optional(),
});

const flowInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contains: stringOrStringArray.optional(),
  touches: stringOrStringArray.optional(),
  supersedes: stringOrStringArray.optional(),
});

const claimInput = z.object({
  id: z.string().min(1),
  kind: claimKind,
  text: z.string().min(1),
  truth: claimTruth,
  intent: claimIntent,
  code_anchors: z.array(codeAnchorInput).max(3).optional(),
  about: stringOrStringArray.optional(),
  evidenced_by: stringOrStringArray.optional(),
  supersedes: stringOrStringArray.optional(),
});

const sourceInput = z.object({
  id: z.string().min(1),
  kind: z.literal("session"),
  ref: z.string().min(1),
  title: z.string().min(1).optional(),
});

const edgeInput = z.object({
  kind: edgeKind,
  from: z.string().min(1),
  to: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const proposalSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1).optional(),
    creates: z.object({
      components: z.array(componentInput).optional(),
      flows: z.array(flowInput).optional(),
      claims: z.array(claimInput).optional(),
      sources: z.array(sourceInput).optional(),
      edges: z.array(edgeInput).optional(),
    }),
  })
  .describe("Greplica memory proposal (compact form). Deep semantic validation runs server-side.");

// ---- Tool input schemas ----

export const queryContextInput = z.object({
  query: z.string().min(1).describe("Natural-language question to retrieve repository memory for."),
  repo_root: repoRoot.optional(),
  debug: z.boolean().default(false).describe("Also return the full retrieval payload with ranking signals."),
});

export const proposalInput = z.object({
  proposal: proposalSchema,
  repo_root: repoRoot.optional(),
});

export const repoScopedInput = z.object({
  repo_root: repoRoot.optional(),
});

export type QueryContextInput = z.infer<typeof queryContextInput>;
export type ProposalInput = z.infer<typeof proposalInput>;
export type RepoScopedInput = z.infer<typeof repoScopedInput>;

// ---- Tool output schemas ----

const nonNegativeInt = z.number().int().nonnegative();

const embeddingStatus = z.object({
  checked_objects: nonNegativeInt,
  created: nonNegativeInt,
  reused: nonNegativeInt,
});

export const queryContextOutput = z.object({
  markdown: z.string(),
});

export const validateProposalOutput = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});

export const applyProposalOutput = z.object({
  memory_commit_id: z.string(),
  scope_id: z.string(),
  created: z.object({
    components: nonNegativeInt,
    flows: nonNegativeInt,
    claims: nonNegativeInt,
    sources: nonNegativeInt,
    edges: nonNegativeInt,
  }),
  embedding_status: embeddingStatus,
});

const anchorIssue = z.object({
  claim_id: z.string(),
  file: z.string().optional(),
  symbol: z.string().optional(),
});

export const auditAnchorsOutput = z.object({
  issue_count: nonNegativeInt,
  missing_anchors: z.array(anchorIssue),
  missing_files: z.array(anchorIssue),
  missing_symbols: z.array(anchorIssue),
  ambiguous_symbols: z.array(anchorIssue),
  unsupported_languages: z.array(anchorIssue),
});

export type AuditAnchorsOutput = z.infer<typeof auditAnchorsOutput>;
