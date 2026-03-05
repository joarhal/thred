# thred

[![CI](https://github.com/joarhal/thred/actions/workflows/ci.yml/badge.svg)](https://github.com/joarhal/thred/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/thred.svg)](https://www.npmjs.com/package/thred)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`thred` is a Codex-driven CLI that turns free-form requirements into executable plans, runs them task-by-task, and enforces review gates before completion.

## Why thred

- Turns plain-language requirements into a strict markdown plan.
- Executes tasks incrementally with progress and artifacts.
- Runs multi-agent review/fix loops with severity gates.
- Persists run state and review reports in `.thred/artifacts/runs`.
- Keeps lightweight project memory between runs.

## Requirements

- Node.js `>=20`
- `codex` CLI available in `PATH` and already authenticated
- `git` (recommended; optional with `--no-git`)

## Quick Start

Run directly from npm:

```bash
npx thred --help
```

Start interactive planning + execution in current repo:

```bash
npx thred
```

Create and run from inline requirement:

```bash
npx thred "implement onboarding with email auth"
```

Run non-interactive:

```bash
npx thred "implement onboarding with email auth" --non-interactive
```

## Core Commands

### `thred [input]`
Create a new plan from free-form input and execute it.

`input` can be:
- path to a requirement file (for example `CONCEPT.md`)
- inline text

### `thred new [input]`
Explicit alias of the default “create + execute” flow.

### `thred setup`
Initializes `.thred/settings.yaml` and default review pipeline in create-if-absent mode.

Important behavior:
- Existing settings are preserved.
- Existing `reviewPipeline` is not overwritten.

## Common Options

- `--model <id>`: override model for this run
- `--reasoning-effort <level>`: `low | medium | high | xhigh`
- `--sandbox <mode>`: `read-only | workspace-write | danger-full-access`
- `--non-interactive`: skip interactive planning dialog
- `--no-git`: run fully local without git operations
- `--wait-on-limit <duration>`: max wait on model rate limits (default `30m`)
- `--verbose`: detailed tool/progress output
- `--no-color`: disable colored output

## First Run and Settings

On first run, `thred` creates `.thred/settings.yaml` if absent.

Typical file shape:

```yaml
model: inherit
reasoningEffort: high
reviewPipeline:
  version: 1
  passes:
    baseline_scan:
      kind: scan
      severities: [critical, high, medium, low]
      agents: [implementation, quality, testing, simplification, documentation]
    stabilize:
      kind: fix_loop
      severities: [critical, high, medium, low]
      agents: [implementation, quality, testing, simplification]
      maxIterations: 4
      patience: 2
    final_gate:
      kind: scan
      severities: [critical, high, medium, low]
      agents: [implementation, quality, testing, simplification, documentation]
```

## What Gets Written

During execution, `thred` writes run artifacts to:

- `.thred/artifacts/runs/<run-id>.log`
- `.thred/artifacts/runs/<run-id>.events.jsonl`
- `.thred/artifacts/runs/<run-id>.json`
- `.thred/artifacts/runs/<run-id>.review.json`

Generated plans are saved in `docs/plans/` and moved to `docs/plans/completed/` on successful completion.

## Exit Gates

A standard run is expected to pass:

1. `npm run lint`
2. `npm test`
3. `npm run test:coverage`
4. `npm run build`

Review gate blocks unresolved `critical/high` findings.

## Troubleshooting

### `codex: command not found`
Install Codex CLI and ensure it is available in `PATH`.

### Rate-limit waits look like hangs
`thred` may wait on provider rate limits. Tune with `--wait-on-limit`.

### Existing `settings.yaml` did not change after `setup`
`setup` is create-if-absent for `reviewPipeline`. Remove or edit `reviewPipeline` manually if you want a different template.

### Want local-only execution without git commits/branches
Use `--no-git`.

## Development

```bash
npm ci
npm run lint
npm test
npm run test:coverage
npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT, see [LICENSE](./LICENSE).
