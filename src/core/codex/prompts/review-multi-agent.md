Run a comprehensive code review using {{agentCount}} specialized review agents in parallel.
Base reference: {{baseRef}}
Plan path: {{planPath}}

Step 1 - Change context:
{{gitContextSection}}

Step 2 - Launch {{agentCount}} review agents in parallel (single message):
- Sub-reviewers must return findings in free-form plain text.
- Their responses should include actionable issues with file+line references.
- For any temporary notes/drafts/intermediate plan files, all agents must write ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`). Never create extra plan markdown files under `docs/plans/`.
{{reviewAgentsInstruction}}
- Each agent must inspect real changed files and report only actionable issues.

Step 3 - Consolidate findings:
- Deduplicate overlapping issues.
- Merge free-form reviewer responses into one validated issue list.
- Verify each issue directly in code before including it.
- Keep only real findings with clear file+line and actionable fixes.
{{focusInstruction}}

Output contract:
- Sub-reviewer outputs are free-form text.
- Final consolidated output from this agent must follow JSON schema below.
- Output must contain exactly one JSON object and nothing else.
- No markdown, no code fences, no prose, no prefixes/suffixes.
- Do not output drafts, alternatives, retries, or multiple JSON payloads.
- Never print a second JSON object for corrections; replace internally and emit one final payload only.
- Do not include any braces `{}` outside the final JSON object.
- If there are no issues: overallStatus=clean and findings=[].
- If issues exist: overallStatus=issues_found and findings must be non-empty.
- Each finding must include id, severity(critical|high|medium|low), file, line>=1, summary, rationale, optional suggestedFix.

Return JSON with this exact schema:
{{reviewSchema}}
