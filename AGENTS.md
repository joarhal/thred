# AGENTS.md

Operational guide for agents working in this repository.

Last verified: 2026-03-04
Project: `thred` (Codex-driven planning + execution CLI)

## 1) Mission

`thred` turns free-form requirements into executable markdown plans, runs those plans task-by-task, performs iterative review/fix loops, uses recent completed plans as durable context, and moves completed plans to archive.

Primary goal:
- Reliable autonomous execution with strict plan contracts and strong review gates.

Secondary goals:
- Readable terminal UX (interactive planning + execute logs).
- Deterministic artifact and state tracking in `.thred/artifacts/runs`.

## 2) Runtime and Tooling

- Node.js: `>=20`
- Module system: ESM (`"type": "module"`)
- Language: TypeScript
- CLI framework: `commander`
- Terminal UI: `ink` + `react` + `ink-markdown`
- Build: `tsup`
- Tests: `vitest`

Required external binaries at runtime:
- `git`
- `codex`

## 3) High-Level Architecture

Main entrypoints:
- CLI bootstrap: `src/cli.ts`
- Command wiring: `src/commands/execute.ts`

Core subsystems:
- Input resolution: `src/core/input/resolve.ts`
- Plan generation + repair: `src/core/plan/generate.ts`, `src/core/codex/prompts-plan.ts`
- Plan review and auto-revision: `src/core/plan/review.ts`
- Plan parsing and task progression: `src/core/plan/parser.ts`
- Pipeline execution engine: `src/core/pipeline/runner.ts`
- Codex process wrapper: `src/core/codex/runner.ts`
- Git orchestration: `src/core/git/service.ts`
- Review orchestration/parsing/reporting: `src/core/review/*`
- Memory lifecycle: `src/core/memory/service.ts`
- Settings lifecycle: `src/core/settings/service.ts`
- Artifacts/state: `src/core/artifacts/manager.ts`, `src/core/state/store.ts`

Interactive UX:
- Interactive entry/session: `src/core/interactive/entry.ts`, `src/core/interactive/session.ts`
- Full TUI runtime + prompts + preview renderer: `src/core/interactive/ui.tsx`
- Progress logging bridge (sink API): `src/core/progress/logger.ts`

## 4) Execution Flows

## 4.1 Interactive flow (default)

1. `thred` starts interactive mode when `--non-interactive` is absent.
2. TUI initializes in `configureInteractiveOutput`.
3. Session asks for goal (or uses prefilled input), resolves clarifications in a loop.
   - Clarification loop is Codex-first: decision (`needsClarification`) -> question generation.
   - Full conversation history is threaded into each clarification/planning/revision prompt.
4. Draft plan is generated and quality-reviewed before first preview.
5. User can revise plan repeatedly; Enter accepts plan.
6. Execute phase starts in same TUI and streams logs through progress sink.

Key file:
- `src/core/interactive/session.ts`

## 4.2 Non-interactive flow

1. Resolve input (file or inline text).
2. Detect validation commands.
3. Build repository context snapshot.
4. Generate + review plan once.
5. Save plan in `docs/plans`.
6. Execute plan via pipeline.

Key file:
- `src/commands/execute.ts`

## 5) Pipeline Phases and Invariants

Phases in order:
- `preflight`
- `tasks`
- `review`
- `memory`
- `finalize`

Implementation:
- `PipelineRunner.run()` in `src/core/pipeline/runner.ts`

Critical invariants:
- Git-mode preflight uses `GitService.ensureRepoRoot`, auto-checkpoints dirty workspace before execution (`checkpointDirtyWorkspaceBeforeExecution`), and enforces clean-tree invariant via `ensureCleanExceptPlan`.
- Local mode (`--no-git` or non-git workspace) skips git invariants and runs with `isGit=false`.
- Plan format must stay parseable by `parsePlan`.
- Validation commands are mandatory in plan.
- Final review gate blocks `critical` and `high` findings.
- `medium` and `low` findings are mandatory backlog items and must be preserved in tracked backlog handling.
- Plan file is moved to `docs/plans/completed/` at successful finalize.

## 6) Plan Contract (strict)

Accepted markdown shape (required):
- `# Plan: ...`
- `## Overview`
- `## Validation Commands`
- One or more `### Task N: ...` sections (N starts at 1 and is contiguous)
- Checklist items under each task with `- [ ] ...`

Validation parser:
- `src/core/plan/parser.ts`

Common parse failures:
- Missing title
- Missing validation section
- Non-sequential task numbering
- Task without checklist items

## 7) Codex Prompt Contracts

Task/fix prompts require:
- First output line: `OPERATION: <short action title>`
- No markdown fences

Files:
- `src/core/codex/prompts.ts`

Plan generation/review prompts:
- Strict markdown output for plan generation
- Strict JSON output for plan review

Files:
- `src/core/codex/prompts-plan.ts`
- `src/core/plan/review.ts`

Review output schema (required):
- `overallStatus`: `clean` or `issues_found`
- `findings[]` with `id, severity, file, line, summary, rationale`

Parser:
- `src/core/review/parse.ts`

## 8) Git Behavior and Baseline Rules

Execution bootstrap behavior:
- Git mode is enabled only when `git` is available, `--no-git` is not set, and cwd is inside a git work tree.
- In git mode, bootstrap ensures repo/head readiness (`ensureGitWorkspaceReady`) and updates `.gitignore` runtime rules.
- Outside git mode, bootstrap runs fully local without git operations and does not update `.gitignore`.

Implementation:
- `prepareExecutionBootstrap` in `src/core/execute/run-plan.ts`
- `ensureGitWorkspaceReady` in `src/core/git/bootstrap.ts`

