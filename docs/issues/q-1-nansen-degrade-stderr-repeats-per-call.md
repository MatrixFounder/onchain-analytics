---
id: Q-1
type: known-issue
status: by-design
opened_at: 2026-07-24
category: quality
severity: SEV-4
slug: q-1-nansen-degrade-stderr-repeats-per-call
---

# Q-1 — under a persistent reconcile degrade, the nansen stderr line repeats per call

**Symptom.** When `X-Nansen-Credits-Used` is missing/blank on every response (vendor header rename,
CDN stripping the value), `reconcile()` takes its degrade branch on every paid call: one stderr line
each, plus `markUnreconciled()` → a forced `GET /api/v1/account` resync on the next gate entry.

**Impact.** Log noise and roughly doubled request pressure while the vendor relationship is already
degraded. **No credit cost** (`/account` is 0 credits) and **no budget incorrectness** — the anchor
rebases on each successful resync, which is the conservative direction.

**Why it is by-design rather than fixed.** Adversarial review cycle 1 (F-6) and cycle 2 (R-4)
proposed rate-limiting the forced resync. That was implemented and **reverted on evidence**: a
minimum-interval guard broke three tests that encode UC-6's contract — after a `402` or a transport
failure the *next* gate entry must resync, because that resync is the authoritative drift correction
(the vendor has just told us the local ledger is wrong). Suppressing it during a cooldown trades a
money-correctness property for an availability nicety, which is backwards for this milestone. See
the long-form rationale on `needsResync()` in `packages/core/src/adapters/nansen/budget-gate.ts`.

**If it ever needs fixing:** a circuit breaker around the capability itself (stop calling a provider
that is persistently degraded) is the correct shape — not a blindfold on the ledger. Deduplicating
just the stderr line would need a second flag on `NansenAccountState` alongside `hasWarned()`.
