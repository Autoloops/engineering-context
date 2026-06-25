# Internal Prompt: Greplica Layered Deep Bootstrap

This is an internal memory-build prompt used by benchmark/eval scripts. It is not an installable user skill.

## Overview

Refresh existing Greplica memory against the current source tree without starting from an empty graph. This is the code-memory layer used before separate noisy-history ingestion, especially for benchmark workflows that advance from one base commit/cutoff to the next.

In benchmark progression, the configured `GREPLICA_HOME` is already seeded from the previous task's pre-task graph. Treat that graph as the parent memory layer. Your job is to make the parent graph accurate for the current checkout by adding or superseding only the code-memory deltas that matter at the new base commit.

This prompt is not the initial deep bootstrap and not the GitHub packet ingest. If there is no existing graph to build on, stop and use the internal deep-bootstrap prompt first.

## Boundaries

Allowed inputs:

- the current checked-out source tree
- the existing Greplica graph in the configured `GREPLICA_HOME`
- an optional harness-provided changed-file or changed-module list
- an optional output directory for proposal files and reports

Forbidden inputs:

- GitHub issues, PRs, review comments, discussions, or packet files
- task problem statements, gold context, scoring output, or prior task-solving transcripts
- future records relative to the benchmark cutoff
- web search, remote docs, home-directory agent logs, or global skill/session stores
- git history mining such as `git log`, PR branch inspection, or commit archaeology

Use a changed-file list only when the harness supplied it as deterministic run metadata. Do not derive task-specific intent from commit messages or PR metadata.

## When To Use Each Mode

Use **layered refresh** for normal benchmark progression:

- prior Greplica memory exists
- the repo is checked out at a later base commit
- code changes are small or moderate
- GitHub packets will be ingested after this step
- the output proposal manifest should contain only the layered-refresh delta proposals for the current task, not the parent task's proposal files

Use **partial rewalk** when there is no changed-file list or the graph looks stale:

- query the existing graph for major module groups
- re-inspect only the highest-value modules and their immediate neighbors
- avoid creating a second full copy of the whole repo memory

Use **full deep bootstrap** only when the user explicitly asks for a fresh first layer or the existing graph is unusable. That is handled by `greplica-deep-bootstrap`, not this skill.

## Workflow

### 1. Confirm Existing Layer

Run from the target repo root or a subdirectory inside it.

Do not run `greplica doctor` as routine preflight. Use it only if a Greplica command fails in a way that suggests installation, repo detection, or embedding configuration problems.

Start with:

```bash
greplica graph context "current repo architecture and major memory components"
```

If this returns no useful existing components/flows/claims, stop and report that this is not a layered refresh candidate.

Use `greplica graph read` only when focused context queries are insufficient to identify existing IDs for reuse or supersession.

### 2. Build A Refresh Plan

Create a short plan before inspecting deeply:

- changed modules from the harness-provided list, if present
- graph components/flows likely affected by those modules
- nearby callers/callees that must stay accurate for navigation
- areas intentionally left untouched because they did not change

- If there is no changed list, choose 3-8 high-value module groups from existing graph retrieval and the current tree.
- Prefer ownership boundaries over folder-by-folder churn: CLI surface, command rendering, output/presentation utilities, API/client layer, persistence/storage, config/env detection, proposal validation/apply, graph retrieval, eval harness, and skills.
- Treat cross-cutting utility layers as possible refresh targets when they own durable behavior: table/output rendering, terminal width and truncation, formatter helpers, parser/selector helpers, query builders, pagination, config bootstrap, and test harness utilities.
- Do not use git history to infer what changed. If no changed-file list is supplied, use existing memory queries plus the current source tree to decide which areas need a partial rewalk.

### 3. Inspect Current Code

For each planned module group:

- read current files and representative tests
- verify existing graph claims against the checked-out code
- identify stale claims that need `supersedes[]`
- identify new or changed responsibilities, invariants, entrypoints, data types, and cross-module flows
- capture anchors at symbol granularity whenever the language supports it

