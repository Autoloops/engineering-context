---
name: greplica-update-working-memory
description: Update Greplica working memory from the current coding-agent session, recent code changes, and durable decisions. Use only when the user explicitly invokes greplica-update-working-memory or asks to update working memory.
disable-model-invocation: true
---

# Update Greplica Working Memory

Update working memory with durable information learned during this coding session.

## Preconditions

Run from the target repository root, a subdirectory inside it, or a non-Git folder that should have its own memory.

Do not run `greplica doctor` as a routine preflight. Run the needed Greplica commands directly; if one fails, use the error to decide whether `greplica doctor` would help diagnose installation, target detection, or embedding-provider configuration.

If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.

If a Greplica command reports that Greplica is not installed for this repo, tell the user to run the Greplica setup prompt from the README inside this repo.

Local embeddings are the default and do not require `OPENAI_API_KEY`. If Greplica is configured for OpenAI and a command reports that `OPENAI_API_KEY` is missing, stop. Do not ask the user to paste the key into chat. Tell them to set it in their shell before launching the coding agent, or in target-root `.env.local`.

## Gather Evidence

Use the current conversation/session context plus code evidence. Read:

- `git status --short`
- `git diff --stat`
- focused `git diff` for changed areas
- files touched by the session when needed to verify claims
- existing relevant memory with `greplica graph context "<task or changed area>"`
- code-anchor audit with `greplica graph audit anchors` when the installed Greplica version supports it

Use the current session as context, but verify durable code facts against files or diffs when possible.

Transcript evidence can produce useful memory, but it has different roles:

- user decisions, constraints, rejected alternatives, and future-work boundaries can become `source_verified` session claims.
- explored repo paths can become memory only when they explain ownership, a cross-component flow, a confusing distinction, or a location future agents would otherwise rediscover.
- tool outputs containing file paths, symbols, line numbers, or Greplica anchors are navigation clues, not proof by themselves.
- convert a transcript clue into a `code_verified` claim only after checking the current file/diff and adding a precise `code_anchors` entry.
- when a session decision, rationale, constraint, trade-off, or future-work claim points at a concrete code area, include `code_anchors` as navigation hints if you verified those anchors. The session source remains the evidence for the decision; the anchors tell future agents where the related code lives.
- if a transcript mentions an issue, PR, review, or comment packet, store the durable fact from the packet content, not a title-only summary.

The update proposal must preserve the session delta, not just the final patch. A useful update usually has separate memories for:

- the explored route or pre-existing behavior that made the problem understandable.
- the behavior or contract that changed.
- the scope rule that limits where the new behavior applies.
- the exact approaches, artifact types, or representations the session rejected.
- the future workflow or capability that was discussed but deliberately left unbuilt.
- the older memory that is now too broad and needs `supersedes[]`.

If one of those buckets has explicit session evidence and existing memory is missing or too vague, include it as a focused claim. A proposal that only describes the final implementation is incomplete when the session's decisions depended on old behavior, rejected alternatives, or deferred work.

Update-working-memory is not a second bootstrap, and it is not diff-only. Preserve durable context from the route the agent explored when that context shaped the work or would save a future agent from rediscovering where behavior lives. Do not rescan the whole repository's documentation just because curated docs exist. Only inspect curated context that was edited, explicitly cited, or needed to understand a decision made during the session. For those files, read the relevant before/after content carefully. Use `git ls-files` when needed to identify tracked curated files anywhere in the repository:

- files whose basename starts with `README`
- files named `AGENTS.md`
- files named `CLAUDE.md`
- files named `CONTEXT.md`
- files whose basename starts with `CONTRIBUTING`
- Markdown or MDX files under any `docs/` directory

Do not treat `skills/**/SKILL.md` files as generic curated context. Skill files are often agent workflow instructions, and ingesting them wholesale creates noisy memory. Only inspect them when the session actually changed, used, or discussed that skill's behavior, and still summarize only the durable delta.

For touched or explicitly used curated docs, preserve the changed or newly relied-on facts when they fit one of these durable categories:

- **What this repo is**: product purpose, audience, core concepts, and major architecture boundaries.
- **How to work in it**: setup, run, test, build, eval, required tools, environment, services, and local workflow gotchas.
- **Rules to preserve**: agent instructions, coding/repo conventions, invariants, compatibility/security/privacy constraints, and do-not guidance.
- **Interfaces and contracts**: public CLI/API/config/file formats, integration behavior, schemas, protocols, and examples that define expected behavior.
- **Why things are this way**: explicit decisions, rationale, rejected alternatives, historical context, roadmap, future work, and known risks.

