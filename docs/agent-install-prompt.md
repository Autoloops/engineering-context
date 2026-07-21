# Agent Install Prompt

`````txt
Summary of what we are doing:
- ask whether this repository should use local or shared managed memory
- ask a short Greplica guidance questionnaire before installing anything
- install greplica with the selected mode and hook behavior
- create initial memory and optionally analyze previous sessions only in local mode
- connect read-only contributors to existing team memory in managed mode

Before installing, ask me this short Greplica setup questionnaire. If this agent runtime supports native multiple-choice question UI, use it. Otherwise ask the same questions as plain multiple choice and wait for my answers. Do not run npm install, greplica login, greplica install, bootstrap, or transcript search until I answer.

Question 0:
Where should this repository's memory live?

Options:
1. Local memory (Recommended for personal use)
   Keep graph memory and embeddings in local SQLite. No login or managed server is required.
2. Shared managed memory
   Log in with GitHub and connect this checkout or fork to repository memory shared by an organization. This requires existing access, an invitation, or an accessible listed namespace.

Question 1:
How should Greplica help agents during future sessions in this repo?

Options:
1. Guidance + auto-save when permitted (Recommended)
   Install hooks that remind agents to run `greplica graph context` before broad exploration, and automatically try to save useful memory after enough session activity when the current repository role can write memory.
2. Guidance only
   Install hooks only for in-session guidance. Agents get reminded to use `greplica graph context`, but Greplica will not automatically save memory after sessions.
3. No hooks
   Do not install hooks. Greplica will install normally, but future agents will only use it if you manually add the guidance snippet shown at the end.

Question 2 (local memory only):
Should I inspect recent prior sessions for this repo to seed useful Greplica memory?

Options:
1. Yes, recent sessions (Recommended)
   Find 1-3 recent same-repo sessions, show the selected transcripts, then store durable decisions, gotchas, and workflow context.
2. No, fresh start
   Only create baseline memory from current repo files and skip transcript search.

If I selected shared managed memory, skip Question 2 because ordinary managed contributors are read-only and should consume the existing shared memory rather than seed it from private sessions.

Map the guidance answer to install flags exactly:
- Guidance + auto-save: `--hooks enabled --auto-memory enabled`
- Guidance only: `--hooks enabled --auto-memory disabled`
- No hooks: `--hooks disabled --auto-memory disabled`

Install the current CLI:

```bash
npm install -g greplica
```

Use the platform matching this agent. Do not manually copy skills. After installation, do not echo the full installer output or repeat its next steps.

If I selected local memory, run:

```bash
greplica install --mode local --platform <codex|claude|copilot|cursor|opencode|openhands|factory-droid|antigravity> --embedding local <mapped-hook-and-memory-flags>
```

Then follow the local bootstrap and optional transcript instructions below.

If I selected shared managed memory, run:

```bash
greplica login --api-url https://memory.autoloops.ai
greplica install --mode managed --platform <codex|claude|copilot|cursor|opencode|openhands|factory-droid|antigravity> <mapped-hook-and-memory-flags>
greplica repo status
greplica graph context "What should I know before working in this repository?"
```

The login command uses GitHub's browser device flow. Never ask me to paste a password, GitHub token, or Greplica JWT. Let interactive managed installation accept a matching invitation, map a public fork to its upstream namespace, or ask me to select among accessible namespaces. Do not bootstrap, bundle transcripts, validate proposals, apply proposals, publish local memory, or attempt any other memory write unless `greplica repo status` shows an explicit `memory_admin` role and I separately ask for a write. After a successful managed install and context query, skip the local-only instructions below and follow the final answer rules.

For local memory, bootstrap shallow memory for this repo:
- Prefer using the `greplica-bootstrap` skill.
- If the skill is not visible until restart, read the installed `greplica-bootstrap/SKILL.md` file and follow it directly.
- Create, validate, and apply the bootstrap proposal.
- Keep bootstrap output for the final answer to one line: `Greplica is installed and baseline memory was applied.`

If I chose local memory and "Yes, recent sessions", analyze prior sessions:
- Find recent prior sessions for this same repo and platform, preferring work from the last 1-2 days.
- Candidate locations: Codex `~/.codex/sessions/**/*.jsonl`; Claude Code `~/.claude/projects/**/*.jsonl`; GitHub Copilot CLI paths from `Stop` hook `transcript_path` values or `$COPILOT_HOME/session-state`; OpenCode `~/.local/share/opencode/storage/session/*.json` with messages under `storage/message/<sessionId>/`.
- Do not require transcript metadata `cwd` to equal the current checkout path. Users may use worktrees, renamed folders, or multiple checkouts of the same repo.
- Treat a transcript as same-repo when its metadata `cwd` is the current path, or when that `cwd` still exists and Git reports the same `remote.origin.url` or same normalized repo identity as the current repo. If the old path no longer exists, use transcript cwd text, repo name, branch, and recent session content as weaker matching evidence.
- Select 1-3 transcripts. Use one if there is a large high-signal session, two by default when multiple sessions are useful, and three only when sessions are smaller or cover distinct work.
- Show me the selected transcripts before bundling them: title if available, date/time, path, size/turn count if available, and why each matched this repo.
- Do not ask for confirmation. Continue with a temporary bundle path:

```bash
greplica transcript bundle --platform <codex-or-claude-or-copilot-or-opencode> --file <path-1> [--file <path-2>] [--file <path-3>] --out <greplica-transcript-backfill.md>
```

- Then use the `greplica-fast-session-bootstrap` skill on `<greplica-transcript-backfill.md>` and include its final value summary naturally in the final answer.

If I chose local memory and "No, fresh start", skip transcript search entirely.

If I chose "No hooks", do not edit `AGENTS.md`, `CLAUDE.md`, or any other agent instruction file. Instead, include this manual guidance snippet in the final answer and say I can add it to my agent instruction file if I want future sessions to use Greplica without hooks:

```md
Greplica hook guidance: greplica is a repo-memory search tool for finding relevant architecture, decisions, flows, and code anchors. Before broad manual exploration in this repository, run greplica graph context "<question>" with a focused natural-language query. When Greplica provides useful context, mention that you used it and briefly say what it helped with.
```

Final answer rules:
- Write like you are updating a human, not filling a template.
- For local mode, start by saying Greplica is installed and baseline memory is ready.
- For managed mode, start by saying Greplica is installed and connected to shared memory, then mention the effective repository role from `greplica repo status`.
- Mention whether the repository uses local or shared managed memory.
- Mention the selected guidance/memory-update mode: Guidance + auto-save, Guidance only, or No hooks.
- In local mode, if transcript backfill ran, include the `greplica-fast-session-bootstrap` final value summary naturally.
- In local mode, if transcript backfill was skipped, say it was skipped because I chose a fresh start.
- In managed mode, do not mention transcript backfill or claim that baseline memory was created; state that the existing shared memory was queried successfully.
- If hooks were installed, end with a short note that hooks and installed skills might need a restart or trust approval.
- If hooks were not installed, include the manual guidance snippet and do not tell me to accept hooks.
- Do not include installer output, selected transcript recap, proposal paths, apply counts, command lists, bundle paths, or a long usage guide unless I ask.
`````
