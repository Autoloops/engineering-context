# Contributing to Greplica

Thanks for your interest in contributing to Greplica! This guide will help you get started.

## Prerequisites

- **Node.js 22–26** (enforced by the project)
- **npm** (comes with Node.js)
- **Git**

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-github-username>/greplica.git
   cd greplica
   git remote add upstream https://github.com/Autoloops/greplica.git
   ```
3. **Install dependencies**:
   ```bash
   npm ci
   ```
4. **Verify your setup** by running the full test suite:
   ```bash
   npm test
   ```

## Development Workflow

1. Create a new branch for your change:
   ```bash
   git checkout -b fix/short-description
   # or
   git checkout -b feat/short-description
   ```
2. Make your changes
3. Run type checking and tests before committing:
   ```bash
   npm run typecheck
   npm test
   ```
4. Commit with a clear message describing what changed and why
5. Push and open a Pull Request against `main`

## Project Structure

```
greplica/
├── apps/cli/              # CLI entry point and commands
├── libs/
│   ├── config/            # Configuration management
│   ├── hooks/             # Agent session hooks
│   ├── install/           # Multi-platform install system
│   │   └── platforms/     # Platform-specific installers (8 platforms)
│   ├── knowledge-graph/   # Core knowledge graph engine
│   │   ├── graph-context/ # Context retrieval (BM25, embeddings, ranking)
│   │   ├── code-anchors/  # Code anchor resolution
│   │   └── dedupe/        # Claim deduplication
│   ├── managed/           # Shared managed API contracts
│   ├── session-transcript/ # Transcript parsing
│   └── storage/sqlite/    # SQLite storage layer
├── scripts/               # Test and build scripts
├── skills/                # Agent skill definitions
├── evals/                 # Evaluation framework
└── docs/                  # Documentation and assets
```

## Code Style

- **TypeScript** with strict mode enabled
- **ESM modules** (`"type": "module"` in package.json)
- Target: **ES2022**, module system: **NodeNext**
- Follow existing patterns in the codebase — match naming, imports, and structure of neighboring files
- Keep functions focused and small; prefer composing small utilities over monolithic handlers

## Testing

There is no formal test framework — tests are standalone Node.js scripts using `node:assert/strict`.

| Command                                   | What it runs                              |
| ----------------------------------------- | ----------------------------------------- |
| `npm test`                                | Build + all check scripts sequentially    |
| `npm run test:transcript-bundle`          | Transcript bundle test                    |
| `npm run test:repo-context`               | Repo context detection test               |
| `npm run test:source-memberships`         | Source memberships test                   |
| `npm run test:opencode-sqlite-transcript` | OpenCode SQLite transcript test           |

Smoke tests verify platform installers:

```bash
npm run smoke:openhands
npm run smoke:copilot
npm run smoke:opencode
npm run smoke:cursor
npm run smoke:factory-droid
```

When adding new functionality, add a corresponding `scripts/check-*.js` test script and include it in the `npm test` pipeline in `package.json`.

## Submitting a Pull Request

1. Ensure `npm run typecheck` and `npm test` pass
2. Keep PRs focused — one logical change per PR
3. Write a clear PR description explaining **what** changed and **why**
4. Reference any related issues (e.g., `Closes #12`)
5. Keep commits clean — avoid mixing unrelated changes

## Reporting Issues

Open an issue on GitHub with:

- A clear title and description
- Steps to reproduce (if applicable)
- Expected vs actual behavior
- Your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
