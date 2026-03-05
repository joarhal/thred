Rewrite the execution plan according to new user feedback.
Return markdown only, no code fences.

Original goal:
{{goal}}{{memorySection}}{{contextSection}}{{conversationHistorySection}}

Clarifications:
{{clarifications}}

Latest plan draft:
{{previousPlan}}

Revision feedback:
{{revisionFeedback}}

Output requirements:
- Top title must be `# Plan: ...`.
- Include `## Overview`.
- Include `## Validation Commands` with ONLY these commands:
{{validationCommands}}
- Include task sections in exact format: `### Task N: <title>` with sequential numbering from 1.
- Under each task include one or more checklist lines: `- [ ] ...`.
- Keep task count between 2 and 8.
- Do not add extra sections.
- Do not ignore unresolved user intent from conversation history.
- If you need temporary notes, drafts, or intermediate plan files, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.