Do not store raw documentation prose. Distill changed or newly discovered curated-doc content into focused claims, and preserve removals or corrections when they change what future agents should believe. If a doc fact was already true before the session and was not used to make a decision, leave it for bootstrap memory instead of duplicating it here.

When curated docs or session decisions contain repo-wide facts, create or reuse `component.repository`:

```json
{
  "id": "component.repository",
  "name": "Repository",
  "code_anchor": "README.md"
}
```

Use `component.repository` as the `about` target for claims that apply to the whole repository or workspace, such as:

- what the repo is, its product purpose, audience, and main value.
- monorepo layout, major package families, ownership boundaries, and where docs/source/examples live.
- root setup/build/test/lint/eval commands, package manager requirements, local prerequisites, env vars, services, and ports.
- PR rules, changesets, commit conventions, branch rules, and review requirements.
- root AGENTS.md/CLAUDE.md guidance, search-before-edit rules, docs-update rules, and safety constraints.
- cross-cutting coding, generated-file, docs, naming, testing, compatibility, security, privacy, versioning, and release rules.
- repo-wide risks, gotchas, rationale, history, roadmap, and non-goals.

Do not attach package, module, service, endpoint, or function-specific claims to `component.repository`; create or reuse a narrower component or flow for those.

In update-working-memory, do not create `component.repository` as a default bucket. Reuse or create it only when the kept claim is a true standing repo-wide rule, identity fact, global workflow, or repository-level rationale. A one-off verification checklist, eval run summary, or session process note should usually be dropped or attached to the narrower flow/component it governs.

When you have a transcript file, run this transcript extraction workflow before writing the proposal:

1. Get the transcript line count, then read every line in chunks if needed.
2. Build a scratch candidate inventory from the transcript before relying on code diffs or final assistant summaries. Do this even when the final patch is small.
3. Put candidates into buckets: explored navigation path, pre-session behavior discovered, changed behavior, changed or relied-on curated-doc facts, user constraints, rationale, trade-offs/rejected alternatives, negative decisions/do-not-do rules, deferred work/future work, drift, naming collisions/terminology distinctions, eval/fixture/testing/process constraints, and old memory that may need superseding.
4. For each candidate, record the source line/message, intended memory role, whether it should be code_verified, source_verified, unknown, or dropped, whether it was already present in existing memory, and whether it needs an explicit `supersedes[]` link.
5. Treat explored existing repo facts as required memory when they were non-obvious, affected the design, would save future navigation, and are missing or too vague in existing memory. Do not drop a useful fact only because the final patch did not edit that exact code path.
6. Store the explored path as durable navigation knowledge only when it explains the system: which component owns behavior, which flow crosses boundaries, which similarly named concept is not the same thing, where the source of truth lives, or which apparently relevant path was ruled out. Do not store a raw list of files opened, commands run, search terms, or transient debugging steps.
7. If explored evidence came from outside the target repository, store it only when it defines a durable external contract, dependency behavior, operational constraint, or user-approved rationale that future repo work must preserve. Otherwise keep repository memory focused on this codebase.
8. Drop only candidates that are transient, duplicate without session clarification, unsupported, trivial to rediscover from the immediately edited file, or not useful to a future agent.
9. Keep explicit user corrections, "do not" statements, "not built" statements, naming collisions, rejected alternatives, future-work boundaries, and eval/process constraints unless they are clearly transient.
10. Write one focused claim per kept durable candidate. Do not merge candidates from different buckets into one broad claim. In particular, keep "where the agent had to look", "how it worked before", "how it works now", "where the new behavior applies", "why this shape was chosen", "what exact representation was rejected", and "what remains future work" as separate claims when the session contains separate evidence for them.
11. Before validating, review dropped candidates and re-add any durable explored context or session decision that would be hard to recover from code alone.

Prioritize user messages and final accepted decisions over assistant suggestions. Search around terms such as `source`, `evidence`, `session`, `reason`, `metadata`, `future`, `next`, `later`, `out of scope`, `not built`, `proposal`, `eval`, `fixture`, `rubric`, `wrong`, `reject`, `don't`, and `instead`.

When creating a session source, derive its identity from the actual session:

