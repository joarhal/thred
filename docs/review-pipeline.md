# Review Pipeline Configuration

`thred` can run review passes from a project-defined YAML section instead of hardcoded stage names.

## Config file locations

Configuration is loaded from:

1. `.thred/settings.yaml` -> `reviewPipeline` (when present)
2. Legacy fallback: `.thred/review-pipeline.json`
3. Built-in defaults when:
   - no pipeline config file exists, or
   - `.thred/settings.yaml` exists but does not define `reviewPipeline`

First-run bootstrap behavior:
- `thred` and `thred new` perform implicit first-run initialization when both `.thred/settings.yaml` and legacy `.thred/settings.json` are missing.
- This includes both cases: `.thred/` missing and `.thred/` already present but without either settings file.
- This implicit path creates `.thred/settings.yaml` with default `reviewPipeline` included.

`thred setup` differs from implicit bootstrap:
- It rewrites `.thred/settings.yaml` with current default values.
- It writes the default `reviewPipeline` into settings.

## Built-in default pass/agent mapping

When no project-specific review pipeline is provided, defaults are:

- `baseline_scan`: `scan` for `critical|high|medium|low`, agents = `implementation, quality, testing, simplification, documentation`
- `stabilize`: `fix_loop` for `critical|high|medium|low`, agents = `implementation, quality, testing, simplification`
- `final_gate`: `scan` for `critical|high|medium|low`, agents = `implementation, quality, testing, simplification, documentation`

## YAML schema

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

## Pass fields

- `passes.<pass_id>`: pass id comes from the mapping key, `[a-zA-Z0-9_-]+`
- `kind`: `scan` or `fix_loop` (`fix-loop` alias is accepted)
- `severities`: non-empty subset of `critical`, `high`, `medium`, `low`
- `agents` (optional): list of review agent ids for this pass
  - If omitted, all available agents are used
  - Agent ids come from built-in `src/core/codex/prompts/review-agents/*.md`
  - Project-specific agents can be added in `thred.review-agents/*.md`
- `maxIterations` (required for `fix_loop`): non-negative integer
- `patience` (optional for `fix_loop`): non-negative integer, default `0`

## Loop stop rules (`fix_loop`)

A `fix_loop` pass stops when one of the following happens:

- No findings remain in its `severities` scope
- `patience` unchanged rounds reached (`no commit` and findings signature unchanged)
- `maxIterations` reached

## Invalid `overallStatus` recovery

During final review, invalid `overallStatus` parse errors trigger a full review restart.

- Trigger: parser raises `InvalidReviewStatusError` (status key exists but value is not `clean|issues_found`)
- Retry limit: `2` restarts (up to `3` total attempts including the initial run)
- After limit exhaustion: run fails and surfaces the parse error

## Final gate

The final blocking gate is `critical` + `high`.
`medium` and `low` findings are reported as warnings and are written to the mandatory stability backlog.

## Severity migration note

Legacy severities are normalized during parsing/validation:

- `major` -> `high`
- `minor` -> `medium`

## Example: add documentation-only loop

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
    documentation_sweep:
      kind: fix_loop
      severities: [medium, low]
      agents: [documentation]
      maxIterations: 2
      patience: 1
    final_gate:
      kind: scan
      severities: [critical, high, medium, low]
      agents: [implementation, quality, testing, simplification, documentation]
```
