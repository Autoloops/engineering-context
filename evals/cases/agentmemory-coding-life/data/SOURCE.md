# Dataset source

`sessions.json` and `queries.json` are the `coding-agent-life-v1` corpus, vendored
verbatim from the AgentMemory project:

- Upstream: https://github.com/rohitg00/agentmemory
- Path: `eval/data/coding-agent-life-v1/`

The corpus is 15 fictional coding-agent sessions for a fictional Rust CLI project
(`shipctl`) plus 15 hand-graded recall queries with gold answers and gold session ids.

It is vendored here (rather than fetched at run time) so this benchmark is pinned and
runs offline. It is used only as a shared question/answer corpus; this benchmark does
not compare against AgentMemory's published numbers.
