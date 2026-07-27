---
id: Q-3
type: known-issue
status: fixed
opened_at: 2026-07-25
category: quality
severity: SEV-3
slug: q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate
resolved_at: 2026-07-27
resolved_by: a calls-per-window limit — the second denominator the issue itself asked for
---

> **RESOLVED 2026-07-27.** The issue's own diagnosis was right and is what got built: the guard's
> unit is credits, these calls cost zero credits, so no tightening of the credit ceiling could ever
> reach them. A second denominator — CALLS per window — now sits in the same check-and-reserve
> transaction, on the same `usage_window` row SEC-1 introduced. Details at the end of this file.

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


## Resolution (2026-07-27)

**The shape the issue asked for, built as asked.** `usage_window` gained a `calls_made` column: same
row, same 60-second window, same transaction, one extra integer. Not a second table — the provider
and window are identical, so a second table would mean a second read and a second chance for the two
to disagree.

`VelocityLimit` gained `maxCalls`. `BudgetStore` still only compares plain numbers: it does not know
what a call is, that the window is a minute, or that any of this concerns a vendor. The policy lives
in `budget-gate.ts`, as `ceiling` already did.

**Why the default is FIXED (60/min) while the credit limits are derived.** The asymmetry is
deliberate and is the one judgement call here. Credit limits are derived because a `free` balance
and a `Pro` balance differ by orders of magnitude and owner decision #1 requires both to work
unchanged. A call is a call on either plan: neither the vendor's rate limits nor cache-row pressure
scales with the balance, so there is nothing to derive FROM. 60/minute is one sustained call per
second — comfortably above what an interactive session produces and ~5× below what the throttle
alone permits.

**A call is not refundable.** `recordDelta` adjusts credits and never the call count. The vendor
round trip already happened; letting a reconciliation "refund" it would let a run of
cheap-then-refunded calls walk straight past the limit that exists to bound that traffic.

**Which of the three stated consequences this closes.** Being explicit, because two are closed and
one is not:

1. *Vendor-side exposure* — **closed.** Sustained request volume against the operator's account is
   now bounded by a number the operator sets.
2. *Unbounded cache-row growth with attacker-selectable keys* — **closed, as a consequence rather
   than by a separate mechanism.** At 60 calls/min against `entity.labels`' 3600s TTL, rows for that
   capability reach a steady state of ~3600 instead of growing without limit. No row-count ceiling
   was added to the cache; if one is ever wanted it is a different change.
3. *Price drift undetectable in advance* — **NOT closed, and cannot be by this.** A pre-call gate
   cannot know a price the vendor has not charged yet. Drift is still detected after the fact, by
   `reconcile()` observing a charge against a 0-credit reservation, and by `record-fixture.mjs`'s
   `MISMATCH … vendor-drift signal`. What changed is only that the blast radius of the interval
   between drift and detection is now bounded by the call limit.

**Refusal.** Its own message, its own prefix, and it states outright that the bound counts CALLS and
that raising a credit ceiling will not move it — because an operator who reads a generic "budget"
refusal will reach for the credit knob, and on this path that knob does nothing.

**Config:** `NANSEN_MAX_CALLS_PER_MIN` — a positive integer, or `off`. `0` is rejected for the same
reason as on the two credit limits: on a money guard `0` should mean "spend nothing".

## Related

- [SEC-1](sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md) — the same missing
  second denominator seen from the paid side, and the source of the `usage_window` row this reuses.
  Together they are the "calls-per-window limiter would cover both" this issue predicted.
