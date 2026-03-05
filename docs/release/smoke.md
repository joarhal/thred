# Pre-release Smoke: Ephemeral Node.js Workspace

This scenario validates the package as a release artifact (tarball), not a direct `dist/` run.

## Preconditions

- Run from repository root (`thred`).
- `codex` CLI is installed and authenticated.
- A temporary smoke workspace can be created locally.

## Exact Scenario

1. Run mandatory pre-release gates in root:
   - `npm run lint`
   - `npm test`
   - `npm run test:coverage`
   - `npm run build`
2. Build release tarball in root:
   - `rm -f thred-*.tgz`
   - `npm pack`
   - `tarball="$(pwd)/$(ls -1 thred-*.tgz | tail -n 1)"`
   - `ls -1 thred-*.tgz`
3. Create and enter temporary smoke app:
   - `tmpdir="$(mktemp -d)"`
   - `mkdir -p "$tmpdir/src" "$tmpdir/test"`
   - `cat > "$tmpdir/package.json" <<'JSON'`
   - `{"name":"node-smoke-app","version":"0.0.0","private":true,"type":"module","scripts":{"test":"node --test"}}`
   - `JSON`
   - `cat > "$tmpdir/src/math.js" <<'JS'`
   - `export function sum(a, b) { return a + b; }`
   - `JS`
   - `cat > "$tmpdir/test/math.test.js" <<'JS'`
   - `import assert from 'node:assert/strict';`
   - `import { test } from 'node:test';`
   - `import { sum } from '../src/math.js';`
   - `test('sum adds numbers', () => { assert.equal(sum(2, 3), 5); });`
   - `JS`
   - `cd "$tmpdir"`
4. Install the tarball into smoke app:
   - `npm install --no-save --no-package-lock "$tarball"`
5. Execute CLI from installed tarball:
   - `./node_modules/.bin/thred "add multiply function in src/math.js and tests in test/math.test.js" --non-interactive`
6. Verify smoke app health after execution:
   - `npm test`
   - `find .thred/artifacts/runs -maxdepth 1 -type f | sort`
   - `ls -1 docs/plans/completed`

## Expected Artifacts

- Root tarball exists: `thred-<version>.tgz`.
- Smoke app has installed package binary: `node_modules/.bin/thred`.
- Smoke run artifacts exist under `.thred/artifacts/runs`:
  - `<run-id>.log`
  - `<run-id>.events.jsonl`
  - `<run-id>.json`
  - `<run-id>.review.json`
- Smoke app plan is archived in `docs/plans/completed`.
- Smoke app tests pass (`npm test` in the temporary workspace).
