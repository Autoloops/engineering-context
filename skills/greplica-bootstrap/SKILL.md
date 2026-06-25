---
name: greplica-bootstrap
description: Bootstrap Greplica memory for the current repository or folder. Use only when the user explicitly invokes greplica-bootstrap or asks to create initial engineering memory with the greplica CLI.
disable-model-invocation: true
---

# Bootstrap Greplica Memory

Create shallow, high-signal Greplica memory for the current repository or folder.

## Preconditions

Run from the target repository root, a subdirectory inside it, or a non-Git folder that should have its own memory.

Do not run `greplica doctor` as a routine preflight. Run the needed Greplica commands directly; if one fails, use the error to decide whether install or doctor would help diagnose installation, target detection, or embedding-provider configuration.

If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.

If a Greplica command reports that Greplica is not installed for this repo, or that the main or working scope is missing, run `greplica install --platform <platform> --embedding local` from the target repo and retry the failed command once. Use the platform matching the current agent: `codex` for Codex, `claude` for Claude Code, and `opencode` for OpenCode. If the platform is genuinely unclear, ask the user which platform to install for.

Local embeddings are the default and do not require `OPENAI_API_KEY`. If Greplica is configured for OpenAI and a command reports that `OPENAI_API_KEY` is missing, stop. Do not ask the user to paste the key into chat. Tell them to set it in their shell before launching the coding agent, or in target-root `.env.local`.

## Inspect Curated Repo Context First

Read tracked Markdown context before source code. Use `git ls-files` when available to inventory all tracked `*.md` and `*.mdx` files, then decide which files contain durable repo memory.

High-priority Markdown/MDX often includes README files, AGENTS.md, CLAUDE.md, CONTEXT.md, CONTRIBUTING files, architecture/design docs, docs under any `docs/` directory, package-level agent guidance, and docs that define public APIs, config, tests, releases, or workflows. Do not assume these names are exhaustive; a file like `architecture.md`, `design.md`, `development.md`, or `testing.mdx` can be just as important.

Do not treat `skills/**/SKILL.md` files as generic curated context. Skill files are often agent workflow instructions, and ingesting them wholesale creates noisy memory. Only inspect them if they are clearly product source artifacts needed to understand this repository, and still summarize them shallowly.

Assume most meaningful content in curated docs deserves memory if it fits one of these durable categories:

- **What this repo is**: product purpose, audience, core concepts, and major architecture boundaries.
- **How to work in it**: setup, run, test, build, eval, required tools, environment, services, and local workflow gotchas.
- **Rules to preserve**: agent instructions, coding/repo conventions, invariants, compatibility/security/privacy constraints, and do-not guidance.
- **Interfaces and contracts**: public CLI/API/config/file formats, integration behavior, schemas, protocols, and examples that define expected behavior.
- **Why things are this way**: explicit decisions, rationale, rejected alternatives, historical context, roadmap, future work, and known risks.

When the docs provide them, make sure bootstrap memory preserves the repo identity from README-style docs and durable contribution/workflow contracts from testing, documentation, publishing, architecture, design, or development guides. Do not let source-code inspection replace these curated-doc facts.

Curated docs are the starting inventory, not the whole bootstrap. After reading them, inspect the shallow source/config surfaces needed to verify and complete the durable memory. A good bootstrap should merge documented intent with the current implementation surface when both matter.

Do not use source inspection to embellish curated-doc facts with extra mechanics. If a doc says a command, boundary, or rule has a specific shape, preserve that shape without adding implementation details that are only visible in tests or source. Source inspection can verify anchors, public surfaces, and central operational boundaries; it should not turn a documented rule into a stronger or more detailed claim than the docs support.

When curated docs give exact formats, schemas, protocols, ID shapes, configuration keys, command examples, file formats, or sanctioned helper names, preserve those exact contracts. Do not replace an exact documented contract with only a generic parent rule.

Do not copy documentation prose into memory verbatim. Distill docs into focused components, flows, and claims that future agents can query. Prefer multiple precise claims over one broad summary when the doc contains separate durable facts.

