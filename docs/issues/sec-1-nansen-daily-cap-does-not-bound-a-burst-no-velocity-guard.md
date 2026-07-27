---
id: SEC-1
type: known-issue
status: fixed
opened_at: 2026-07-25
category: security
severity: SEV-2
slug: sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard
resolved_at: 2026-07-27
resolved_by: credits-per-window limiter checked and reserved inside the daily reservation transaction
---

> **RESOLVED 2026-07-27.** A second, rate-denominated limit now sits in the same check-and-reserve
> transaction as the daily one. All three constraints this issue set out are met: it shares the
> transaction (so two processes cannot each pass their own window check), its state lives in the
> `usage_window` table next to the `usage` ledger in `DATA_DIR` (so a process restart does not
> reset it), and the refusal names the velocity limit specifically. Details at the end of this file.

# SEC-1 — the daily credit cap bounds damage per day, not per minute: there is no velocity guard

**Symptom.** The budget guard is denominated in credits per UTC day. Nothing bounds the *rate*. The
per-provider throttle allows `capacity: 15, refillPerSec: 10`; a composite capability costs 2 HTTP
sub-calls, so the sustained ceiling is roughly 5 paid calls/second ≈ **50 credits/second**. A cap of
2500 (what a ~10 000-credit Pro balance derives under [Q-2](q-2-nansen-daily-credit-cap-has-no-default.md))
is therefore consumed in **under a minute** by a runaway agent loop. The cap is a damage ceiling, not
a brake.

**Why this is filed rather than fixed.** It has been stated honestly in three places since Q-2
shipped (the Q-2 write-up's caveat 2, the `budget-gate.ts` comments, and the commit message) but had
no ledger entry of its own, so it kept being re-derived by each review round instead of being
tracked. It is a real gap in a money guard and deserves an id.

**What it is not.** This is not an over-spend defect: the daily ceiling still holds, the reservation
is still atomic, and the vendor remainder still binds. The failure mode is that a day's entire
authorized budget can be spent before any human notices — which for an operator is
indistinguishable from a leak, and removes any chance to intervene.

## Shape of a fix (not designed)

A credits-per-window limiter in front of `checkAndReserve` — the same check-and-reserve pattern, a
different denominator. Notes for whoever picks it up:

- It must live **in the same transaction** as the daily reservation, or two processes racing will
  each pass their own window check.
- The window state belongs next to the `usage` ledger in `DATA_DIR`, not in memory: an in-memory
  limiter is defeated by the same process restart that [Q-2's L-2 defect](q-2-nansen-daily-credit-cap-has-no-default.md)
  was defeated by.
- The refusal must name the velocity limit specifically, or an operator cannot tell it from the
  daily cap.

## Related

- [Q-2](q-2-nansen-daily-credit-cap-has-no-default.md) — the daily cap this complements; its caveat 2
  is the original statement of this gap.
- [L-1](l-1-nansen-no-negative-caching-paid-call-discarded-on-empty-result.md) — the repeat-paying
  retry loop is one realistic way to reach this velocity.
- `packages/core/src/net/rate-limit.ts` — the existing token bucket, which limits *requests* per
  provider and is not credit-aware.


## Resolution (2026-07-27)

**Shape.** `usage_window(provider, window_start, credits_used, updated_at)` — the same additive
counter as `usage`, bucketed by a 60-second window instead of a UTC day. A separate table rather
than a `bucket_width` column, because the day counter must keep summing a whole day and overloading
`usage.day` with two widths would make every existing SELECT ambiguous and force a migration. Added
as a plain `CREATE TABLE IF NOT EXISTS` against the same `providers` registry: nothing migrates.

**The three constraints, and where each is met.**

1. *Same transaction as the daily reservation.* `BudgetStore.checkAndReserve` gained an optional
   `velocity: {windowStartMs, ceiling}`. Both checks and both writes happen inside the one
   `db.transaction(...).immediate()` that already existed — either both limits fit and both
   counters move, or nothing is touched. A test drives two independent `SqliteBudgetStore`
   connections against one file and asserts the second reads the first's committed reservation.
2. *State next to the ledger, not in memory.* It is a table in the same `cache.sqlite3`. Rows older
   than an hour are pruned inside the reservation transaction — only the current window is ever
   read, so the rest is retention for inspection, and a row per minute per provider forever is the
   kind of slow leak in `DATA_DIR` nobody notices.
3. *The refusal names the velocity limit.* `NansenBudgetExceededError` distinguishes it explicitly,
   states that the daily budget is **not** exhausted, and names `NANSEN_VELOCITY_CREDITS_PER_MIN`
   (and its `off` sentinel). The two refusals call for opposite operator responses — wait out the
   window versus raise a ceiling — so an operator who cannot tell them apart fixes the wrong one.

**The number.** `deriveVelocityCap(effectiveCeiling) = max(100, floor(ceiling / 20))`. Derived
rather than absolute for the same reason as the daily cap (owner decision #1: `free` and `Pro` both
work with zero code change). The divisor 20 means a full day's budget takes at least ~20 minutes of
sustained spending to exhaust — the difference between an operator seeing it happen and seeing it
have happened. The floor of 100 is the price of the dearest single call (`entity.labels` at its
`exhaustive` tier): a limit below one call's cost would make that capability structurally
impossible rather than rate-limited, which is a worse failure than the one being prevented. Where
the floor exceeds what the daily cap allows, the daily cap binds first — the two guards compose and
the tighter one wins.

**Stated limitation: the window is TUMBLING, not sliding.** It admits up to 2× the ceiling across a
boundary (full allowance at :59, full allowance again at :01). A sliding window needs per-call
history rather than one counter, and a 2× worst case does not undermine the goal of buying a human
time to notice. If that ever stops being true, the shape to reach for is a second, wider window —
not a rewrite of this one.

**Refunds return to the window that spent.** `recordDelta` takes the reservation's own
`windowStartMs`, threaded through `ensureBudget → reconcile` exactly as `bucket` already was. A
call outliving its window would otherwise refund into a window that never spent — the one way a
rate brake can hand a runaway loop extra headroom.

**Related:** [Q-3](q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate.md) — a
0-credit tier is unrefusable by ANY credit-denominated limiter, this one included. **Closed
2026-07-27** by the call-denominated limit, which reuses the very `usage_window` row this issue
introduced: `calls_made` alongside `credits_used`.
