---
id: Q-4
type: known-issue
status: open
opened_at: 2026-07-25
category: quality
severity: SEV-3
slug: q-4-nansen-token-information-subcall-paid-but-never-consumed
---

# Q-4 — `token.risk` pays 1cr per call for `/tgm/token-information`, whose body is never read

**Symptom.** Every `onchain_token_risk` cache miss issues two sequential sub-calls:
`/tgm/indicators` (5cr) and `/tgm/token-information` (1cr). `normalizeTokenRiskScore` builds the
entire `TokenRiskScore` — metadata included — from `indicators.body.token_info`. The
`tokenInformation` response is fetched, parsed, carried through `reconcile()`, and discarded. Its own
docstring says so: *"`raw.tokenInformation` is fetched (R-43, always both) but intentionally unused
here."*

So **1 of every 6 credits spent on this capability (16.7%) buys nothing**, plus one fully serialized
extra round trip on the critical path and one throttle token. On a 100-credit free plan that is 16
wasted credits per 100 spent on `token.risk`.

**Why this is filed, not patched.** R-43 in `docs/TASK.md` specifies *"`/tgm/indicators` +
`/tgm/token-information` (метаданные)"* — "always both" is the requirement as written, and
`TC-E2E-09` asserts the resulting `creditsUsedToday === 6`. So the code matches the spec; the spec
buys a payload it does not use. Changing it is a requirement decision, and it cuts two ways:

- **Drop the sub-call** → `token.risk` costs 5cr instead of 6 (−17%), one less round trip, and the
  cost table, `costOf()`, `TC-E2E-09` and the R-43 row all move together. Loses nothing that is
  currently returned.
- **Consume it** → deliver the metadata R-43 actually promises (whatever `/tgm/token-information`
  carries that `token_info` does not), keeping the 6cr price honest.

Either is defensible. Paying for it and discarding it is the one option that is not.

**Adjacent, same shape but free:** `entity.labels` issues `POST /search/entity-name` (0cr) whose
response `normalize.ts` also never reads — kept for "HTTP-call/cost parity". At zero credits the
waste is one round trip, not money, but the parity argument buys nothing either.

**Also noted:** `NANSEN_COST_TABLE['GET /api/v1/account']` is never looked up — `endpointsFor()` has
no branch returning it. Harmless (the resync is genuinely 0cr), but it is dead config.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25) — performance H-2 and the RTM completeness audit
(R-43 verdict PARTIAL) independently.

## Related

- `docs/TASK.md` R-43 — the requirement whose "метаданные" half is paid for but not delivered.
- `packages/core/src/adapters/nansen/index.ts` (sub-call sequencing),
  `packages/core/src/adapters/nansen/normalize.ts` (`TokenRiskFetchResult` docstring),
  `packages/core/src/adapters/nansen/cost-table.ts`.
