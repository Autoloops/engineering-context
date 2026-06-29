# Agent Install Prompt

`````txt
Summary of what we are doing:
- install greplica
- create initial memory from codebase
- analyze previous sessions

Run:

```bash
npm install -g greplica
greplica install --platform <codex|claude|opencode|openhands|factory-droid> --embedding local
```

Use the platform matching this agent. Do not manually copy skills. After installation, do not echo the full installer output or repeat its next steps.

Then run the install commands above, then bootstrap shallow memory for this repo:
- Prefer using the `greplica-bootstrap` skill.
- If the skill is not visible until restart, read the installed `greplica-bootstrap/SKILL.md` file and follow it directly.
- Create, validate, and apply the bootstrap proposal.
- Keep bootstrap output for the final answer to one line: `Greplica is installed and baseline memory was applied.`

After baseline memory is applied, analyze prior sessions by default:
- Find recent prior sessions for this same repo and platform, preferring work from the last 1-2 days.
- Candidate locations: Codex `~/.codex/sessions/**/*.jsonl`; Claude Code `~/.claude/projects/**/*.jsonl`.
- Do not require transcript metadata `cwd` to equal the current checkout path. Users may use worktrees, renamed folders, or multiple checkouts of the same repo.
- Treat a transcript as same-repo when its metadata `cwd` is the current path, or when that `cwd` still exists and Git reports the same `remote.origin.url` or same normalized repo identity as the current repo. If the old path no longer exists, use transcript cwd text, repo name, branch, and recent session content as weaker matching evidence.
- For OpenCode, tell me transcript backfill is not supported yet.
- Select 1-3 transcripts. Use one if there is a large high-signal session, two by default when multiple sessions are useful, and three only when sessions are smaller or cover distinct work.
- Show me the selected transcripts before bundling them: title if available, date/time, path, size/turn count if available, and why each matched this repo.
- Do not ask for confirmation. Continue with a temporary bundle path:

```bash
greplica transcript bundle --platform <codex-or-claude> --file <path-1> [--file <path-2>] [--file <path-3>] --out <greplica-transcript-backfill.md>
```

- Then use the `greplica-fast-session-bootstrap` skill on `<greplica-transcript-backfill.md>` and include its final value summary naturally in the final answer.

Final answer rules:
- Write like you are updating a human, not filling a template.
- Start by saying Greplica is installed and baseline memory is ready.
- If transcript backfill ran, include the `greplica-fast-session-bootstrap` final value summary naturally.
- End with a short note that hooks and installed skills might need a restart.
- Do not include installer output, selected transcript recap, proposal paths, apply counts, command lists, bundle paths, or a long usage guide unless I ask.
`````