- If a transcript file is available, read its session metadata first. For Codex JSONL transcripts, use `session_meta.payload.id`; also use `session_meta.payload.source` or `session_meta.payload.originator` to identify the session kind when present.
- Build a stable source ID from that metadata, for example `source.codex_session.<session_id_slug>` or `source.claude_code_session.<session_id_slug>`. Slug the session ID by lowercasing it and replacing non-alphanumeric characters with `_`.
- Set `ref` to a stable reference such as `codex-session:<session-id>` or `claude-code-session:<session-id>`, and set `title` to a concise human-readable session title.
- Do not use generic IDs like `source.current_session` when a session ID or transcript identity is available.

Before writing the proposal, scan the session against this checklist:

- What existing repo behavior did the agent discover before editing?
- What path through the repository did the agent have to understand, and is that path useful durable navigation knowledge?
- What was true before this session, and what is true after this session?
- What code facts changed?
- What cross-component flows changed?
- What constraints did the user impose?
- What rationale explains why the code was shaped this way?
- What trade-offs or alternatives were discussed, rejected, or deferred?
- What provenance, evidence, storage, API, workflow, or implementation approaches were explicitly rejected or postponed?
- What drift did the implementation introduce without an explicit durable decision?
- What terms, model concepts, or type names were easy to confuse?
- What old memory was too broad, incomplete, or newly qualified by the session?
- What process or eval constraints should future agents preserve?
- What tasks remain?
- What future work was explicitly discussed?

Skip a category when the session has no clear evidence for it. Do not invent future work from implementation gaps; future work should be explicit in the session or clearly stated as a deferred part of the larger plan.

When the session changes how a system represents or exposes information, capture both sides if they matter to future agents: the old behavior that was replaced or found insufficient, and the new behavior that now exists. This applies generically to storage, retrieval, provenance, validation, public APIs, config, workflows, and generated artifacts.

When the user rejects an approach, store the rejection as a durable decision or constraint if future agents might reasonably try it again. Preserve the exact rejected shape, not only a broader category. For example, if the session rejects a snapshot, commit-state marker, raw artifact, metadata field, command, source type, schema shape, or automation path, record that rejected representation separately from the chosen implementation.

When the session says a workflow, command, automation path, ingestion path, adapter, protocol, or migration was discussed but not built, create a task or future-work claim for the deferred capability. Do not collapse that into a claim that merely says the current slice did not build it.

Store process or eval constraints only when they are durable standing rules for future repository work. Do not store a session's command checklist, test-run sequence, or compatibility check as memory unless the user explicitly turned it into a reusable rule.

When the session discusses provenance or evidence, keep these roles separate:

- A provenance artifact records where a session-derived claim came from; it is useful for auditability and grouping.
- A code-verified claim is made true by code or diffs, not by attaching session provenance.
- If the session made that distinction, say it directly: provenance groups and audits where a claim came from; it is not the mechanism that makes a code fact true.
- An inspected file, commit state, or working-tree state should not become a provenance source unless the session explicitly made that artifact part of the memory model.
- A current session source should attach only to claims created, materially changed, or materially clarified by that session. Do not attach it to every old or reused claim.
- If the session discusses that scope rule, store it as its own constraint rather than assuming future agents will infer it from the proposal edges.

## What To Store

Create memory for durable changes only:

- **Curated-doc facts**: meaningful tracked README/AGENTS/CLAUDE/CONTEXT/CONTRIBUTING/docs content that explains what the repo is, how to work in it, rules to preserve, interfaces/contracts, or why things are this way.
- **Explored existing facts**: non-obvious repo behavior discovered while solving the task, especially behavior that shaped the design.
- **Code facts**: specific implementation facts verified against code or diffs.
- **Flow facts**: how behavior works across multiple components or commands.
- **Constraints**: rules future agents must preserve while editing.
- **Rationale**: why a design exists when the reason is not obvious from code.
- **Trade-offs**: alternatives discussed, rejected, postponed, or intentionally kept out of scope.
- **Drift**: important behavior or design consequences that exist without a clear explicit decision.
- **Tasks**: next work that should be done.
- **Future work**: planned later capabilities or follow-up directions that should not be forgotten.

For session-derived claims, choose the claim kind and truth value by what supports the claim:

