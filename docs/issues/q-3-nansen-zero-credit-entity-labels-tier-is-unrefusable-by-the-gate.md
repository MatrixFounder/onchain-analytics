---
id: Q-3
type: known-issue
status: open
opened_at: 2026-07-25
category: quality
severity: SEV-3
slug: q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate
---

# Q-3 — the 0-credit `entity.labels` query tier is structurally unrefusable by a credit-denominated gate

**Symptom.** `costOf()` prices a query-only `entity.labels` call as `[GET /search/general,
POST /search/entity-name]`; both are `{free: 0, pro: 0}` in the cost table, so the total is **0**.
`checkAndReserve` then evaluates `used + 0 > ceiling`, which is false for the entire life of the
bucket. The gate that three review rounds hardened **can never refuse this path**, at any usage
level, under any cap — including `NANSEN_DAILY_CREDIT_CAP` set deliberately low.

Compounding it: the tool accepts up to 200 characters of free text (`query`), so every call is a
fresh `args_hash`, a guaranteed cache miss, a new `cache_entries` row, and two real HTTPS round trips
to the vendor.

**Why this matters even though the calls are free.** Three consequences, none of which the credit
ledger can see:

1. **Vendor-side exposure.** Sustained request volume against the operator's own Nansen account is
   still the operator's problem — vendor rate-limiting or abuse enforcement lands on the account that
   the paid capabilities also depend on.
2. **Unbounded cache-row growth**, with attacker-selectable keys and a 3600s TTL. The disk cache has
   no row-count or size ceiling (it sweeps expired rows only).
3. **Price drift is undetectable in advance.** The gate is the only pre-call check; on a 0-priced
   endpoint it does nothing, so if the vendor ever starts charging for these endpoints the first
   signal is `reconcile()` observing the charge **after** it has been paid. The repo already treats
   drift as live — `record-fixture.mjs` emits a `MISMATCH … vendor-drift signal`.

**Why this is a design question, not a bug.** The guard's unit is credits, and these calls cost
zero credits, so it is behaving exactly as specified. What is missing is a **second denominator** —
a call-count or request-rate budget — which is a deliberate addition, not a patch.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25) — security S-4 and performance H-1 independently.

## Related

- [SEC-1](sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md) — the same missing
  second denominator, seen from the paid side. A credits-per-window limiter would not cover this;
  a calls-per-window limiter would cover both.
- `packages/core/src/adapters/nansen/cost-of.ts`, `packages/core/src/cache/budget-store.ts`.