Do not write memory for every helper. Store facts that improve future navigation, correctness, or task planning. If a helper owns visible behavior such as truncation, column layout, selector parsing, API query shaping, pagination, config fallback, or error formatting, it is a valid memory target even when it is private.

### 4. Write Layered Proposals

Write one proposal per changed module group or cross-cutting flow. Apply each proposal before moving to the next group so later proposals can reuse IDs already present in the parent graph or created earlier in this layered refresh.

Use existing component and flow IDs when they still represent the same concept. Create new IDs only for genuinely new concepts. When a previous claim is now too broad, incomplete, or stale, create a new claim with `supersedes[]` pointing to the old claim.

Do not copy or recreate the parent graph. The proposal files from this skill should be small deltas that can be applied to the seeded parent graph. The harness may later materialize the current task by copying the parent runtime database and applying this task's proposal manifest.

Use this proposal shape:

```json
{
  "title": "Layered deep refresh: module or flow name",
  "summary": "Code-grounded memory refresh on top of an existing graph.",
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
        "id": "claim.example_refreshed_behavior",
        "kind": "fact",
        "text": "Example component now owns the durable behavior future agents need to navigate.",
        "truth": "code_verified",
        "intent": "unknown",
        "about": ["component.example", "flow.example"],
        "supersedes": ["claim.old_example_behavior"],
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

For this skill, code inspection should normally produce source-free `code_verified` claims with `code_anchors`. Do not create session sources for source-code inspection.

For claim `code_anchors`:

- Prefer one stable symbol per code-verified claim.
- Use two anchors for real cross-boundary behavior.
- Three anchors is the hard maximum and should be rare.
- A claim with four or more `code_anchors` is invalid; split it into narrower claims.
- File-only anchors are acceptable for docs, config, schemas without symbols, generated artifacts, and tiny whole-file units.
- Avoid file-only anchors for normal source files.
- Prefer stable public symbols over volatile private helpers.
- Use a private/helper symbol when that helper is the smallest accurate anchor for the claim and its behavior is externally visible or cross-cutting.
- When refreshing a broad old claim, create narrower superseding claims instead of copying the old breadth with many anchors.

### 5. Validate, Apply, And Probe

For each proposal:

```bash
greplica proposal validate <proposal-file>
greplica proposal apply <proposal-file>
greplica graph context "<covered module or workflow>"
```

After all proposals, run 3-5 retrieval probes matching likely future questions, not the hidden benchmark task. Good probes ask about broad systems such as list rendering, table truncation, terminal output width, TTY versus non-TTY formatting, PR command flow, branch and assignee query shaping, API pagination, config handling, or test harness behavior.

Run `greplica graph audit anchors` when available. Treat missing anchors, missing files, missing symbols, ambiguous symbols, or unsupported languages on active `code_verified` claims as failures to fix before handing off to GitHub packet ingestion.

### 6. Write A Build Report

When an output directory is available, write a small JSON or Markdown report with:

- repo path and current checked-out commit, if known without history mining
- whether this was layered refresh or partial rewalk
- changed-file/module list used, if provided
- proposal files applied
- components/flows/claims added or superseded
- retrieval probes and whether they returned the refreshed memory
- areas deliberately left shallow

## Handoff To GitHub Packet Ingestion

After this skill finishes, the graph should be ready for noisy historical packet ingestion. The packet workflow should then add only source-verified issue/PR context visible before the cutoff and should attach it to the refreshed code components/flows.

Do not run packet ingestion from this skill unless the user explicitly asks for the separate ingestion step.

## Quality Bar

- Build on the existing graph; do not duplicate the full old memory layer.
- Prefer superseding stale claims over silently adding conflicting claims.
- Keep proposals focused and sequentially applied.
- Use precise code anchors and compact claims.
- Split broad claims rather than giving a future agent a five-symbol anchor list.
- Preserve or refresh utility/helper claims when they are the best navigation handle for real behavior.
- Avoid task leakage, gold leakage, transcript leakage, and target-PR leakage.
- End with proposal paths, graph areas refreshed, and retrieval probes performed.