- Use `fact`/`code_verified` for behavior verified in code or diffs.
- Use `decision` or `requirement`/`source_verified` for user-approved design choices, rejected alternatives, policy constraints, and process rules from the conversation. Add verified code anchors to those claims when the decision or rule points at a specific implementation surface.
- Use `task` or `question`/`unknown` for unresolved future work.
- Do not mark guidance from a skill/doc change as a code-verified requirement unless enforcement exists in code. If it is a user/session policy or instruction, keep it source-verified and attach session evidence.

When existing memory is now too vague or stale, create a clearer claim with `supersedes[]` pointing at the old claim. In particular, look for old claims returned by `greplica graph context` that describe the changed area broadly but miss the new session nuance. A claim can be worth superseding even when the old text is not false, if it is now materially incomplete and future agents would be misled by leaving it active.

If a new claim materially narrows, qualifies, or corrects an existing claim returned by `greplica graph context`, encode that relationship with `supersedes[]`; do not rely on wording alone. Before validating, review the proposal for changed validation rules, compact relationship behavior, and workflow claims that should supersede older broad memory.

If `greplica graph audit anchors` reports missing or stale anchors, treat the output as advisory. Fix relevant missing or stale anchors when they relate to the current session or are a small obvious cleanup. Do not mass-backfill unrelated claims unless the user asks.

When adding or correcting anchors for an existing claim, do not edit the old claim in place. Create a superseding claim with the same text if the claim remains true, or corrected text if the claim itself changed.

Do not store:

- temporary debugging chatter
- every implementation detail
- command logs
- secrets or environment variable values
- raw curated-doc prose or copied sections that have not been distilled into memory
- obvious local code facts that a future agent can read immediately
- claims based only on vague conversation unless marked `unknown`

Do not treat "durable changes only" as "diff-only." A memory update should capture durable knowledge learned during the work, including pre-existing behavior that was explored and then used to make or reject a design.

Do not stop at patch-visible facts. Also extract non-obvious session nuance: why the code was shaped this way, what alternatives were rejected, what future work was deferred, and what implicit drift the implementation introduced.

Keep distinct durable memories distinct. "Small update" means no transcript junk or unnecessary implementation detail; it does not mean merging separate code facts, constraints, rationales, trade-offs, drift, tasks, and future work into one broad claim. If the session contains separate durable statements, create separate focused claims with the right claim kind and truth value.

Do not optimize for a fixed memory count. Prefer complete coverage of every distinct durable session delta over a shorter proposal, while still dropping transient logs, generic agent process, duplicated bootstrap facts, and implementation trivia that does not change future work.

Preserve explicit negative or deferred decisions as first-class memory when they affect future work. Examples include rejecting an otherwise tempting artifact type as provenance, keeping an existing workflow primitive instead of adding a new command, discussing but not building an ingestion path, keeping pinned eval fixtures stable, or leaving a compatibility shorthand in place even though it no longer satisfies a stricter new contract by itself.

Preserve "not yet built" and "out of scope for this slice" decisions separately from the implemented facts. If the session says a capability will require a later command, ingestion path, adapter, migration, protocol, or workflow, create a future-work/task claim rather than hiding it inside an implementation summary.

Preserve terminology distinctions when confusion affected the task. For example, if the session distinguishes an evidence/source model from a similarly named ranking or retrieval signal, create a separate constraint or rationale so future agents do not conflate them.

When the session refines a broad existing memory, store the refined rule and supersede the old broad claim. If the old memory said "validation enforces source kinds" and the session learned "validation now allows only session sources and every evidence edge needs a reason," the refined claim should supersede the broad one.

Before final validation, do a missing-memory pass:

- List the durable old behavior, new behavior, rejected approaches, deferred work, terminology distinctions, and process constraints from the session.
- Check that each item is either represented by a focused claim, intentionally dropped for a clear reason, or superseded by a more precise claim.
- Check that any claim narrowing or qualifying old memory uses `supersedes[]` structurally.
- Check that session evidence is attached only to claims created or materially changed by this session, not to unchanged bootstrap facts.

Avoid broad code-verified claims about entire skills or workflows unless every part was verified against the patch. Prefer narrower claims tied to exact code/doc changes, and keep rationale or policy from the transcript as separate source-verified claims.

## Proposal Format

Write a JSON proposal to a temporary file:

