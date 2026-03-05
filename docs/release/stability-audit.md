# Stability Audit (2026-03-05)

## Coverage Scope and Gate Configuration

Current `vitest.config.ts` coverage scope:

- Include: `src/**/*.ts`
- Exclude: `test-projects/**`, `src/types.ts`, `src/types/**/*.d.ts`

Current global thresholds:

- Lines: `83`
- Statements: `83`
- Functions: `93`
- Branches: `78`

## Command Evidence Snapshot (2026-03-05)

| Command | Result | Notes |
| --- | --- | --- |
| `npm run lint` | pass | Exit `0`; evidence: [`docs/release/evidence/2026-03-05-lint.txt`](./evidence/2026-03-05-lint.txt). |
| `npm test` | pass | Exit `0`; all suites in the captured run passed (`55` test files, `335` tests): [`docs/release/evidence/2026-03-05-test.txt`](./evidence/2026-03-05-test.txt). |
| `npm run test:coverage` | pass | Exit `0`; global coverage passed configured thresholds (`83/93/83/78`) with metrics lines `83.96%`, functions `93.34%`, statements `83.96%`, branches `78.89%`; evidence: [`docs/release/evidence/2026-03-05-test-coverage.txt`](./evidence/2026-03-05-test-coverage.txt). |
| `npm run build` | pass | Exit `0`; `tsup` build and prompt copy completed; evidence: [`docs/release/evidence/2026-03-05-build.txt`](./evidence/2026-03-05-build.txt). |

Summary of command exit codes:
- [`docs/release/evidence/2026-03-05-quality-summary.env`](./evidence/2026-03-05-quality-summary.env)

## CI and Review Gate Synchronization Evidence

