# Internal Prompt: Greplica GitHub Packet Ingest

This is an internal memory-build prompt used by benchmark/eval scripts. It is not an installable user skill.

Turn pre-cutoff GitHub evidence into Greplica memory. This prompt runs after a deep-bootstrap or layered-deep-bootstrap code-memory layer; it should attach historical context to an existing code-grounded graph.

## Boundaries

Allowed inputs:

- GitHub issues, pull requests, comments, reviews, and review comments created before the cutoff.
- packet files prepared by the memory-build harness.
- the checked-out source tree at the task base commit.
- existing Greplica memory for the same repo/base layer.
- for sequential benchmark tasks, packet files may cover an explicit window such as `previous_cutoff < created_at < current_cutoff`; ingest only records in the packet and preserve that window boundary.

Forbidden inputs:

- target PR/issue content created at or after the cutoff.
- records from before the packet's lower bound when the packet declares a `since_cutoff` or window.
- benchmark gold context, expected patches, scoring output, or solution transcripts.
- web search, remote docs outside the packet, git history mining, or future records.

If a record has no trustworthy creation timestamp, exclude it unless the user explicitly approves it.

When a packet declares a lower bound such as `since_cutoff`, do not go backward to older GitHub history; the parent memory layer already represents earlier evidence.

## Batch Size

Process one packet at a time. Good packet sizes are:

- 50-80 GitHub items for normal issue/PR bodies.
- fewer items when bodies, comments, reviews, or review comments are unusually long.
- enough evidence per packet that a benchmark task usually becomes roughly 5-8 packets, not dozens.
- up to roughly 100k-200k input tokens, when token estimates are available.

Write and apply one proposal per packet before moving to the next packet. Do not create one giant proposal for an entire repo history.

## Workflow

### 1. Confirm Code Layer

Run a focused query first:

```bash
greplica graph context "current repo architecture major components flows"
```

If the graph has no useful code components or anchors, stop and run deep bootstrap first. GitHub packet ingestion should not be the first memory layer.

### 2. Read The Packet

Inventory each GitHub item:

- number, URL, title, author, created/updated timestamps.
- issue or PR body.
- linked comments, reviews, and review comments.
- files, symbols, commands, config keys, tests, errors, UX/API behavior, compatibility rules, or design rationale mentioned in the discussion.

Do not create memory from the title alone. A title can help route attention, but the kept claim should come from the body, comments, review discussion, or verified code.

### 3. Extract Candidates

Keep candidates that would help future agents:

- user-visible bug reports or feature requests that describe expected behavior.
- PR rationale, design constraints, rejected alternatives, or compatibility rules.
- review comments that identify durable code ownership, missing behavior, test expectations, or edge cases.
- historical decisions that explain why a module behaves the way it does.
- issue/PR discussion that points to a code area and remains true at the base commit.
- follow-up tasks or risks that are still unresolved at the base commit.

Drop:

- title-only facts.
- issue/PR activity bookkeeping.
- stale speculation that was corrected later in the same thread.
- one-off debugging chatter.
- generic "PR existed" or "issue existed" claims.
- facts already represented well by existing memory.

### 4. Verify Code-Backed Candidates

For each candidate that mentions code behavior:

1. Query existing memory with a focused phrase from the packet.
2. Inspect the relevant source files in the base checkout.
3. If the code confirms the behavior, create a `code_verified` claim with precise `code_anchors`.
4. If the packet states a requirement, rationale, rejected alternative, or historical decision that code alone does not prove, create a `source_verified` claim with GitHub evidence.

Do not turn a source discussion into a code-verified claim just because it mentions a file. Code verification requires inspecting the source at the base commit.

## Proposal Shape

Current Greplica source schema only allows `source.kind: "session"`. Until the schema grows GitHub-specific source kinds, represent GitHub artifacts as session sources with GitHub refs:

```json
{
  "id": "source.github_pr_123",
  "kind": "session",
  "ref": "https://github.com/OWNER/REPO/pull/123",
  "title": "GitHub PR #123: concise title"
}
```

Use explicit `edges[]` for evidence. Do not use compact `claim.evidenced_by[]`, because every evidence edge needs a reason.

```json
{
  "title": "GitHub packet ingest: packet 003",
  "summary": "Pre-cutoff GitHub context from issues/PRs 120-145.",
  "creates": {
    "components": [],
    "flows": [],
    "claims": [
      {
        "id": "claim.pr_list_filter_requirement_from_issue_123",
        "kind": "requirement",
        "text": "The PR list command should preserve the user's explicit filter intent when no matching pull requests are returned.",
        "truth": "source_verified",
        "intent": "intended",
        "about": ["flow.pull_request_commands"]
      },
      {
        "id": "claim.pr_list_filter_empty_state_anchor",
        "kind": "fact",
        "text": "The PR list command decides the empty-result message after parsing user-supplied list flags.",
        "truth": "code_verified",
        "intent": "intended",
        "about": ["flow.pull_request_commands"],
        "code_anchors": [
          {
            "file": "command/pr.go",
            "symbol": "prList"
          }
        ]
      }
    ],
    "sources": [
      {
        "id": "source.github_issue_123",
        "kind": "session",
        "ref": "https://github.com/OWNER/REPO/issues/123",
        "title": "GitHub issue #123: empty PR list message"
      }
    ],
    "edges": [
      {
        "kind": "evidenced_by",
        "from": "claim.pr_list_filter_requirement_from_issue_123",
        "to": "source.github_issue_123",
        "metadata": {
          "reason": "The issue body and comments describe the expected empty-result behavior before the cutoff."
        }
      }
    ]
  }
}
```

## Anchors

For `code_verified` claims:

- prefer one stable symbol per claim.
- use two anchors for true cross-boundary facts.
- three anchors is the hard maximum and should be rare.
- a claim with four or more `code_anchors` is invalid; split it into narrower claims.
- avoid file-only anchors for normal source files.
- run `greplica graph audit anchors` after applying a packet when available.

For any claim derived from a GitHub packet record:

- create an explicit `evidenced_by` edge to the corresponding GitHub source.
- if the claim is `code_verified`, the code anchor is the truth grounding and the GitHub edge is provenance explaining why the fact was stored.
- do not create unused sources; every source in the proposal should support at least one claim.

For `source_verified` claims:

- evidence edges are required.
- code anchors are optional navigation hints only; prefer a separate `code_verified` claim when code was inspected.
- do not force code anchors onto requirements, decisions, rejected alternatives, risks, or future work.

## Supersession

Query existing memory before each packet. If a new packet clarifies, narrows, or corrects an active claim, create a superseding claim with `supersedes[]`. Do not edit the old claim in place.

When an old broad claim would require many anchors, supersede it with multiple narrower claims.

## Validate And Probe

For each packet proposal:

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors.
3. Run `greplica proposal apply <proposal-file>`.
4. Run `greplica graph audit anchors` when available.
5. Probe retrieval with 2-3 likely future queries from the packet, not the hidden benchmark task.

## Quality Bar

- No title-only claims.
- No generic "this issue/PR existed" claims.
- No future or target-task leakage.
- Most kept source claims should capture a durable requirement, decision, rationale, rejected alternative, risk, or task.
- Code-backed packet claims should be verified against the base checkout and symbol anchored.
- Prefer high-signal claims over exhaustive historical summaries, but do not impose a fixed claim-count cap.
- End with packet path, proposal path, counts of kept/dropped candidates, anchor audit status, and retrieval probes.