Branch policy for plan execution:
- Derive feature branch from plan filename (`branchNameFromPlanPath`).
- If currently on base branch, switch/create target branch.

Commit policy in pipeline:
- Optional preflight checkpoint commit: `chore: checkpoint before execution` (when dirty).
- Commit per completed task.
- Commit per review-fix iteration (if changes exist).
- Commit on moving plan to completed.

## 9) Memory and Settings

Persistent files:
- `.thred/settings.yaml` (model, reasoningEffort, reviewPipeline)

Settings defaults:
- `model: "inherit"`
- `reasoningEffort: "high"`
- `reviewPipeline` defaults are materialized by implicit first-run setup and explicit `thred setup`.

Execution context rule:
- Runtime uses `docs/plans/completed` as execution context; no standalone memory file is used.

Implementation:
- `src/core/settings/service.ts`
- `src/core/context/completed-plans.ts`

## 10) Artifacts and Run State

Workspace artifacts root:
- `.thred/artifacts`

Per-run files:
- `<run-id>.log` from `ProgressLogger`
- `<run-id>.events.jsonl` structured progress events from `ProgressLogger`
- `<run-id>.json` from `RunStateStore`
- `<run-id>.review.json` review report

Known project artifact relocation during validations:
- `test-results`
- `playwright-report`

Implementation:
- `src/core/artifacts/manager.ts`
- `src/core/state/store.ts`
- `src/core/review/report.ts`

## 11) Logging and TUI Model

Important architecture point:
- Interactive and execute outputs are unified through Ink runtime in `src/core/interactive/ui.tsx`.
- `ProgressLogger` supports sink mode (`ProgressLogSink`) so execute logs can render in Ink instead of raw ANSI.
- `ProgressLogger` emits structured `ProgressEvent` objects and persists them as JSONL for post-run analysis.
- In non-sink mode, `ProgressLogger` keeps direct console output behavior.

Noise suppression:
- Some known tool noise lines are filtered in `shouldSuppressToolLine`.

## 12) Validation Command Detection

Auto-detected from `package.json` scripts:
- Prefer `npm test`
- Then `npm run test:coverage` (if present)
- Then `npm run build`
- Fallback `npm run lint` if no test/build
- Final fallback: `git status --short` in git mode, `true` in local mode

Implementation:
- `src/core/plan/validation-detect.ts`

## 13) Project Layout Map

- `src/cli.ts` CLI bootstrap
- `src/commands/execute.ts` top-level command flow
- `src/core/*` runtime core
- `tests/*` unit/integration tests
- `docs/plans/*` generated plans
- `docs/plans/completed/*` archived completed plans
- `site/*` static project website files (not core runtime)

## 14) Change Playbooks

## 14.1 Add a new CLI flag

1. Add option in `registerExecuteCommand`.
2. Parse and validate in `executeFromInput`.
3. Thread through `RunOptions`/`ExecutePlanOptions` as needed.
4. Update tests covering command behavior.

## 14.2 Add a new pipeline phase

1. Extend `Phase` type in `src/types.ts`.
2. Insert phase transition in `PipelineRunner.run()`.
3. Persist phase into `RunStateStore`.
4. Add logs and tests for expected ordering.

## 14.3 Modify plan format

1. Update parser in `src/core/plan/parser.ts`.
2. Update generation prompts in `src/core/codex/prompts-plan.ts`.
3. Update related tests (`plan-parser`, `freeform-plan`, `plan-review`).

## 14.4 Modify review policy

1. Change severity gating in `PipelineRunner.runFinalReview()`.
2. Keep `parseReviewResult` schema-compatible.
3. Update review-related tests and expected summaries.

## 15) Quality Gates Before Finishing Changes

Run in order:
1. `npm run lint`
2. `npm test`
3. `npm run test:coverage`
4. `npm run build`

If behavior changed in TUI/logging:
- Verify interactive run manually for spinner/progress rendering artifacts.

## 16) Common Failure Modes and Debug Tips

- `codex exited with code 1` with little context:
- Re-run with `--verbose` and inspect run log in `.thred/artifacts/runs/*.log`.

- Review parse failures:
- Check that model output is strict JSON and schema fields are present.

- Plan parse failures:
- Ensure `## Validation Commands` exists and each task has checklist items.

- Git cleanliness failures:
- Pipeline requires clean tree except plan/runtime artifacts.

- Interactive UI anomalies:
- Check sink wiring between `executePlan(..., sink)` and `ProgressLogger`.

## 17) Test Inventory (quick pointers)

- CLI/input/settings/memory:
- `tests/input-resolve.test.ts`
- `tests/settings-service.test.ts`
- `tests/memory-service.test.ts`

- Planning:
- `tests/freeform-plan.test.ts`
- `tests/plan-review.test.ts`
- `tests/interactive-prompts.test.ts`
- `tests/plan-parser.test.ts`

- Pipeline/review/logging:
- `tests/pipeline-logging.test.ts`
- `tests/review-orchestrator.test.ts`
- `tests/review-parse.test.ts`
- `tests/review-report.test.ts`
- `tests/logger-verbosity.test.ts`
- `tests/codex-runner.test.ts`

- Git/artifacts:
- `tests/git-service-branching.test.ts`
- `tests/execute-git-bootstrap.test.ts`
- `tests/artifacts-manager.test.ts`
- `tests/preflight-cleanup.test.ts`
- `tests/plan-cleanup.test.ts`

## 18) Agent Working Rules for This Repo

- Keep edits scoped and deterministic.
- Do not change plan contract casually; it impacts generation, parsing, and execution.
- Prefer adding tests alongside behavior changes.
- Keep `.thred` runtime data out of commits unless a task explicitly targets settings/memory logic.
- When changing user-facing logs, preserve concise default output and detailed `--verbose` behavior.
