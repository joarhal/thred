# Stability Backlog (Initial Registry)

## Triage Rules

- `critical` / `high`: release blockers; must be fixed before release tagging.
- `medium` / `low`: mandatory backlog; cannot be dropped, but can be scheduled after blocker closure.
- Every `medium` / `low` item must keep a stable ID (`STAB-XXX`) and a target release stage.
- Allowed target release stages:
  - `next-patch` (closest patch release)
  - `next-minor` (closest minor release)
  - `hardening-window` (explicit post-release hardening cycle)
- Promotion rule: if a `medium` / `low` item misses its target stage, it must be re-triaged in the next release review with an updated target stage and rationale.

## Release Blockers (`critical` / `high`)

No blockers identified in the current baseline run.

## Mandatory Backlog (`medium` / `low`)

| ID | Severity | File:Line | Target Release Stage | Rationale | Status |
| --- | --- | --- | --- | --- | --- |
| STAB-001 | medium | `src/core/plan/validation-detect.ts:48` | `next-patch` | Validation auto-detection previously skipped explicit coverage detection. Closed by deterministic `test:coverage` detection. | resolved |
| STAB-002 | medium | `src/core/plan/validation-detect.ts:102` | `next-patch` | `readPackageJson` previously hid parse/read failures. Closed by explicit diagnostics (`package_json_read_error`, `package_json_parse_error`, `package_json_invalid_*`). | resolved |
| STAB-003 | medium | `src/core/state/store.ts:14` | `hardening-window` | `RunStateStore.write` retry/recovery branch had weak coverage. Closed by deterministic failure/recovery suite over retriable/non-retriable paths. | resolved |
| STAB-004 | low | `src/core/ui/terminal.ts:263` | `next-minor` | Log-level icon/color mapping is duplicated across terminal and Ink UI renderers, creating drift risk for UX consistency. | open |
| STAB-006 | medium | `tests/state-store.test.ts:1` | `hardening-window` | State persistence tests previously missed filesystem failure/retry behavior. Closed by explicit ENOENT/EACCES/EPERM + exhaustion + stale tmp tests. | resolved |

Resolved on 2026-03-04:
- STAB-005 closed after `tests/validation-detect.test.ts` added malformed/unreadable `package.json` fallback coverage.

Resolved on 2026-03-05 (PLAN_PREPROD S1-S6 sync):
- STAB-001, STAB-002 closed by S4 (`src/core/plan/validation-detect.ts`, `tests/validation-detect.test.ts`).
- STAB-003, STAB-006 closed by S3 (`src/core/state/store.ts`, `tests/state-store.test.ts`).

<!-- thred:auto-medium-low:start -->
## Automated Mandatory Backlog (`medium` / `low`)

Generated automatically from mandatory review findings.
Entries are preserved until explicitly marked as resolved.

| ID | Severity | File:Line | Summary | Rationale | Status |
| --- | --- | --- | --- | --- | --- |
| f-good | medium | `src/b.ts:11` | Valid | Because | open |
| REV-004 | low | `docs/review-pipeline.md:67` | Invalid-status restart documentation overstates what triggers `InvalidReviewStatusError`. | Docs imply invalid `overallStatus` alone triggers restart. In code, typed invalid-status error is raised only when `overallStatus` is invalid and `findings` is an array (`src/core/review/parse.ts:86-89`). This can cause incorrect operational expectations during triage. | open |
| REV-006 | low | `tests/pipeline-review-restart.test.ts:29` | Review-restart tests stub `runFinalReview`, so restart interaction with `finalizeExtraCommitPaths` reset is untested. | `runFinalReview` now resets `finalizeExtraCommitPaths` (`src/core/pipeline/runner.ts:342`), but restart tests replace `runFinalReview` with mocks. A stale-path regression across restart/finalize would not be detected. | open |
| REV-001 | medium | `src/core/review/parse.ts:69` | Review parsing rejects valid payloads when any sibling JSON candidate has invalid overallStatus. | Closed in S1: parser now keeps scanning, returns valid candidate(s), and throws only deterministic no-payload/conflict errors when appropriate. | resolved |
| REV-002 | medium | `src/commands/execute.ts:444` | Implicit first-run setup has a non-atomic check-then-write flow that can overwrite concurrent settings changes. | Closed in S2: setup now runs under lock (`withSetupLock`) with guarded cleanup and create-if-absent behavior for settings/review pipeline. | resolved |
| REV-003 | low | `docs/release/stability-audit.md:7` | Coverage scope documentation conflicts with actual Vitest configuration. | Closed in S7 docs sync: audit now reflects real scope (`coverage.include: ["src/**/*.ts"]`). | resolved |
| REV-005 | low | `tests/setup-command.test.ts:122` | Execute-path tests do not verify successful implicit first-run setup behavior when settings files are absent. | Closed in S2: setup tests now cover first-run auto-setup for missing `.thred` and missing settings, plus concurrent `ensureFirstRunSetup` race cases. | resolved |
<!-- thred:auto-medium-low:end -->
