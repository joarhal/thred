# Pre-release Smoke: `test-projects/node-smoke-app`

This scenario validates the package as a release artifact (tarball), not a direct `dist/` run.

## Preconditions

- Run from repository root (`thred`).
- `codex` CLI is installed and authenticated.
- `test-projects/node-smoke-app` is a valid git repo and starts clean (`git -C test-projects/node-smoke-app status --short` is empty).

## Exact Scenario

1. Run mandatory pre-release gates in root:
   - `npm run lint`
   - `npm test`
   - `npm run test:coverage`
   - `npm run build`
2. Build release tarball in root:
   - `rm -f thred-*.tgz`
   - `npm pack`
   - `ls -1 thred-*.tgz`
3. Install the tarball into smoke app:
   - `cd test-projects/node-smoke-app`
   - `rm -rf node_modules .thred`
   - `npm install --no-save ../../thred-*.tgz`
4. Execute CLI from installed tarball:
   - `./node_modules/.bin/thred "add multiply function in src/math.js and tests in test/math.test.js" --non-interactive`
5. Verify smoke app health after execution:
   - `npm test`
   - `find .thred/artifacts/runs -maxdepth 1 -type f | sort`
   - `ls -1 docs/plans/completed`

## Expected Artifacts

- Root tarball exists: `thred-<version>.tgz`.
- Smoke app has installed package binary: `test-projects/node-smoke-app/node_modules/.bin/thred`.
- Smoke run artifacts exist under `test-projects/node-smoke-app/.thred/artifacts/runs`:
  - `<run-id>.log`
  - `<run-id>.events.jsonl`
  - `<run-id>.json`
  - `<run-id>.review.json`
- Smoke app plan is archived in `test-projects/node-smoke-app/docs/plans/completed`.
- Smoke app tests pass (`npm test` in `test-projects/node-smoke-app`).
