# Contributing to thred

Thanks for contributing.

## Project scope

`thred` is currently released as a GitHub source project (`v0.1.0`) and is npm-ready but not npm-published yet.

## Prerequisites

- Node.js `>=20`
- `git`
- `codex`

## Local setup

```bash
git clone <your-fork-or-this-repo-url>
cd thred
npm install
```

## Development workflow

1. Create a branch from your fork.
2. Make focused changes.
3. Run required validation commands:
   - `npm test`
   - `npm run build`
4. Open a pull request using the repository template.

## Contribution guidelines

- Keep changes scoped and deterministic.
- Do not casually change the plan contract shape (`src/core/plan/parser.ts` + prompt contracts).
- Add or update tests when behavior changes.
- Keep runtime `.thred` data out of commits unless directly relevant.
- Keep user-facing logs concise by default; preserve verbose paths.

## Reporting issues

Please use the issue templates for bug reports and feature requests.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
