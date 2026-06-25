<div align="center">

<img alt="Greplica" src="docs/assets/greplica-arcade-font2.png" width="420">

### Persistent, searchable engineering memory for AI coding agents

<p>
  <a href="https://www.npmjs.com/package/greplica"><img alt="npm package" src="https://img.shields.io/npm/v/greplica?color=111111"></a>
  <img alt="Agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code-2563eb">
  <img alt="Storage" src="https://img.shields.io/badge/storage-local%20SQLite-475569">
  <img alt="Embeddings" src="https://img.shields.io/badge/embeddings-local%20%7C%20OpenAI-16a34a">
  <a href="https://discord.gg/q2R6AYXh9"><img alt="Discord" src="https://img.shields.io/badge/discord-join-5865F2"></a>
</p>

</div>

---

Does your coding agent spend 5 minutes just grepping around when you give it a complex task?

That's because it is re-learrning context. Every new session, your agent wastes tokens and time building context on work it already did. And still misses important facts.

**Greplica** explores your repo structure, code and session transcripts (fully local, no telemetry) to give your agent a persistent, maintained memory it can query before exploring.

---

## Quick Start (paste into your agent)

If you want your agent to handle the entire setup in one step, paste this:

`````txt
Install Greplica for this repo.

First install the CLI:

```bash
npm install -g greplica
```

Then run the installer for the agent I am using:

Codex:
```bash
greplica install --platform codex --embedding local
```

Claude Code:
```bash
greplica install --platform claude --embedding local
```

OpenCode:
```bash
greplica install --platform opencode --embedding local
```

OpenHands:
```bash
greplica install --platform openhands --embedding local
```

Do not manually copy skills. Let the installer do it.

After installation, tell me where the skills were installed, which embedding mode was configured, whether I should restart the agent, and how to switch later to OpenAI embeddings if I want that.

Then tell me how to use Greplica:
- If this repo has not been initialized yet, tell me to run "Use greplica-bootstrap for this repo." once. If repo memory already exists, do not run it again.
- Tell me that during work, the agent can use `greplica graph context "<question about the current task>"` to fetch relevant repo context, including prior working memory, before broad manual exploration.
- Tell me that near the end of a useful session, I should run "Use greplica-update-working-memory for this session." so decisions, changed flows, constraints, and follow-up work are stored.
- Tell me that OpenAI embeddings are also available later by rerunning `greplica install --platform <codex-or-claude-or-opencode-or-openhands> --embedding openai`.
- IMPORTANT: tell me to add the Greplica guidance block manually to AGENTS.md or CLAUDE.md if I want the agent to keep using Greplica automatically.
`````

This bootstraps a graph mapping your entire project, ready to store important context you build while working.

To visualise your current memory in browser, run:

```bash
greplica graph view
```

---

## How It Works

Greplica stores engineering context in a local SQLite database as a structured knowledge graph:


| Object        | What it represents                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| **Component** | A distinct code module or subsystem, with a file anchor pointing where to look                       |
| **Flow**      | A workflow or process that spans multiple components                                                 |
| **Claim**     | A durable fact, decision, constraint, gotcha, or task linked to the components or flows it describes |
| **Edge**      | A typed relationship: `about`, `touches`, `contains`, `supersedes`, `evidenced_by`                   |


When your agent asks `greplica graph context "<question>"`, Greplica runs a hybrid retrieval pipeline - combining vector similarity, BM25 keyword scoring, and graph adjacency boosts - and returns a concise Markdown summary the agent can act on immediately.

---

## What the Agent Actually Sees

Running `greplica graph context "how does proposal apply work?"` outputs:

```markdown
# Graph Context

Query: how does proposal apply work?

## Components

- `component.knowledge_graph_service` Knowledge Graph Service
  Anchor: `libs/knowledge-graph/service.ts`
- `component.sqlite_repository` SQLite Repository
  Anchor: `libs/storage/sqlite/repository.ts`

## Flows

### Proposal Apply

ID: `flow.proposal_apply`

Claims:
- `claim.apply_validates_before_writing` (fact, code_verified): applyProposal validates the proposal before writing any records.
- `claim.memory_commits_chain_with_parent` (fact, code_verified): Each memory commit stores a reference to its predecessor.

## Other Relevant Claims

- `claim.apply_prints_commit_scope_and_counts` (fact, code_verified): proposal apply prints the memory commit ID, scope ID, and created object counts.
```

The agent gets the relevant file anchors, the decision trail, and the constraints - without reading the whole codebase.

---

## Normal Session Workflow


