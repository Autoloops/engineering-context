# Anchor-Drift Auto-Invalidation — Design Spec

- **Date:** 2026-07-03
- **Branch:** `feat/anchor-drift-invalidation`
- **Status:** Approved design, pending implementation

## Problem

`code_verified` claims are verified against the code exactly once — at write
time, inside `applyProposal`. After that the code keeps changing but the claim
does not. When a refactor renames, moves, or deletes an anchored symbol, the
claim stays labeled `code_verified` while pointing at code that no longer exists.

Greplica can already *detect* this (`greplica graph audit anchors`, via
`auditClaimCodeAnchors` + the tree-sitter `CodeAnchorResolver`), but detection is
read-only: it prints a report and never changes the graph. A stale "verified"
fact is worse than no fact — it hands the next agent a confident lie, which erodes
trust in the whole graph and pushes the agent back to grepping.

## Goal

Wire the existing anchor detector to a write action so drifted `code_verified`
claims are automatically demoted to `truth: unknown` (non-destructively), with a
queryable audit trail. Upgrade the meaning of `code_verified` from "was true when
saved" to "is still true now." Deterministic — the compiler (tree-sitter) is the
judge, no LLM.

## Decisions

1. **Demotion mechanism — supersede with a rebuilt claim.** Claims are
   insert-only (there are zero `UPDATE` statements on claims in the codebase);
   state changes only via supersession. So demote by writing a new claim
   (`truth: unknown`, same text/kind/intent, keeps the broken anchors as
   evidence) plus a `supersedes` edge to the original. Nothing is mutated or
   deleted; full history preserved.
2. **Trigger — opt-in CLI flag.** `greplica graph audit anchors --invalidate`.
   Default audit stays report-only, which doubles as the dry run.
3. **Audit trail — a new `invalidation_events` table.** Queryable drift history,
   surfaceable in the graph view.
4. **Drift statuses.** Demote on `missing_file`, `missing_symbol`,
   `ambiguous_symbol`. Never on `unsupported_language` (can't prove wrong),
   `resolved`, or `file_only`.
5. **Multi-anchor policy — Option A.** A claim with multiple anchors is demoted
   only when *all* its anchors fail to resolve. If ≥1 anchor still resolves the
   claim stays `code_verified`. `code_verified` therefore promises "at least one
   receipt is still valid."
6. **Scope — claims only.** Components carry a `code_anchor` but no `truth` field,
   so they are out of scope.

## Design

A service operation re-resolves every active `code_verified` claim's anchors with
a **single shared** `CodeAnchorResolver`. A claim is drifted iff it has anchors
and *every* anchor came back broken. Each drifted claim is demoted by writing a
rebuilt claim, cloning its `about`/`evidenced_by` edges onto the rebuild, and
adding a `supersedes` edge (rebuild → original). One `invalidation_events` row per
demotion. Everything lands in one memory commit + one transaction; the claim
primary key + that transaction are the integrity backstop.

### Data model

```sql
CREATE TABLE IF NOT EXISTS invalidation_events (
  id                   TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL,
  original_claim_id    TEXT NOT NULL,
  superseding_claim_id TEXT NOT NULL,
  memory_commit_id     TEXT NOT NULL,
  reason               TEXT NOT NULL,          -- 'anchor_drift'
  broken_anchor        TEXT NOT NULL,          -- 'auth.ts#validateToken'
  resolver_status      TEXT NOT NULL,          -- missing_file|missing_symbol|ambiguous_symbol
  git_commit_sha       TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invalidation_events_repo_idx ON invalidation_events(repo_id);
CREATE INDEX IF NOT EXISTS invalidation_events_claim_idx ON invalidation_events(original_claim_id);
```

`migrate()` runs `schemaSql` on every DB open, so adding the table to
`schema.ts` covers new and existing databases — no migration function needed.

### Components

- **`libs/storage/sqlite/schema.ts`** — the table DDL.
- **`libs/storage/sqlite/repository.ts`** — `applyAnchorInvalidation(...)`
  (one transaction: `createMemoryCommit` + reuse the existing private
  claim/edge/membership insert helpers + insert events) and
  `listInvalidationEvents(repoId)`.
- **`libs/knowledge-graph/code-anchors/drift.ts`** — `scanDriftedClaims(...)`:
  one shared resolver, per-claim try/continue (collect errors, never abort),
  Option-A rule (`anchors.length > 0 && anchors.every(isBroken)`).
- **`libs/knowledge-graph/anchor-invalidation.ts`** — pure
  `buildAnchorInvalidation(drifted, graph)`: builds `Map<from_id, Edge[]>` once
  (no N+1), mints rebuilt claims + cloned/supersedes edges + event inputs.
- **`libs/knowledge-graph/service.ts`** — `invalidateDriftedAnchors(repo)`
  orchestration; embeds rebuilt claims via `ensureForGraph`.
- **`apps/cli/main.ts`** — `--invalidate` flag on `graph audit anchors`.

### Integrity, performance, resilience

- **Atomicity:** single `db.transaction`; a colliding `__drift` id or any
  constraint breach rolls back the whole batch.
- **No N+1:** edge cloning uses a prebuilt `Map<from_id, Edge[]>`; detection
  reuses one resolver so shared files parse once.
- **Resilience:** a resolver error on one claim is recorded and skipped, never
  fatal to the pass.
- **Idempotency:** demoted claims leave the `code_verified` set, so re-running
  `--invalidate` is a no-op.

## Testing

`scripts/check-anchor-drift.mjs` (wired into `npm test`), deterministic, no LLM:
happy path (rename → demote + event row), Option A (one-of-two broken → no
demote; all broken → demote), `unsupported_language`/unchanged → no demote,
idempotency, edge-cloning keeps the rebuild connected, resilience on resolver
error.

## Non-goals (follow-ups)

git post-commit hook automation · auto re-anchoring to the moved symbol · the
"drop just the broken anchor" middle path · component-anchor drift · bi-temporal
`valid_at`/`invalid_at` fields.
