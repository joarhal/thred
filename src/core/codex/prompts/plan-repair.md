Your previous plan output is invalid and must be fully regenerated.

Parser error:
{{parseError}}

Previous invalid output:
{{previousOutput}}

Regeneration contract:
{{planGenerationPrompt}}

Temporary artifacts rule:
- If you need temporary notes, drafts, or intermediate plan files while repairing, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`).
- Never create extra plan markdown files under `docs/plans/` during repair.

Rewrite the full plan from scratch.
Do not append any usage/telemetry footer (for example:
`tokens used`, `input tokens`, `output tokens`, numbers-only lines).
Return markdown only. No code fences. No explanations.