For package-level docs, a component plus exact contracts is usually better than a broad feature catalog. Store package-specific claims only when they preserve a stable interface, ID format, config/env rule, security/privacy rule, publishing/docs/test rule, sanctioned helper, or known risk. Do not create "scope" claims that list every feature, method, integration operation, or supported action from a README, AGENTS file, source export, or marketing overview.

It is acceptable for a component to exist without a detailed "scope" claim. Do not add a claim merely to prove every component has one. A component name, anchor, and flow link are often enough when the only available details are package capabilities or source internals.

## Repo-Level Memory

When curated docs contain facts that apply to the whole repository or workspace, create a conventional component for them:

```json
{
  "id": "component.repository",
  "name": "Repository",
  "code_anchor": "README.md"
}
```

Use `component.repository` as the `about` target for repo-level claims. Add more curated root files to `code_anchor` only when they are central to the repo-level facts, for example `README.md, AGENTS.md, CONTRIBUTING.md`.

Repo-level facts include:

- identity: what the repo is, product purpose, audience, and main value.
- global architecture: monorepo layout, major package families, ownership boundaries, and where docs/source/examples live.
- whole-repo workflow: root install/build/test/lint/eval commands, package manager requirements, local prerequisites, env vars, services, and ports.
- global contribution rules: PR rules, changesets, commit conventions, branch rules, and review requirements.
- agent-wide instructions: root AGENTS.md/CLAUDE.md guidance, search-before-edit rules, docs-update rules, and safety constraints.
- cross-cutting conventions: coding style, generated-file policy, docs policy, naming conventions, and test placement rules.
- public contracts spanning the repo: CLI/API compatibility rules, config guarantees, package versioning, and release process.
- repo-wide risks, gotchas, rationale, history, roadmap, and non-goals.

Do not force package, module, service, endpoint, or function-specific facts into `component.repository`. Create or reuse a narrower component or flow for those facts.

## Inspect The Repo Shallowly

Read enough to orient a future coding agent:

- curated repo context from the files listed above.
- package/config/build files.
- top-level tree.
- app/lib entrypoints and public control surfaces.
- install/setup/config/doctor/health-check surfaces when the repo has them.
- environment/config loading and required external service checks.
- schema/type/model files that define durable concepts.
- public API, CLI, config, file-format, protocol, or plugin boundaries.
- persistence/repository/storage boundaries when data durability matters.
- tests only when they clarify important behavior.
- existing memory with `greplica graph read`.

Do not perform a deep audit. Prefer major subsystems and human workflows over file-by-file or function-level memory.

Before writing the proposal, do a short coverage pass. Ask what a future agent would need to know before editing this repo:

- How is the tool or product installed, configured, run, diagnosed, and validated?
- Where do required environment variables, credentials, config files, ports, services, or local state come from?
- What public commands, APIs, packages, routes, events, schemas, protocols, config files, file formats, or generated artifacts are compatibility contracts?
- Which modules are the application boundaries that coordinate storage, validation, external services, or user-visible behavior?
- Which documented rules are enforced in code, and which implemented behavior is not obvious from docs but is durable enough to matter?

If one of those answers is central to the repository and not yet represented, add a component, flow, or claim for it. This is still shallow bootstrap work; the goal is to capture operational contracts and boundaries, not private helper details.

For every claim candidate, do a support audit before writing the final proposal:

- If supported by curated docs, keep the claim at the level of detail the docs actually state.
- If supported only by source code, keep it only when it describes a public contract, entrypoint/API/config/file-format/protocol boundary, storage boundary, operational setup/diagnostic behavior, or major architecture boundary.
- If supported only by tests, fixtures, examples, or implementation internals, normally drop it. Keep it only when it documents a public compatibility contract or a repo-wide workflow that future agents must preserve.
- Do not infer stronger requirements from examples, tests, helper names, or nearby code. Store what is evidenced, not what seems plausible.
- Prefer "this component owns this boundary" over enumerating methods, flags, retry behavior, timeout details, fixture mechanics, or private algorithms.
- A type/interface/schema file can justify a component or boundary anchor, but do not create exhaustive method, field, or export inventories from it unless curated docs present that inventory as a durable contract.
- When docs provide an explicit allow/deny list, requirement list, or compatibility rule, do not extend that list with additional items inferred from source.

