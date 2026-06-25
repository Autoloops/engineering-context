# ContextBench Retrieval From SQLite

This eval turns saved ContextBench Greplica task artifacts into immutable task
environments, then runs real ContextBench tasks against copied environments.

The dataset is intentionally outside git:

```text
memory-workbench/datasets/contextbench-cli-cli-retrieval-v1
```

Run artifacts are also outside git:

```text
memory-workbench/runs/contextbench-task
```

Usage:

```bash
npm run bench:contextbench -- --limit 1 --runner greplica
npm run bench:contextbench -- --limit 1 --runner baseline
npm run bench:contextbench -- --task cli__cli-495 --runner greplica
npm run bench:contextbench -- --tasks cli__cli-362,cli__cli-495 --runner baseline
```

The current frozen dataset contains 17 accepted `cli/cli` tasks copied from the
saved full Greplica ContextBench run. Each task directory contains:

- `repo/base-source.tar.gz`
- `memory/pre-task`
- `memory/pre-github`
- `task.json`
- `provenance.json`

`greplica` copies `memory/pre-task` into a scratch `GREPLICA_HOME`, passes that
home to the existing Docker ContextBench runner, installs Greplica in the task
container, runs Codex on the task, and scores the resulting trajectory with
ContextBench.

`baseline` runs the same ContextBench task runner without allowing Greplica.

The runner marks underlying ContextBench runs with `valid_for_eval: false` as
`invalid_eval`. Invalid runs are written to `task-results.jsonl` with their
boundary/leak diagnostics, but they are excluded from aggregate averages.
