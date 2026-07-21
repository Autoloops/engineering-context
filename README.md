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

That's because it is re-learning context. Every new session, your agent wastes tokens and time building context on work it already did. And still misses important facts.

**Greplica** explores your repo structure, code and session transcripts to give your agent a persistent, maintained memory it can query before exploring. Local mode stays fully local with no telemetry; managed mode connects an authorized repository to shared team memory.

---

## Agent Quick Start

Most users should not install Greplica by hand. Paste this into your coding agent from inside the repo you want Greplica to remember.

Greplica requires Node.js 22-26.

```txt
Install Greplica for this repo using https://raw.githubusercontent.com/Autoloops/greplica/refs/heads/main/docs/agent-install-prompt.md.
```

Full prompt: [docs/agent-install-prompt.md](https://raw.githubusercontent.com/Autoloops/greplica/refs/heads/main/docs/agent-install-prompt.md)

That prompt asks a short setup questionnaire, installs Greplica in local or managed mode, and either creates the first local context or connects to existing shared memory.

To visualise your current memory in browser, run:

```bash
greplica graph view
```

---

## Shared Managed Memory

Managed mode lets contributors on different clones and forks query the same repository memory. It requires Greplica `0.2.0` or later and access to a managed Greplica server.

After an administrator invites your GitHub user to an organization or repository, run:

```bash
npm install -g greplica@latest
cd /path/to/your/repository-or-fork
greplica login --api-url https://memory.autoloops.ai
greplica install --mode managed --platform codex
greplica repo status
greplica graph context "What should I know before changing this subsystem?"
```

Replace `codex` with your agent platform. Login uses GitHub's browser device flow; do not share GitHub credentials or Greplica tokens. Interactive install can accept a matching invitation and automatically map a public fork to its upstream namespace. The GitHub App therefore does not need access to each contributor fork.

Organization admins and members inherit read access to every organization repository. Guests can read only explicitly granted repositories. Repository writes always require an explicit `memory_admin` grant; ordinary contributors remain read-only. Managed graph data stays on the server, while local SQLite stores only the repository binding, role cache, hook policy, and runtime session metadata.

Local mode remains independent and does not require login or a server:

```bash
greplica install --mode local --platform codex --embedding local
```

---

## How It Works

Your past agent sessions contain repo context: decisions people made, constraints agents found, files behind workflows, gotchas, and approaches that failed. Greplica keeps the durable parts so the next agent can start with that history.

| Step | What happens |
| --- | --- |
| Past sessions | Agents uncover repo-specific decisions, constraints, workflows, and file anchors. |
| Greplica stores it | Greplica saves the durable parts as `components`, `flows`, `claims`. |
| New agent asks | The agent runs `greplica graph context "<question>"` before broad exploration. |
| Agent uses it | The agent starts with facts, target files, subsystem boundaries, prior decisions. |
| Memory updates | Hooks or `greplica-update-working-memory` save useful new learnings after work sessions. |

If you have old sessions, `greplica-fast-session-bootstrap` can ingest bundled transcripts during setup. That gives Greplica useful memory on day one.

For example, a future task might ask about sync auth in a browser extension. The agent can start with:

```bash
greplica graph context "google sync auth startup identity browser settings"
```

Greplica returns a small Markdown packet the agent can act on:

```markdown
# Graph Context

## Best Claims

### claim.sync_auth_mode_startup
The sync service checks auth mode during startup before enabling Google Drive sync.

Anchor: `src/background/sync-service.ts`

### claim.edge_identity_gap
Edge does not expose the same Google identity API behavior as Chrome.

Anchor: `src/platform/browser-identity.ts`

## Related Flows

- `flow.sync_startup`: startup settings, auth checks, and sync-service initialization.
- `flow.browser_identity`: browser-specific identity API behavior.
```

### How this helps the agent

At task start, the agent gets a target list: the sync service, browser identity wrapper, startup flow, and the prior constraints that matter. It reads the current code before changing anything, but it verifies the right area first.

That saves the work agents repeat across sessions: broad `rg` searches, adjacent module reads to infer ownership, and rediscovery of decisions a previous session found. This makes your agent more reliable, and leads to it generating better plans.

---

## SWE-chat Benchmarks

We also benchmark Greplica on held-out planning tasks built from [SWE-chat](https://www.swe-chat.com/), a dataset of real coding-agent sessions from public repositories ([dataset](https://huggingface.co/datasets/SALT-NLP/SWE-chat), [paper](https://arxiv.org/abs/2604.20779)).

For each case, we start from a clean base snapshot of the repo and use 2-4 earlier sessions from that same repo to build Greplica context. Then we run the same held-out planning task in two modes: a baseline run with no Greplica context, and a Greplica run where the agent can query `greplica graph context` during the task. One bootstrap pass plus replayed session updates gives the agent saved repo-specific decisions and workflow knowledge.

In several showcased planning cases, Greplica cut token usage by 40-50%. Stronger runs saved wall-clock time. Greplica improved the plan when the task depended on repo-specific constraints, decisions, and subsystem boundaries. In the strongest run we measured, Greplica used 75.0% fewer tokens and finished about 38% faster.

Current showcase rows:

| Case | Score | Tokens | Tokens Saved | Time Saved | Why It Helped |
| --- | ---: | ---: | ---: | ---: | --- |
| Gemini Voyager sync/auth hardened | `100 -> 100` | `1,925,152 -> 480,988` | `1,444,164` fewer, `75.0%` | `140.4s` | Memory surfaced sync auth, startup, browser identity, and settings constraints. |
| IPTVnator playback layout | `64 -> 100` | `1,592,080 -> 881,541` | `710,539` fewer, `44.6%` | `65s` | Memory pointed at player, workspace, playlist, and radio layout boundaries. |
| Marin Harbor SWE eval support | `6 -> 100` | `2,992,034 -> 2,193,023` | `799,011` fewer, `26.7%` | `80.2s` | Memory surfaced vendored Harbor, mini-swe-agent compatibility, and validation constraints. |

---

## Commands

```bash
greplica install --mode local --platform codex|claude|copilot|cursor|opencode|openhands|factory-droid|antigravity --embedding local|openai [--hooks enabled|disabled] [--auto-memory enabled|disabled]
greplica login [--api-url https://memory.autoloops.ai]
greplica install --mode managed [--platform codex|claude|copilot|cursor|opencode|openhands|factory-droid|antigravity] [--managed-repo <uuid>] [--hooks enabled|disabled] [--auto-memory enabled|disabled]
greplica logout
greplica whoami
greplica repo status
greplica config
greplica doctor [--check-embeddings]
greplica embeddings prewarm
greplica graph read
greplica graph context "<query>" [--debug]
greplica graph audit anchors
greplica graph view [--out <file>] [--no-open]
greplica graph export <dir>
greplica proposal validate <proposal.json>
greplica proposal apply <proposal.json>
greplica session mark-memory-current --session-ref <ref>
greplica transcript bundle --platform codex|claude|copilot|opencode --file <path> [--file <path>...] --out <bundle.md>
```

- `greplica graph context "<query>"` - returns Markdown for agent use. Add `--debug` for the full retrieval payload with ranking signals.
- `greplica graph read` - prints the current graph view: all components, flows, claims, sources, and edges in scope.
- `greplica graph view` to visualise the current memory in a local HTML, opens in your default browser. Use `--out` to choose where the file is written; by default it goes to a temp path.
- `greplica transcript bundle` - converts one or more Codex, Claude Code, GitHub Copilot CLI, or OpenCode transcripts into a sanitized Markdown bundle for `greplica-fast-session-bootstrap`.
- `greplica embeddings prewarm` - downloads and initializes the local embedding model ahead of the first query when local embeddings are configured.
- `greplica session mark-memory-current` - marks a tracked agent session as already reflected in working memory.
- `greplica doctor` - verifies installation and diagnoses configuration failures. Not a required preflight before every command.
- `greplica install` prepares repo state, local storage, and agent integration; normal repo commands require install first. Local and managed mode are selected independently per repository.
- `greplica login` authenticates managed mode through GitHub and stores the Greplica JWT separately in `~/.greplica/credentials.json`.

For **OpenHands**, install is repo-local: skills are written to `.agents/skills/` and the `UserPromptSubmit`/`Stop` hooks to `.openhands/hooks.json` (Claude/Codex/Copilot install to the agent's home config instead). GitHub Copilot CLI installs personal skills under `~/.copilot/skills` (or `$COPILOT_HOME/skills`) and user hooks under `~/.copilot/hooks/greplica.json`. The hooks inject `graph context` guidance and trigger background working-memory updates; OpenHands must trust the repo hooks for the background save to run.

For **Cursor**, skills are written to `~/.cursor/skills` and the `beforeSubmitPrompt`/`stop` hooks to `~/.cursor/hooks.json` (both overridable via `$CURSOR_HOME`). `greplica-bootstrap` and `greplica graph context` guidance is delivered through an always-applied project rule at `.cursor/rules/greplica.mdc` rather than the hook, because Cursor's `beforeSubmitPrompt` hook cannot inject prompt context; the hooks track sessions and trigger `greplica-update-working-memory`. A user-authored `greplica.mdc` is never overwritten (install falls back to `greplica-N.mdc`). Reload Cursor if the new rule does not appear immediately. Background working-memory updates run the Cursor CLI (`cursor-agent`), so that must be installed and authenticated for automatic saves; session tracking and guidance work without it.

## License

MIT. See [LICENSE](LICENSE).