Then do a pruning pass:

- Replace script implementation details with the durable workflow contract. Store "run the aggregate validation command" rather than the private command chain unless the chain itself is a public compatibility rule.
- Replace interface or type method inventories with the durable role of the interface/type. Store "this interface is the platform boundary" rather than every method it exposes unless the method list is the contract being changed.
- Replace package feature catalogs with the package purpose plus the few exact invariants, identifiers, config keys, protocol formats, or do-not rules that future edits must preserve.
- For integrations, adapters, state backends, CLIs, plugins, or SDK packages, avoid claims that read like "this package supports A, B, C, D, E." Keep the component to establish ownership, then store only exact contracts and hazards that future edits must preserve.
- For style and linting docs, avoid expanding generic tool rules into long best-practice inventories. Store the governing tool or policy, and only preserve unusual or repo-specific do/don't rules that are explicitly documented.
- Drop test/fixture/emulator/recording mechanics unless they are the documented workflow a future agent must run or preserve.
- Be suspicious of long comma-separated claims. If a claim lists many methods, features, flags, or mechanics, reduce it to the durable abstraction or split out only the exact documented contracts.
- For component or package "scope" claims, state the purpose and ownership boundary. Do not copy overview bullet lists of capabilities into memory. Only keep capabilities that are exact contracts, compatibility guarantees, safety rules, or identifiers that future edits must preserve.
- For deep operational runbooks, fixture guides, replay guides, emulator guides, migration notes, or package-specific test procedures, bootstrap usually needs only the location and purpose. Store step-by-step commands or flags only when the runbook is a root workflow or a public contract future agents are expected to run frequently.

Before validation, run a hard deletion filter:

- Delete any claim whose main evidence is source-code exploration and whose content is not a public command/API/config/file-format/protocol/storage/diagnostic boundary.
- Delete any claim that lists many capabilities, methods, operations, routes, flags, lifecycle steps, fallback behaviors, or generated files unless a curated doc explicitly presents that exact list as the durable contract.
- Delete any package-specific "what it supports" claim when the component and flow already tell future agents where the package lives.
- Delete any claim that adds extra items to a documented list. Keep only the documented list or narrow the claim to the items the docs actually state.
- Delete `code_verified` claims for doc-first bootstrap when a `source_verified` doc-level claim or component/flow link would be enough.
- Delete package-specific fallback defaults, concurrency edge cases, checker override maps, auth/signature algorithm details, routing subcases, or generated-file inventories unless they are documented as user-facing compatibility contracts or repo-wide rules. Bootstrap can leave those for working-memory updates when a task actually touches that package.

When setup, initialization, configuration, or diagnostic behavior is central, represent it as a flow, not only as a loose claim. That flow should touch the entrypoint or public surface plus the components that provide target detection, environment/config loading, persistence, external service checks, or health reporting.

Do not confuse "do not run a diagnostic command as routine preflight" with "do not remember diagnostic behavior." If the target repo implements a diagnostic, health-check, status, setup, or initialization path that future agents may need when something fails, capture what it checks and which boundaries it exercises.

When a central workflow depends on separately owned files or modules, prefer separate components for those boundaries even if one top-level entrypoint calls them all. Do not bury target detection, environment/config loading, storage, validation, retrieval, protocol handling, or external-service integration inside a generic app component when they have their own durable module boundary.

Be precise about public surfaces. Treat commands, APIs, config keys, routes, events, protocols, file formats, and exports as public contracts only when they are documented, shown in help, exported, or intentionally exposed. Do not list hidden, compatibility, or legacy code paths as supported public surfaces. Include them only when the hidden/internal distinction itself is durable and important to future edits.

