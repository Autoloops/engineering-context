<div align="center">

<img alt="Greplica" src="docs/assets/greplica-arcade-font2.png" width="420">

### Long-term, searchable `AGENTS.md` for coding agents

<p>
  <a href="https://www.npmjs.com/package/greplica"><img alt="npm package" src="https://img.shields.io/npm/v/greplica?color=111111"></a>
  <img alt="Agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code-2563eb">
  <img alt="Storage" src="https://img.shields.io/badge/storage-local%20SQLite-475569">
  <img alt="Embeddings" src="https://img.shields.io/badge/embeddings-local%20%7C%20OpenAI-16a34a">
  <a href="https://discord.gg/q2R6AYXh9"><img alt="Discord" src="https://img.shields.io/badge/discord-join-5865F2"></a>
</p>

Keep `AGENTS.md` small. Put the rest of the agent's repo memory in Greplica.

</div>

---

`AGENTS.md` works because coding agents need project context. But the useful context quickly grows past what belongs in a short, always-read instruction file: architecture decisions, workflow notes, repo-specific gotchas, evaluation results, implementation history, and follow-up work.

Greplica keeps that deeper engineering context in local repo memory. Your agent can fetch the pieces it needs for the current task instead of rereading everything or rediscovering the codebase from scratch.

| `AGENTS.md` | Greplica |
| --- | --- |
| Always read by the agent | Queried only when relevant |
| Best for stable instructions | Best for deeper engineering context |
| Should stay short and high-signal | Can hold architecture notes, decisions, evals, and gotchas |
| Maintained manually | Maintained through bundled agent skills |

## Agent Quick Start

Most users should not install Greplica by hand. Paste this into your coding agent from inside the repo you want Greplica to remember:

Greplica requires Node.js 22-26.

`````txt
Install Greplica for this repo.

Run:

```bash
npm install -g greplica
greplica install --platform <codex|claude|opencode|openhands> --embedding local
```

Use the platform matching this agent. Do not manually copy skills. After installation, summarize the installer output, including whether hooks were installed and whether I need to accept or trust them.
`````

After that, the normal workflow is:

| Step | Ask your agent | What happens |
| --- | --- | --- |
| 1 | `Use greplica-bootstrap for this repo.` | Creates the first repo memory map. |
| 2 | Work normally | The agent can query `greplica graph context "<question>"` before broad exploration. |
| 3 | Accept hooks, or run `Use greplica-update-working-memory for this session.` manually | Durable decisions, constraints, changed flows, and follow-ups are saved. |

<details>
<summary>Manual install commands</summary>

Install the CLI:

```bash
npm install -g greplica
```

```bash
greplica install --platform <codex|claude|opencode|openhands> --embedding local
```

</details>

That gives the next agent a better starting point: not just files on disk, but remembered decisions, constraints, flows, and follow-up work.

---

## What Gets Stored?

Greplica is for engineering context that is useful later but too detailed for an always-read prompt:

- architecture and service boundaries
- command and workflow behavior
- repo-specific conventions and gotchas
- decisions made during implementation
- constraints, rejected alternatives, and future work
- eval results and benchmark notes
- code anchors that tell future agents where to inspect first

The goal is not to replace source code or documentation. The goal is to give agents a durable map of what matters and where to look next.

## How It Works

Greplica is intentionally split into three layers:

| Layer | Responsibility |
| --- | --- |
| CLI | Detects the current repo, stores memory locally, and exposes graph commands. |
| Skills | Define agent workflows such as bootstrapping repo memory and updating working memory after a session. |
| Retrieval | `greplica graph context "<query>"` returns relevant claims, components, and flows for the current task. |

Memory is stored in SQLite under `~/.greplica/graph.db` by default. Local embeddings run in-process by default and cache model files under `~/.greplica/models`. OpenAI embeddings are also supported when configured.

Graph context search blends multiple retrieval signals, including embeddings, BM25, exact matching, and graph relationships. The output is designed for coding agents: concise enough to fit into the task, but grounded enough to point at the right files and prior decisions.

## Evals And Benchmarks

Greplica includes evals for the workflows that matter most:

- bootstrapping repo memory
- graph context retrieval
- working-memory updates from real sessions
- proposal validation and apply behavior

The search eval scores `greplica graph context` retrieval with `Precision@10`, `Recall@10`, `MRR@10`, `nDCG@10`, and `GradeRecall@10`.

| Eval | Latest local result |
| --- | --- |
| `npm run eval:search-current` | Passed, `80.59 / 100` |
| `P@10` | `0.550` |
| `R@10` | `0.782` |
| `MRR@10` | `0.985` |
| `nDCG@10` | `0.802` |
| `GradeRecall@10` | `0.828` |

Broader context-retrieval benchmarking, including SWE-Context benchmark work, is ongoing and showing promising early results. We will publish those numbers when the harness and methodology are stable enough to compare fairly.

## Roadmap

- Codex, Claude Code, OpenCode, and OpenHands plugins so Greplica can be installed and used as a first-class agent integration.
- Review UX for memory updates before the agent applies them.
- SWE-Context benchmark coverage and sharper retrieval evals for real coding tasks.

## Commands

```bash
greplica install --platform codex|claude|opencode|openhands --embedding local|openai
greplica config
greplica doctor [--check-embeddings]
greplica graph read
greplica graph context "<query>" [--json|--debug]
greplica graph export <dir>
greplica graph view [--out <file>] [--no-open]
greplica proposal validate <proposal.json>
greplica proposal apply <proposal.json>
```

`greplica graph view` writes a self-contained HTML visualisation of the current graph (components, claims, claim kinds, and claims timeline) and opens it in your default browser. Use `--out` to choose where the file is written; by default it goes to a temp path. Use `--no-open` to skip opening the browser.

`greplica graph context "<query>"` prints concise Markdown for coding-agent use. Use `--json` for compact structured output, or `--debug` for the full retrieval payload with ranking signals and embedding status.

Run `greplica install` from each repo or folder where Greplica should work. Other commands require that repo to have been installed first.

For **OpenHands**, install is repo-local: skills are written to `.agents/skills/` and the `UserPromptSubmit`/`Stop` hooks to `.openhands/hooks.json` (Claude/Codex install to the agent's home config instead). The hooks inject `graph context` guidance and trigger background working-memory updates the same way; OpenHands must trust the repo hooks for the background save to run.

`greplica doctor` is for install verification and diagnosing failures, not a required preflight before every Greplica command.
