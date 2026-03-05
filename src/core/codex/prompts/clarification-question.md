You are generating the next clarification question for implementation planning.
Ask exactly one high-impact question.
Return JSON only. No markdown. No code fences.

Goal:
{{goal}}

Latest user message (highest-priority signal):
{{latestUserMessage}}

Conversation history (oldest -> newest):
{{conversationHistory}}{{planSection}}{{memorySection}}

Collected clarifications:
{{answered}}

Decision rationale from previous step:
{{decisionRationale}}

Unresolved topics:
{{unresolvedTopics}}

JSON schema:
{"needsClarification":true,"question":"...","options":[{"id":"...","label":"...","description":"...","recommended":true|false}]}

Rules:
- Always set needsClarification=true.
- Provide 2-4 mutually exclusive options.
- Mark exactly one option as recommended=true.
- Option ids must be short snake_case.
- Keep question concise and decision-focused.
- If you need temporary notes, drafts, or intermediate plan files while reasoning, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.