Only store facts about the target repository checkout. Do not create drift claims by comparing the target repo's docs or bundled skills against this skill prompt, the current workspace, or newer product behavior outside the target checkout.

When the repo has separate files for related responsibilities, keep them separate if that helps navigation. In particular:

- Do not collapse proposal normalization and proposal validation when they live in different files.
- Do not collapse persistent repository operations and database schema/open/migration code when they live in different files.
- Represent graph schema/type/model files as their own component when they define the memory model.
- Add a dedicated flow for compact relationship fields becoming canonical graph edges when the repo supports compact proposal syntax.

Choose anchors that match the claim support. If a component or claim is primarily doc-derived, anchor it to the relevant docs or agent guidance. Prefer doc anchors for doc-first bootstrap when durable docs exist for that component. Use source-file anchors for source-derived public boundaries, not as a substitute for documented evidence. Avoid adding implementation source files to a doc-derived component's `code_anchor` unless the source file is the only stable public entrypoint needed to navigate the boundary.

## Proposal Format

Write a JSON proposal to a temporary file:

```json
{
  "title": "Bootstrap repo memory",
  "summary": "Top-level engineering memory for this repository.",
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
        "text": "Example component participates in Example workflow.",
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

- Prefer one anchor per code-verified claim: the stable function, class, method, type, or constant that best proves the claim.
- Use two anchors only when the claim is explicitly about a cross-boundary behavior that cannot be understood from one symbol.
- Use file-only anchors for docs, skills, config, schemas, or other artifacts without stable symbols.
- Avoid file-only anchors for normal source files unless the file is tiny and the whole file is the relevant unit.
- Three anchors is the hard maximum and should be rare.
- A claim with four or more `code_anchors` is invalid; split it into narrower claims.
- Anchor the representative implementation boundary, not every related helper, caller, or downstream file.
- Avoid volatile private helpers when a more stable public class, function, method, command handler, or model type captures the claim.

Use compact relationship fields where possible:

- `flow.touches[]` for Flow -> Component.
- `component.contains[]` for Component -> Component.
- `flow.contains[]` for Flow -> Flow.
- `claim.about[]` for Claim -> Component/Flow.
- `claim.supersedes[]`, `component.supersedes[]`, or `flow.supersedes[]` only when replacing known existing memory.

Sources currently represent session artifacts. Do not create a source just because code was inspected during bootstrap.

## Quality Bar

- Prefer roughly 4-10 major components for a small repo.
- Include major flows that help future agents decide where to look.
- Include claims that capture why the main modules matter, not just which commands exist.
- Capture high-signal curated-doc facts unless they are purely promotional, duplicate, obsolete, or not useful to future agents.
- Capture boundary facts such as thin entrypoint wrappers, public dispatch/routing, install/setup flows, diagnostic flows, environment/config loading, service boundaries, target detection, persistence boundaries, global source storage, and shallow bootstrap guidance when the inspected code or curated docs support them.
- Do not let a broad repository component hide important operational surfaces. Repo-level claims belong on `component.repository`, but central command/config/env/diagnostic/storage/API surfaces usually deserve narrower components or flows too.
- Avoid speculative drift claims during bootstrap. If a checked-out repo's docs, skills, or code disagree with your own current instructions, capture what the checked-out repo says and leave reconciliation to a later working-memory update.
- Drop claims that mostly summarize test harness mechanics, fixture recording details, emulator wiring, private dispatch branches, or exhaustive method inventories unless curated docs explicitly present them as durable contracts.
- Use `code_verified` only for claims grounded in inspected code.
- Add precise `code_anchors` for every `code_verified` claim. Claim anchors should be narrow enough that a future agent can verify the claim without inspecting a broad file set.
- Use `unknown` truth for unverified questions, risks, or tasks.
- Add open questions/tasks for important areas that need deeper inspection.
- Avoid noisy structure nodes, tiny helpers, private functions, and one claim per file.

## Validate And Apply

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors until valid.
3. Run `greplica proposal apply <proposal-file>`.
4. Summarize what memory was created and mention the proposal file path if it still exists.
