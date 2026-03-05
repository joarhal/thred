Create an execution plan in strict markdown format.
The source requirement is free-form text and can be rough notes.
You MUST anchor the plan to the current repository structure.
All decisions made during clarification are binding —
the plan must reflect them, not override.

Source mode: {{sourceMode}}
Source label: {{sourceLabel}}

Requirement text:
{{sourceText}}

Repository context (MANDATORY):
{{projectContext}}
{{memorySection}}

# Temporary artifacts rule
- If you need temporary notes, drafts, or intermediate plan files while reasoning, write them ONLY under `.thred/artifacts/` (for example `.thred/artifacts/tmp/`).
- Never create extra plan markdown files under `docs/plans/` during generation.

# How to decompose tasks
- Each task = one logical unit (one function, one endpoint,
  one component) that an AI coding agent can complete
  in a single focused pass
- Each task builds on the previous: no orphaned or
  disconnected code that isn't wired into the whole
- A task should touch one area (module, feature, or layer)
- If a task would require reading more than 5-6 files
  to understand the context, split it further
- Tasks are ordered by dependency so execution can run
  from Task 1 to Task N without guessing
- Each task ends with a verifiable outcome
- Let the requirement scope dictate task count —
  a one-file fix may need 1 task, a new feature may need 10+
- Mention concrete repository paths in checklist items where relevant

# Testing rules
- EVERY task that changes code MUST include test items
  as separate checklist entries — tests are not optional
- Write tests for all new code added in the task
- Update tests for all modified code in the task
- Include both success and error/edge case scenarios
- The last checklist item of every code task must be:
  run project tests — must pass before next task
- Do NOT bundle "implement X and write tests" into one
  checklist item — they must be separate lines

# Self-check before outputting
After drafting the plan, verify:
1. Every requirement from the source text is covered
   by at least one task
2. Every code task has separate test checklist items
3. No circular dependencies exist
4. The tasks, executed in order, produce a working result —
   not just isolated pieces
5. Plan structure matches parser contract exactly:
   - `# Plan: ...`
   - `## Overview`
   - `## Validation Commands`
   - one or more `### Task N: ...` sections with checklist items
   - every task item uses checkbox syntax: `- [ ] ...` or `- [x] ...`
   - plain list bullets under tasks (for example `- item`) are forbidden
If any check fails, revise the plan before outputting.

# Output format (strict — no deviations)
Return markdown only. No code fences wrapping the output.
No commentary outside the structure below.

# Plan: <clear title>

## Overview
<2-3 sentences: what changes, why, key decisions made>

## Validation Commands
{{validationCommands}}

### Task 1: <title — specific name describing what this task accomplishes>
- [ ] <what to implement — describe the change, not the exact file edits>
- [ ] <what to implement>
- [ ] write tests for new/changed functionality (success cases)
- [ ] write tests for error/edge cases
- [ ] run project tests — must pass before next task

### Task N: <title>
- [ ] <checklist item>

# Rules
- Checklist items describe WHAT to change, not HOW —
  the executing agent decides the implementation approach
- Checklist items contain NO code
- Under task sections, plain bullets are forbidden.
  Use only checkbox items: `- [ ] ...` or `- [x] ...`
- Test items must be separate lines, never bundled
  with implementation items
- Task numbering must be sequential from 1 with no gaps
- Every task must have at least one checklist item
- Do not add sections outside this format
- Do not append any usage/telemetry footer (for example:
  `tokens used`, `input tokens`, `output tokens`, numbers-only lines)