```json
{
  "title": "Update working memory from session",
  "summary": "Durable context learned during the current coding session.",
  "creates": {
    "components": [],
    "flows": [],
    "claims": [
      {
        "id": "claim.example_session_decision",
        "kind": "decision",
        "text": "The session decided to keep the CLI primitive-focused and put workflows in coding-agent skills.",
        "truth": "source_verified",
        "intent": "intended",
        "about": []
      }
    ],
    "sources": [
      {
        "id": "source.codex_session.example_session_id",
        "kind": "session",
        "ref": "codex-session:example-session-id",
        "title": "Codex session example-session-id"
      }
    ],
    "edges": [
      {
        "kind": "evidenced_by",
        "from": "claim.example_session_decision",
        "to": "source.codex_session.example_session_id",
        "metadata": {
          "reason": "The decision was discussed and agreed during the current coding-agent session."
        }
      }
    ]
  }
}
```

Allowed claim kinds: `fact`, `requirement`, `decision`, `task`, `question`, `risk`.
Allowed truth values: `code_verified`, `source_verified`, `unknown`.
Allowed intent values: `intended`, `accidental`, `unknown`.
Allowed source kinds: `session`.
New `code_verified` claims require `code_anchors`, for example:

```json
"code_anchors": [
  {
    "file": "libs/knowledge-graph/service.ts",
    "symbol": "KnowledgeGraphService.applyProposal"
  }
]
```

For claim `code_anchors`:

- Prefer one anchor per code-verified claim: the stable function, class, method, type, or constant that best proves the claim.
- Use two anchors only when the claim is explicitly about a cross-boundary behavior changed or clarified by the session.
- Use file-only anchors for docs, skills, config, schemas, or other artifacts without stable symbols.
- Avoid file-only anchors for normal source files unless the file is tiny and the whole file is the relevant unit.
- Three anchors is the hard maximum and should be rare.
- A claim with four or more `code_anchors` is invalid; split it into narrower claims.
- Anchor the representative implementation boundary, not every related helper, caller, or downstream file.
- Avoid volatile private helpers when a more stable public class, function, method, command handler, or model type captures the claim.

For `source_verified` claims, code anchors are optional navigation aids, not proof. Add them when the session-derived memory is about a concrete code path and you verified the related file/symbol. Prefer a separate `code_verified` claim when the claim text itself is a code fact. Do not force anchors onto non-code decisions, user constraints, rejected alternatives, or future work.

Use compact relationship fields where possible:

- `flow.touches[]` for Flow -> Component.
- `component.contains[]` for Component -> Component.
- `flow.contains[]` for Flow -> Flow.
- `claim.about[]` for Claim -> Component/Flow.
- `claim.supersedes[]`, `component.supersedes[]`, or `flow.supersedes[]` only when replacing known existing memory.

For source-backed claims, use explicit `edges[]` entries with `kind: "evidenced_by"` and `metadata.reason`. Do not use compact `claim.evidenced_by[]`; every evidence edge must explain why the session supports the claim.

If you create a session source, connect non-code session-derived claims with `evidenced_by` edges. Code-verified claims do not need session evidence unless the claim is also recording a session decision, requirement, question, risk, trade-off, or task.

Each source-backed session claim should have its own `evidenced_by` edge to the session source with a reason specific to that claim. Do not use one bundled source-backed claim to cover multiple unrelated decisions, constraints, rationales, trade-offs, drift items, tasks, or future work.

## Quality Bar

- Prefer a complete focused update over broad memory churn. Complete means every distinct durable session delta is represented; focused means the proposal excludes transcript junk, generic process notes, and unrelated repository rescan output.
- Reuse existing components/flows when `greplica graph context` finds them.
- Create new components/flows only when the session introduced or clarified a durable area.
- Use `code_verified` only for claims checked against code.
- Use `source_verified` for claims grounded in the session.
- Use `unknown` for unresolved tasks, questions, and risks.
- For `code_verified` claims, keep `code_anchors` compact and symbol-backed where the target is source code. Do not mass-backfill unrelated missing anchors during a normal memory update.
- Create one `session` source for the current session when storing session-derived claims, with a source ID derived from the actual session metadata.
- Add a concise free-text `metadata.reason` to each `evidenced_by` edge.
- Include tasks and future work only when the session discussed what remains to be built.
- Prefer one precise superseding claim over leaving an older broad claim active beside a more specific update.
- If the session changed validation, proposal normalization, or skill behavior, explicitly query existing memory for those areas and decide whether an older claim should be superseded.

## Validate And Apply

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors until valid.
3. Run `greplica proposal apply <proposal-file>`.
4. Summarize the durable memory update and mention anything intentionally not stored.
