---
name: greplica-bootstrap
description: Bootstrap Greplica memory for the current repository or folder. Use only when the user explicitly invokes greplica-bootstrap or asks to create initial engineering memory with the greplica CLI.
disable-model-invocation: true
---

# Bootstrap Greplica Memory

Create shallow, useful Greplica memory for the current repository. Optimize for fast orientation, not exhaustive modeling.

## Preconditions

- Run from the target repo root, a subdirectory inside it, or a non-Git folder that should have its own memory.
- Do not run `greplica doctor` as routine preflight. Run needed commands directly; use failures to decide whether install or doctor would help.
- If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.
- If a Greplica command says the repo or scope is missing, run `greplica install --platform <platform> --embedding local` from the target repo and retry once. Use `codex`, `claude`, or `opencode` to match the current agent; ask only if unclear.
- Local embeddings need no API key. If OpenAI embeddings are configured and `OPENAI_API_KEY` is missing, stop and tell the user to set it in their shell or repo `.env.local`; do not ask for the key in chat.

## Fast Inspection Path

Read just enough to map the repo for a future agent:

- tracked root docs and obvious repo guidance: README, AGENTS/CLAUDE, CONTRIBUTING, CONTEXT, docs index files;
- package/config files that reveal commands, binaries, workspaces, runtime requirements, env vars, or public entrypoints;
- top-level tree and public app/lib entrypoints;
- targeted source files for central public boundaries: CLI/API dispatch, install/setup, config/env loading, storage, schema/model, validation/apply, retrieval, or health-check behavior.

Skip tests, eval harnesses, fixtures, samples, rubrics, generated output, benchmark files, and deep runbooks. If README/package docs expose an eval or test workflow, store the public command or purpose without opening fixture/sample/rubric internals. Do not open sample proposals or rubrics for format hints. Do not inspect skill files as generic docs; read them only when they are product artifacts whose workflow is part of this repo.

Stop inspecting when you can explain the repo identity, main public surfaces, important data/model boundaries, and documented workflows.

## What To Store

Store durable memory that saves real exploration:

- repo identity, audience, and major architecture boundaries;
- documented setup/build/test/run/release commands and unusual local requirements;
- public commands, APIs, config keys, file formats, schemas, protocols, or exported boundaries;
- central flows for setup/install, validation/apply, retrieval, persistence, diagnostics, or other user-visible behavior;
- repo-specific constraints, gotchas, risks, decisions, rejected approaches, and future work.

Prefer component/flow ownership and exact contracts over feature catalogs. Do not store private helper details, method inventories, fallback minutiae, broad capability lists, command logs, or promotional summaries. Keep docs at the level they state; do not strengthen them with nearby source behavior.

If the repo implements diagnostics, setup, graph memory, or proposal workflows, capture the shallow contract that connects those surfaces: what the diagnostic reports, what apply/validation writes or checks, whether embeddings/retrieval are involved, and whether source/provenance objects are scoped or global. Do not invent negative behavior such as ignored env keys or source filtering unless the checked code says exactly that.

Keep distinct public workflows separate when they answer different questions: diagnostics/init, proposal validation, proposal apply, retrieval, and compact relationship normalization should not be merged just because one service coordinates them. If graph sources and memberships both exist, preserve whether sources participate in memberships. If product skill workflows are stored, connect them to the CLI/proposal/context surfaces they instruct agents to use.

Use `component.repository` for whole-repo facts:

```json
{ "id": "component.repository", "name": "Repository", "code_anchor": "README.md" }
```

Create narrower components or flows when they help navigation for public boundaries. Do not bury config, storage, validation, retrieval, protocol, or persistence boundaries inside a generic repo component when those boundaries have stable files. Flow `touches` should include the public boundary components that the flow claim depends on.

## Evidence And Anchors

- Use `source_verified` for doc-derived claims and anchor them to the relevant doc/config file.
- Use `code_verified` only for current implementation facts checked in targeted source.
- Every `code_verified` claim needs precise `code_anchors`.
- Prefer a representative stable symbol anchor: exported function, method, type, constant, command handler, or model definition. Use a broad class anchor only when the whole class is the relevant boundary.
- Use a second anchor only for an explicit cross-boundary claim. Do not use broad file-only anchors for source files unless the whole file is the stable unit.
- For schema-only files without stable symbols, use the narrowest stable type/constant when available; otherwise keep the claim source-level instead of forcing a broad source anchor.
- Do not create sources during bootstrap just because code was inspected. Sources are for external/session artifacts.
- Use compact relationship fields where clear: `touches`, `contains`, `about`, and rare `supersedes`.

## Proposal

Write one JSON proposal with:

- `title`, `summary`, and `creates`;
- components, flows, claims, optional edges, and no session sources unless explicitly provided;
- claim `kind`: `fact`, `requirement`, `decision`, `task`, `question`, or `risk`;
- claim `truth`: `code_verified`, `source_verified`, or `unknown`;
- claim `intent`: `intended`, `accidental`, or `unknown`;
- component anchors use `"code_anchor": "path/to/file.ts"`;
- claim anchors use `"code_anchors": [{ "file": "path/to/file.ts", "symbol": "SymbolName" }]`; omit `symbol` only when no stable symbol exists; do not include line numbers in `file`.

Before writing, do one deletion pass: remove anything that is generic, unsupported, too deep, mostly test/eval mechanics, or not useful to a future agent. If a claim needs a long list to be true, narrow it.

## Validate And Apply

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors.
3. Run `greplica proposal apply <proposal-file>`.
4. Keep final output brief:
   - one sentence summarizing what the repository does, based on the applied proposal;
   - one sentence saying baseline Greplica memory was applied;
   - if onboarding is continuing into prior-session learning, say you are reading prior sessions next.

Do not run `greplica graph context` just to prove bootstrap worked. The value report should come from the proposal you created and applied.