| When                    | Ask your agent                                         | What happens                                                               |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Before starting a task  | (automatic if guidance block is in place)              | Agent runs `greplica graph context "<task>"` before broad file exploration |
| During work             | Agent uses context to navigate                         | Relevant components, flows, and past decisions surface immediately         |
| End of a useful session | `Use greplica-update-working-memory for this session.` | Decisions, changed flows, constraints, and follow-up work are saved        |


---

## Quick Start (manual)

### 1. Install the CLI

```bash
npm install -g greplica
```

### 2. Install for your coding agent

Run this from inside the repository you want Greplica to remember:

```bash
# Claude Code
greplica install --platform claude --embedding local

# Codex
greplica install --platform codex --embedding local

# OpenCode
greplica install --platform opencode --embedding local

# OpenHands
greplica install --platform openhands --embedding local
```

This copies the Greplica agent skills, configures local embeddings (no API key needed), and initializes the memory database.

### 3. Add the Greplica guidance block to your agent config

After install, Greplica tells you exactly which file to edit (`CLAUDE.md` or `AGENTS.md`). Add the guidance block so your agent knows how to use its memory on every session.

### 4. Bootstrap memory for this repository (once)

Ask your agent:

```
Use greplica-bootstrap for this repo.
```

The agent reads your repository shallowly - README, config files, key entrypoints, type definitions - and writes a structured memory proposal. After validation and apply, the graph is ready.

---

## What Gets Stored

Greplica is for context that is too detailed for an always-read prompt but too important to rediscover from scratch:

- **Architecture and service boundaries** - which module owns what, where boundaries are enforced
- **Implementation decisions** - why the code is shaped the way it is
- **Workflow behavior** - how commands and flows work across multiple components
- **Repo-specific gotchas** - edge cases and non-obvious behaviors that caused bugs
- **Constraints and rejected alternatives** - what not to do, and why
- **Follow-up tasks** - work that was deferred, not forgotten

The goal is not to replace source code or documentation. It is to give agents a durable map of what matters and where to look next.

---

## Embedding Options


| Mode            | Command flag         | Requires         | Notes                                                                                                                                                  |
| --------------- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local (default) | `--embedding local`  | Nothing          | Runs `all-mpnet-base-v2` in-process via HuggingFace Transformers. First query downloads the model (~~420MB) and caches it under `~~/.greplica/models`. |
| OpenAI          | `--embedding openai` | `OPENAI_API_KEY` | Uses `text-embedding-3-small`. Better retrieval quality, requires network access per query.                                                            |


Switch at any time by rerunning `greplica install` with the new flag.

---

## Commands

```bash
greplica install --platform codex|claude|opencode|openhands --embedding local|openai
greplica init [--local|--openai]
greplica config
greplica doctor [--check-embeddings]
greplica graph read
greplica graph context "<query>" [--json|--debug]
greplica graph view [--out <file>] [--no-open]
greplica graph export <dir>
greplica proposal validate <proposal.json>
greplica proposal apply <proposal.json>
```

- `greplica graph context "<query>"` - returns Markdown for agent use. Add `--json` for compact structured output, or `--debug` for the full retrieval payload with ranking signals.
- `greplica graph read` - prints the current graph view: all components, flows, claims, sources, and edges in scope.
- `greplica graph view` to visualise the current memory in a local HTML, opens in your default browser. Use `--out` to choose where the file is written; by default it goes to a temp path.
- `greplica doctor` - verifies installation and diagnoses embedding configuration failures. Not a required preflight before every command.
- `greplica` automatically prepares memory state when commands run; no separate init step is needed.

For **OpenHands**, install is repo-local: skills are written to `.agents/skills/` and the `UserPromptSubmit`/`Stop` hooks to `.openhands/hooks.json` (Claude/Codex install to the agent's home config instead). The hooks inject `graph context` guidance and trigger background working-memory updates the same way; OpenHands must trust the repo hooks for the background save to run.

---

## Evals and Benchmarks

Greplica includes evals for the workflows that matter most:

- bootstrapping repo memory
- graph context retrieval
- working-memory updates from real sessions
- proposal validation and apply behavior

The search eval scores `greplica graph context` retrieval with `Precision@10`, `Recall@10`, `MRR@10`, `nDCG@10`, and `GradeRecall@10` over 34 realistic task-sentence queries against a deep synthetic fixture.


| Eval                          | Latest local result   |
| ----------------------------- | --------------------- |
| `npm run eval:search-current` | Passed, `80.59 / 100` |
| `P@10`                        | `0.550`               |
| `R@10`                        | `0.782`               |
| `MRR@10`                      | `0.985`               |
| `nDCG@10`                     | `0.802`               |
| `GradeRecall@10`              | `0.828`               |


Broader context-retrieval benchmarking, including SWE-Context benchmark work, is ongoing and showing promising early results. We will publish those numbers when the harness and methodology are stable enough to compare fairly.

---

