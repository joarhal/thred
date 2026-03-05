# Changelog

All notable changes to this project are documented in this file.

## v0.1.0 - 2026-03-04

Initial public GitHub release of `thred` (`0.1.0`).

### Added

- Codex-only autonomous plan execution CLI (`thred`).
- Interactive planning session with clarification loop and in-session execution.
- Non-interactive generate-and-execute flow for automation.
- Strict markdown plan contract with parser validation.
- Pipeline phases: `preflight`, `tasks`, `review`, `memory`, `finalize`.
- Review orchestration and severity-based final gate (`critical` blocks completion).
- Run artifacts and structured progress event persistence in `.thred/artifacts/runs`.
- Memory/settings lifecycle management in `.thred`.
- Baseline test suite and TypeScript build pipeline.