- CI sequential quality flow (`lint` -> `test` -> `test:coverage` -> `build`): [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- `critical/high` release-blocking behavior in pipeline review gate tests: [`tests/pipeline-review-gate.test.ts`](../../tests/pipeline-review-gate.test.ts)
- Mandatory `medium/low` backlog handling tests: [`tests/review-report.test.ts`](../../tests/review-report.test.ts)
- `npm test` executes all test suites via `vitest run`: [`package.json`](../../package.json)

## Requirements Traceability Matrix

| Requirement Area | Acceptance Criterion | Evidence Source | Gate Status |
| --- | --- | --- | --- |
| Unit tests | Core units in `src/**` are covered and passing in mandatory test run. | `npm test`, suites in `tests/*` (module-level tests). | pass |
| Integration tests | Cross-module execution paths pass, including pipeline/review/state integrations. | `npm test`, integration-oriented suites (`pipeline-*`, `review-*`, `execute-*`). | pass |
| CLI tests | CLI contracts and command orchestration are validated in automated tests. | `npm test`, suites `tests/cli-*.test.ts`, `tests/execute-*.test.ts`. | pass |
| E2E smoke (`test-projects/node-smoke-app`) | Pre-release smoke scenario succeeds in non-interactive mode against smoke project. | `docs/release/smoke.md` scenario and resulting `.thred` run artifacts in smoke app. | pending per release run |
| Release artifact checks | Release tarball is buildable/installable and includes runnable `thred` binary. | `npm pack`/tarball smoke from `docs/release/smoke.md`; release evidence in checklist. | pending per release run |

## PLAN_PREPROD S1-S6 Alignment Snapshot

| Stage | Status | Evidence |
| --- | --- | --- |
| `S1` Parser Robustness | done | [`src/core/review/parse.ts`](../../src/core/review/parse.ts), [`src/core/review/orchestrator.ts`](../../src/core/review/orchestrator.ts), [`tests/review-parse.test.ts`](../../tests/review-parse.test.ts), [`tests/review-orchestrator.test.ts`](../../tests/review-orchestrator.test.ts) |
| `S3` State Persistence Resilience | done | [`src/core/state/store.ts`](../../src/core/state/store.ts), [`tests/state-store.test.ts`](../../tests/state-store.test.ts) |
| `S2` Setup Concurrency Safety | done | [`src/commands/execute.ts`](../../src/commands/execute.ts), [`tests/setup-command.test.ts`](../../tests/setup-command.test.ts), [`tests/review-pipeline-config.test.ts`](../../tests/review-pipeline-config.test.ts) |
| `S4` Validation Detection Hardening | done | [`src/core/plan/validation-detect.ts`](../../src/core/plan/validation-detect.ts), [`tests/validation-detect.test.ts`](../../tests/validation-detect.test.ts) |
| `S6` Observability | done | [`src/core/state/store.ts`](../../src/core/state/store.ts), [`src/core/pipeline/runner.ts`](../../src/core/pipeline/runner.ts), [`src/core/progress/logger.ts`](../../src/core/progress/logger.ts), [`tests/state-store.test.ts`](../../tests/state-store.test.ts), [`tests/logger-verbosity.test.ts`](../../tests/logger-verbosity.test.ts) |

## Parser/Orchestrator Contract Snapshot

- `parseReviewResult` now follows deterministic branching: `0` valid payloads -> `NoPayloadFoundError`; `1` valid payload -> return it; `N` valid payloads with one status -> return last payload; `N` valid payloads with mixed statuses -> `ConflictingPayloadsError`.
- Neighbor invalid JSON candidates do not invalidate adjacent valid payloads: parser keeps scanning and only fails after full candidate evaluation.
- `runReview` emits actionable retry warnings for parse/execution failures (attempt counters, error code, candidate/status metadata) and throws typed `ReviewOrchestratorError` with diagnostic hint when retries are exhausted.

## Runtime Diagnostics Snapshot

- Validation command detection reports explicit `package_json_*` diagnostics for read/parse/shape/script issues and falls back to safe command selection when detection is not possible.
- Run-state persistence emits structured diagnostics by reliability branch: `run_state_retry` (`WARN`), `run_state_recovered_after_retry`/`run_state_stale_tmp_removed` (`INFO`), `run_state_retry_exhausted`/`run_state_non_retriable_failure` (`ERROR`).
- Default console output stays concise (summary only); `verboseDetail` is retained in debug event stream (`*.events.jsonl`) and shown inline in `--verbose` mode.

## P1 Status (Setup + Validation)

- Status: `completed` (both `S2` and `S4` are delivered and covered by deterministic test suites).
- Residual risk 1 (`low`, accepted): setup lock is bounded by timeout (`SETUP_LOCK_TIMEOUT_MS=5000`) and may fail fast under sustained contention.
- Residual risk 2 (`low`, accepted): invalid `package.json` still triggers fallback validation commands, but now emits explicit diagnostics (`package_json_*`) for operator visibility.
- Release-blocking impact: none (`critical/high` not introduced by P1 scope).

## Coverage Snapshot (`npm run test:coverage`)

- Lines: `83.96%`
- Functions: `93.34%`
- Statements: `83.96%`
- Branches: `78.89%`

## Final Review and Backlog Gate (Task 8)

- Latest baseline triage shows no release blockers in `critical/high` class: [`docs/release/stability-backlog.md`](./stability-backlog.md) (`Release Blockers` section).
- Mandatory `medium/low` backlog remains preserved and explicit; open items stay tracked with stable IDs and target stages (`STAB-004`, `REV-004`, `REV-006`): [`docs/release/stability-backlog.md`](./stability-backlog.md).
- Enforcement is covered in automated tests and executed in the required gate run: [`tests/pipeline-review-gate.test.ts`](../../tests/pipeline-review-gate.test.ts), [`tests/review-report.test.ts`](../../tests/review-report.test.ts), [`docs/release/evidence/2026-03-05-test.txt`](./evidence/2026-03-05-test.txt).

## PLAN_PREPROD Definition of Done (Task 8)

- `P0` closed: parser mixed-candidate and state write recovery reliability fixes are implemented and protected by deterministic regression suites (`tests/review-parse.test.ts`, `tests/state-store.test.ts`).
- `P1` status: completed (`S2` + `S4`), residual risks documented as `low` and non-blocking.
- Reliability defect classes are not reproducible in current mandatory gate runs (`npm test`, `npm run test:coverage`).

## Final Pre-release Sign-off

- Decision: `NO-GO`
- Date: `2026-03-05`
- Reason: PLAN_PREPROD reliability gates are green, but release sign-off remains blocked until E2E smoke and release artifact checks are completed and recorded as `pass`.
