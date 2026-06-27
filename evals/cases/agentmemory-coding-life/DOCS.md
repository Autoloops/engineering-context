# AgentMemory coding-agent-life-v1 benchmark (MVP)

This benchmark runs the `coding-agent-life-v1` recall corpus as a coding-agent QA task
and compares two arms:


| Arm            | What the agent gets                                                      | Purpose                                      |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `full-context` | All 15 session logs pasted into the prompt                               | Ceiling: everything in context, no retrieval |
| `greplica`     | A seeded greplica memory; the agent runs `greplica graph context` itself | Greplica as an autonomous memory tool        |


For every query the agent produces a final answer, and a judge (OpenAI or Anthropic)
grades that answer against the gold answer (pass/fail). The benchmark records pass rate
plus token, tool-call, and latency cost per arm.

The answering agent can be either **Codex** (`--agent codex`, default) or **Claude Code**
(`--agent claude`). In the `greplica` arm the chosen agent runs `greplica graph context`
itself; greplica is installed for the matching platform (`install --platform codex|claude`).

This uses the dataset purely as a shared question/answer corpus. It does **not** compare
against AgentMemory's published numbers. (A question-only `cold` floor was dropped: the
corpus describes a fictional project, so a no-context model trivially scores 0 — it
confirms the questions aren't guessable but adds no signal about greplica.)

## Prerequisites

- `npm run build` (done automatically by the npm script).
- The answering-agent CLI installed and authenticated:
  - `--agent codex` (default): the `codex` CLI (OpenAI models).
  - `--agent claude`: the `claude` (Claude Code) CLI with `ANTHROPIC_API_KEY` set (or
  whatever auth the local `claude` CLI is configured with). `ANTHROPIC_API_KEY` is read
  from `.env.local`/`.env` or the environment.
- A judge API key: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The provider is auto-selected
(OpenAI preferred when both keys are present); force one with `--judge openai|anthropic`.
So if you only have `ANTHROPIC_API_KEY`, Claude is used for both answering and judging.
Without any judge key, answers are still collected but every row is left unjudged
(`pass = null`). The judge is independent of the answering agent.
- Greplica retrieval uses **local embeddings by default** (`--embedding local`), so the
greplica arm needs no OpenAI key for retrieval.

## Run

```bash
npm run bench:agentmemory-coding-life
```

Common options (pass after `--`):

```bash
# only some arms
npm run bench:agentmemory-coding-life -- --arms greplica

# a quick smoke test on a few queries
npm run bench:agentmemory-coding-life -- --limit 2

# specific queries, explicit models, openai embeddings
npm run bench:agentmemory-coding-life -- --queries q-001,q-011 --agent-model gpt-5.4-mini --judge-model gpt-5.4 --embedding openai

# answer with Claude Code instead of Codex
npm run bench:agentmemory-coding-life -- --agent claude --agent-model sonnet

# Claude for both answering and judging (only an ANTHROPIC_API_KEY available)
npm run bench:agentmemory-coding-life -- --agent claude --judge anthropic
```


| Flag            | Default                                                                                   | Meaning                                          |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `--arms`        | `full-context,greplica`                                                                   | Which arms to run                                |
| `--agent`       | `codex`                                                                                   | Answering-agent engine: `codex` or `claude`      |
| `--agent-model` | engine default                                                                            | Model for the answering agent                    |
| `--judge`       | auto (OpenAI if its key is set, else Anthropic)                                           | Judge provider: `openai` or `anthropic`          |
| `--judge-model` | `gpt-5.4` (openai) / `claude-sonnet-4-5` (anthropic), or `OPENAI_MODEL`/`ANTHROPIC_MODEL` | Model for the judge                              |
| `--embedding`   | `local`                                                                                   | greplica embedding provider for the greplica arm |
| `--queries`     | all                                                                                       | Comma list of query ids                          |
| `--limit`       | all                                                                                       | Run only the first N selected queries            |


## Output

Everything lands in `eval-runs/<timestamp>/agentmemory-coding-life/`:

- `scores.ndjson` — one row per (arm, query): answer, pass, judge reasoning, and agent
token/tool/latency metrics.
- `summary.json` — per-arm pass rate and average tokens / tool calls / latency.
- `run-manifest.json` — arms, models, embedding, query ids, timestamp.
- `<arm>/<query-id>/` — the Codex transcript and final message for each run.
- `greplica/seed.proposal.json` — the proposal seeded into greplica memory.

## How to expand past the MVP

- Add more queries/sessions to `data/` (same JSON shape) — no code change needed.
- Add a retrieval-ranking mode that maps greplica's returned claims back to session ids
for an IR-style score (P@K / R@K) alongside the QA score.
- Add a larger corpus (e.g. LongMemEval-S) behind the same arm/judge harness.
- Add a non-OpenAI agent engine (Cursor SDK / Claude Code) so a non-Codex agent can call
greplica autonomously.
