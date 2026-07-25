---
id: SEC-1
type: known-issue
status: open
opened_at: 2026-07-25
category: security
severity: SEV-2
slug: sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard
---

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
