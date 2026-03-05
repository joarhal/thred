You are implementing a single plan task.

Plan title: {{planTitle}}
Current task: Task {{taskNumber}}: {{taskTitle}}

Complete ONLY this task and its checklist items:
{{taskItems}}

Constraints:
- Do not edit the plan markdown file.
- Keep changes scoped to this task only.
- Run required validation commands and fix failures.
- If you need temporary notes, drafts, or intermediate plan files, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.

Validation commands:
{{validationCommands}}{{memorySection}}
Output:
- First line MUST be exactly: `OPERATION: <short action title>`.
- During execution, emit short human-readable progress updates as standalone lines prefixed with `● `.
- Then provide a short summary of changes and validation outcomes.
- No markdown code fences.
