Apply fixes for the following review findings.
Focus only on valid and actionable issues.

Findings JSON: {{findingsJson}}

After fixes run all validations:
{{validationCommands}}
If you need temporary notes, drafts, or intermediate plan files, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.

Output:
- First line MUST be exactly: `OPERATION: <short action title>`.
- During execution, emit short human-readable progress updates as standalone lines prefixed with `● `.
- Then return a concise summary of fixes and validation results.
- No markdown code fences.
