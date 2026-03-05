# FUTURE_AGENTS_PROPOSAL

Candidate list for future expansion of review agents.

## Priority Candidates

1. `reliability`
- Focus: race conditions, retry policy, idempotency, recovery after partial failure.
- Goal: reduce runtime instability and hidden failure modes.

2. `api-contract`
- Focus: backward compatibility, signature/shape changes, caller-callee contract drift.
- Goal: prevent silent regressions when interfaces evolve.

3. `state-migration`
- Focus: state/config format evolution, read/write compatibility, migration safety.
- Goal: avoid version-to-version breakage and unsafe fallbacks.

4. `observability`
- Focus: actionable diagnostics, log-level correctness, signal-to-noise.
- Goal: speed up triage and improve reproducibility.

5. `release-readiness`
- Focus: release gates, artifact integrity, metadata consistency, checklist evidence.
- Goal: catch NO-GO factors before tagging/publish.

6. `security-hardening`
- Focus: input handling, injection vectors, secret exposure, unsafe execution paths.
- Goal: strengthen security coverage separately from general quality review.

## Recommended Implementation Order
1. `reliability`
2. `api-contract`
3. `observability`
4. `state-migration`
5. `release-readiness`
6. `security-hardening`

## Execution Pattern When Resuming This Work
- For each agent, follow: draft -> Claude review (2 iterations) -> final prompt -> tests.
- Keep clear ownership boundaries between agents to minimize overlap.
