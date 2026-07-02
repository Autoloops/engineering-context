# Contributing to Greplica

Thank you for your interest in contributing to Greplica! This guide will help you set up your development environment, understand the repository layout, and submit contributions.

---

## Development Setup

### Prerequisites
- **Node.js**: Requires version `>=22.0.0 <27.0.0`.
- **npm**: Standard npm package manager.

### 1. Clone the repository
```bash
git clone https://github.com/<your-username>/greplica.git
cd greplica
```

### 2. Install dependencies
```bash
npm install
```

### 3. Build the project
This compiles the TypeScript code from `apps/` and `libs/` into the `dist/` directory:
```bash
npm run build
```

---

## Running Tests & Evals

Before proposing changes, ensure all typechecks, tests, and code-style audits pass:

### 1. Typecheck
```bash
npm run typecheck
```

### 2. Run Integration Tests
Runs the Node assert integration test scripts:
```bash
npm test
```

### 3. Run Search Evaluation & Optimization
To verify retrieval performance and weight configs:
```bash
npm run eval:search-current
```

---

## Submitting Pull Requests

1. **Create a branch**: Create a descriptive topic branch (`git checkout -b feature/my-cool-feature`).
2. **Commit changes**: Make focused, small commits. Please write clear, imperative commit messages.
3. **Fill out the PR Template**: Our pull request template contains a summary table of changes and an AI tooling disclosure.
   - If you used an AI assistant (like Claude Code, Copilot, or ChatGPT) to write the code, please check the AI disclosure boxes to confirm you have manually reviewed and verified every line of code to prevent regressions.
4. **Push and open PR**: Push your branch to your fork and submit a PR to the `main` branch of the upstream repository.
