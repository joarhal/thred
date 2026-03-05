# Target Release State for `thred v0.1.0` (GitHub + npm)

## Goal
Final state: repository and package are release-consistent, where GitHub release and npm publish are reproducible, verifiable, and protected by mandatory gates.
A release is complete only when all hard-blocker criteria below are satisfied.

## 1. Desired End State (Product View)

## 1.1 Git and GitHub
- `origin` points to the public GitHub repository.
- Releases are cut only from `main`.
- Annotated tag `v0.1.0` exists with release message.
- CI runs on `push`, `pull_request`, and `push tags: v*`.
- All required CI jobs are green for `v0.1.0`.

## 1.2 npm publishing
- `npm whoami` succeeds in release environment.
- `package.json` contains explicit `publishConfig`.
- `prepublishOnly` enforces local publish safety.
- No `@types/*` packages in runtime `dependencies`.
- `npm pack --dry-run` tarball includes required runtime files only.

## 1.3 Quality and gates
- Mandatory quality gates are fixed and aligned between docs and CI:
1. `npm run lint`
2. `npm test`
3. `npm run test:coverage`
4. `npm run build`
- Coverage policy is explicit:
- target baseline: 95/95/95/95
- temporary minimum for `v0.1.0`: at least 80% on every metric, with explicit release-doc rationale
- `npm run test:coverage` passes on release commit with current thresholds.

## 1.4 Release docs and evidence
- `docs/release/checklist.md`, `docs/release/stability-audit.md`, and `docs/release/v0.1.0.md` match release `HEAD`.
- No placeholders (`TBD/TODO/PLACEHOLDER`) at sign-off.
- Checklist contains real links to CI runs/artifacts proving gates.
- `CHANGELOG.md` includes `0.1.0` section.

## 1.5 Smoke and post-publish
- Tarball smoke passed before release:
- install from local tarball
- `thred --help` works
- smoke on `test-projects/node-smoke-app`
- Post-publish verification passed:
- clean install from npm
- `thred --help` works
- metadata links (`repository/bugs/homepage`) are correct.

## 2. Non-negotiable Core (NO-GO if missing)
1. `origin` configured; push to GitHub works.
2. `npm whoami` works.
3. `test:coverage` passes with approved thresholds and minimum 80%.
4. `prepublishOnly` is present (`lint + build + test`).
5. `@types/react` removed from runtime dependencies.
6. CI triggers on `v*` tags.
7. `publishConfig` is present (`public` + npmjs registry).
8. Annotated tag `v0.1.0` exists.
9. Release docs are synchronized with reality.
10. `CHANGELOG.md` with `0.1.0` is present.

## 3. Release Execution Map

## T-2 (Preparation)
- Bring `package.json` to target contract (`prepublishOnly`, `publishConfig`, dependency split).
- Align coverage policy and `vitest` thresholds.
- Ensure CI supports `tags: v*`.
- Align release docs with current policy.
- Prepare `CHANGELOG.md` (`0.1.0`).

## T-1 (Freeze)
- Run all 4 mandatory gates locally.
- Validate tarball via `npm pack --dry-run` (allowlist/blocklist).
- Run `npm audit --omit=dev --audit-level=high`.
- Execute smoke flow from tarball.
- Merge release branch into `main` and wait for green CI.

## T0 (Release)
- Create annotated tag `v0.1.0`, push `main` and tag.
- Wait for green tag CI.
- Fill checklist with real CI links; complete sign-off.
- Create GitHub Release from `CHANGELOG`.
- Run `npm publish` (guarded by `prepublishOnly`).

## T+1 (Verification)
- Verify npm install in clean environment.
- Verify `thred --help`.
- Verify metadata links in npm and GitHub Release.

## 4. Public Contract Changes

## 4.1 `package.json`
- Add `scripts.prepublishOnly`.
- Add `publishConfig`.
- Correct `dependencies` vs `devDependencies` split.
- Keep `bin.thred -> dist/cli.js`.

## 4.2 CI contract
- Workflow must include tag trigger `v*`.
- Release-ready status requires all 4 mandatory jobs.

## 4.3 Documentation contract
- Release docs are a verifiable source of truth (no placeholders; with CI evidence links).

## 5. Test Scenarios and Acceptance

## 5.1 Mandatory scenarios (pass/fail)
1. `npm run lint` passes.
2. `npm test` passes.
3. `npm run test:coverage` passes.
4. `npm run build` passes.
5. `npm pack --dry-run` includes only expected files.
6. `npm whoami` succeeds.
7. Tarball smoke scenario succeeds.
8. CI for release commit is green.
9. Annotated `v0.1.0` points to commit from `main`.
10. Checklist/sign-off contain real CI links.

## 5.2 Release completion criteria
- GitHub release for `v0.1.0` is published.
- `thred@0.1.0` is published to npm and installs in clean environment.
- All items in 5.1 are confirmed.

## 6. Assumptions and Defaults
- Ownership model: single maintainer (`@joarhal`) signs off release.
- Base release branch: `main`.
- Current release version: `0.1.0`.
- `v0.1.0` allows pragmatic hardening without full release automation complexity.
- If coverage is below 80% on any axis, release is blocked.
- Evidence is stored as CI run/artifact links, not large log blobs committed to repo.
