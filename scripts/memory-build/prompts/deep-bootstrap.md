# Internal Prompt: Deep Bootstrap Greplica Memory

This is an internal memory-build prompt used by benchmark/eval scripts. It is not an installable user skill.

Create a deep code-grounded Greplica memory layer for the current repository or folder.

This prompt is only for source-code bootstrap at the checked-out commit. Do not ingest GitHub issues, PRs, comments, prior task data, benchmark gold context, prior agent transcripts, web pages, or git history. Those are separate ingestion workflows.

## Preconditions

Run from the target repository root, a subdirectory inside it, or a non-Git folder that should have its own memory.

Do not run `greplica doctor` as a routine preflight. Run the needed Greplica commands directly; if one fails, use the error to decide whether `greplica doctor` would help diagnose installation, target detection, or embedding-provider configuration.

If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.

`greplica` automatically prepares memory state; do not ask the user to run a separate initialization command.

## Workflow

### 1. Inventory

Read enough to map the repo before writing memory:

- top-level tree and `rg --files`
- README/docs that explain architecture or workflows
- package/config/build files
- app/lib entrypoints
- schema/type/model files
- existing memory with `greplica graph read`

Avoid git history, remote URLs, and unrelated generated/vendor directories.

### 2. Plan Module Passes

Create a short module inventory before inspecting deeply. Group by durable ownership boundaries, not by every folder. Good groups are CLI surface, API/client layer, persistence/storage, domain model/schema, rendering/output, test harness/eval harness, installation/configuration, and bundled skills.

Treat cross-cutting utility layers as ownership boundaries when they encode durable behavior. Output/table rendering, terminal width handling, formatter/truncation helpers, parser/selector helpers, query builders, and config bootstrap helpers can be more useful to future agents than their callers when they own the invariant being claimed.

For large repos, process one module group at a time. When your environment supports parallel workers and the user asked for parallelism, split independent module groups across workers, then merge proposals sequentially.

### 3. Inspect Deeply

For each module group:

- read key files and representative tests
- identify responsibilities, entrypoints, data types, invariants, and cross-module calls
- capture code anchors at the symbol level whenever the language supports it
- query existing memory with `greplica graph context "<module or workflow>"` before writing duplicate concepts

Prefer durable behavior and navigation value over exhaustive file summaries.

Deep bootstrap should produce memory that lets a future agent jump near the right implementation. A claim anchored to an entire large source file is usually not deep enough. Prefer stable public functions, command handlers, classes, exported types, schema definitions, config loaders, validators, repository methods, or renderer/scorer functions.

Do not skip behavior-heavy helpers just because they are private or small. If a helper owns visible behavior such as truncation, column layout, selector parsing, retry logic, pagination, API query shaping, or config fallback, write a precise claim anchored to that helper or its smallest stable caller/test pair.

### 4. Write Proposals In Batches

Write one focused proposal per module group or cross-cutting flow. Validate and apply each proposal before moving to the next group so later groups can reuse existing components and supersede stale claims.

Use this proposal shape:

```json
{
  "title": "Deep bootstrap: module or flow name",
  "summary": "Code-grounded memory for one module group or workflow.",
  "creates": {
    "components": [
      {
        "id": "component.example",
        "name": "Example component",
        "code_anchor": "src/example.ts"
      }
    ],
    "flows": [
      {
        "id": "flow.example",
        "name": "Example workflow",
        "touches": ["component.example"]
      }
    ],
    "claims": [
      {
        "id": "claim.example",
        "kind": "fact",
        "text": "Example component owns the durable behavior future agents need to navigate.",
        "truth": "code_verified",
        "intent": "unknown",
        "about": ["component.example", "flow.example"],
        "code_anchors": [
          {
            "file": "src/example.ts",
            "symbol": "ExampleComponent"
          }
        ]
      }
    ],
    "sources": [],
    "edges": []
  }
}
```

Allowed claim kinds: `fact`, `requirement`, `decision`, `task`, `question`, `risk`.
Allowed truth values: `code_verified`, `source_verified`, `unknown`.
Allowed intent values: `intended`, `accidental`, `unknown`.
Allowed source kinds: `session`.
New `code_verified` claims require `code_anchors` with repo-relative `file` and optional `symbol`.

For claim `code_anchors`:

- Prefer one anchor per code-verified claim: the stable symbol that best proves the claim.
- Use two anchors when the claim is explicitly about a cross-boundary behavior.
- Three anchors is the hard maximum and should be rare.
- A claim with four or more `code_anchors` is invalid; split it into narrower claims.
- File-only anchors are acceptable for docs, config, schemas without stable symbols, generated artifacts, or tiny files whose whole content is the relevant unit.
- Avoid file-only anchors for normal source files.
- Anchor the representative implementation boundary, not every helper or downstream call.
- Prefer stable public symbols over volatile private helpers.

Use compact relationship fields where possible:

- `flow.touches[]` for Flow -> Component.
- `component.contains[]` for Component -> Component.
- `flow.contains[]` for Flow -> Flow.
- `claim.about[]` for Claim -> Component/Flow.
- `claim.supersedes[]`, `component.supersedes[]`, or `flow.supersedes[]` only when replacing known existing memory.

Do not create session sources for code inspection during bootstrap. Code-grounded bootstrap claims should usually be `code_verified`, source-free, and include `code_anchors`.
Do not create broad code claims merely to cover a module. If a module has list, view, parse, render, truncate, width calculation, format, validate, and API-query behaviors, create separate claims for those behaviors with separate anchors.

### 5. Add Cross-Cutting Flows

After module passes, add cross-cutting flows that future agents would search for:

- user command/request to domain/service logic
- config/env/repo detection to runtime behavior
- persistence/schema to service APIs
- parser/normalizer to validator/applier
- output/presentation helpers to command rendering
- test/eval harness to scoring output
- installation/setup to runtime command availability

Do not add a flow unless it touches at least two meaningful components.

### 6. Validate And Apply

For each proposal:

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors until valid.
3. Run `greplica proposal apply <proposal-file>`.
4. Run `greplica graph audit anchors` when available.
5. Query `greplica graph context "<covered area>"` to confirm the memory is retrievable.

## Quality Bar

- Cover most important modules, not every file.
- Preserve module boundaries where they matter for navigation.
- Use `code_verified` only for claims grounded in inspected files.
- Every `code_verified` claim must have a precise code anchor, preferably symbol-backed.
- Use `unknown` for risks, questions, or follow-up tasks.
- Prefer one precise claim over a broad paragraph covering unrelated facts.
- Split claims that would otherwise need four or more code anchors; prefer one or two anchors for normal claims.
- Do not skip durable utility/helper behavior when it is the best anchor for future navigation; avoid one claim per trivial helper, but capture helpers that own user-visible behavior or cross-cutting invariants.
- Avoid patch-only trivia, command logs, generated files, vendor directories, and one claim per helper function.
- End with a concise summary of proposal files applied, major components/flows created, and areas intentionally left shallow.
