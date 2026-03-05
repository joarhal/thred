# Release Checklist (GitHub Readiness)

## Explicit Release Blockers (Hard Stop)

Release must not proceed if any condition below is true:

- Any `critical` or `high` finding exists in the latest review output (`.thred/artifacts/runs/*.review.json`) or `docs/release/stability-backlog.md`.
- Any mandatory quality gate fails (`npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`).
- Pre-release smoke tarball scenario for `test-projects/node-smoke-app` fails (tarball build/install/CLI run/artifact verification).

## CI

- [x] `.github/workflows/ci.yml` added and verified: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
- [x] CI uses Node.js `20.x` (LTS floor for this project).
- [x] CI runs required quality scripts sequentially:
  - `npm ci`
  - `npm run lint`
  - `npm test`
  - `npm run test:coverage`
  - `npm run build`
- [x] `critical/high` release-blocking policy (unit gate + failure-path integration) is covered by automated tests: [`tests/pipeline-review-gate.test.ts`](../../tests/pipeline-review-gate.test.ts), [`tests/node-smoke-integration.test.ts`](../../tests/node-smoke-integration.test.ts).
- [x] Mandatory `medium/low` backlog policy is covered by automated review-report tests: [`tests/review-report.test.ts`](../../tests/review-report.test.ts).
- [x] These policy tests are included in mandatory `npm test` run (`vitest run`): [`package.json`](../../package.json).

## PLAN_PREPROD S1-S6 Alignment (2026-03-05)

- [x] `S1` parser/orchestrator contract synced:
  - `parseReviewResult` deterministically handles candidate streams: `0` valid -> `NoPayloadFoundError`, `1` valid -> returns payload, `N` valid with one status -> returns last payload, `N` valid with conflicting statuses -> `ConflictingPayloadsError`.
  - `runReview` retries parse/execution failures with actionable diagnostics (`attempt`, `code`, candidate/status metadata) and fails with typed `ReviewOrchestratorError` after retry budget exhaustion.
- [x] `S3` state persistence synced: `RunStateStore.write` retries retriable filesystem errors (`ENOENT`/`EACCES`/`EPERM`) with fixed delays and removes stale `.tmp` artifacts safely.
- [x] `S2` setup concurrency synced: setup path uses lock-guarded create-if-absent semantics and does not destructively overwrite existing `.thred/settings.yaml`.
- [x] `S4` validation detection synced: detector now includes explicit `test:coverage` command detection and emits explicit `package_json_*` diagnostics for unreadable/invalid `package.json` and invalid `scripts` shape.
- [x] `S6` observability synced: runtime diagnostics remain concise in default console output, while `verboseDetail` is preserved in debug events and shown inline in `--verbose` mode.
- [x] `P1` status: `completed` (`S2` + `S4` delivered).
- [x] `P1` related risks (accepted for pre-prod, no `critical/high` impact):
  - Setup lock is fail-fast after bounded wait (`SETUP_LOCK_TIMEOUT_MS=5000`) under prolonged contention.
  - Invalid `package.json` still degrades command quality to safe fallback, but now always emits explicit diagnostics.

## Smoke Scenario

- [x] CLI smoke scenario documented for `test-projects/node-smoke-app`.
- [x] Smoke instructions: `docs/release/smoke.md`.

## Local Quality Gates (pre-release)

Run date: `2026-03-05`
Evidence below is captured on current `HEAD`.

- [x] `npm run lint` (evidence: [`docs/release/evidence/2026-03-05-lint.txt`](./evidence/2026-03-05-lint.txt))
- [x] `npm test` (evidence: [`docs/release/evidence/2026-03-05-test.txt`](./evidence/2026-03-05-test.txt); snapshot: `55` files, `335` tests)
- [x] `npm run test:coverage` (pass; evidence: [`docs/release/evidence/2026-03-05-test-coverage.txt`](./evidence/2026-03-05-test-coverage.txt); thresholds: `83/93/83/78`; snapshot: lines `83.96%`, functions `93.34%`, statements `83.96%`, branches `78.89%`)
- [x] `npm run build` (evidence: [`docs/release/evidence/2026-03-05-build.txt`](./evidence/2026-03-05-build.txt))

Summary: [`docs/release/evidence/2026-03-05-quality-summary.env`](./evidence/2026-03-05-quality-summary.env)

## PLAN_PREPROD Task 8 DoD

- [x] Final quality gates passed on current `HEAD`: `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`.
- [x] No new `critical/high` blockers in baseline backlog triage (`Release Blockers` section in [`docs/release/stability-backlog.md`](./stability-backlog.md)).
- [x] Mandatory `medium/low` findings remain tracked in backlog (open: `STAB-004`, `REV-004`, `REV-006`; resolved entries preserved).
- [x] DoD confirmed: `P0` closed fully, `P1` completed with accepted low residual risks, reliability defect classes are not reproducible in current regression and gate runs.

## Final Pre-release Sign-off

- Verdict: `NO-GO`
- Date: `2026-03-05`
- Reason: mandatory quality gates are green, but release remains blocked until E2E smoke (`test-projects/node-smoke-app`) and release artifact checks are completed and recorded as `pass` in `docs/release/stability-audit.md`.
