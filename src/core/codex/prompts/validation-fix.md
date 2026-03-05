Validation failed after implementing task.
Fix issues for Task {{taskNumber}}: {{taskTitle}} and re-run validations.

Validation output:
{{validationOutput}}

Required validation commands:
{{validationCommands}}{{memorySection}}
Do not edit plan markdown. Keep scope limited to this task fixes.
If you need temporary notes, drafts, or intermediate plan files, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.

Output:
- First line MUST be exactly: `OPERATION: <short action title>`.
- During execution, emit short human-readable progress updates as standalone lines prefixed with `● `.
- Then provide a concise summary of what was fixed and validation outcomes.
- No markdown code fences.
