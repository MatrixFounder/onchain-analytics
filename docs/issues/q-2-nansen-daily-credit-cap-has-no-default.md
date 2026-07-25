---
id: Q-2
type: known-issue
status: fixed
opened_at: 2026-07-24
category: quality
severity: SEV-3
slug: q-2-nansen-daily-credit-cap-has-no-default
resolved_at: 2026-07-25
resolved_by: TASK-005 / Q-2 implementation
---

# Q-2 — `NANSEN_DAILY_CREDIT_CAP` is optional with no default, so a stock install has no self-imposed ceiling

**Symptom.** `NANSEN_DAILY_CREDIT_CAP` is `.optional()` in `EnvSchema` with no default. When unset,
`effectiveCeiling = usageAtObserve + creditsRemainingAtObserve` — i.e. 100% vendor-reported. The
engine will happily spend the entire account balance; the only bound is what Nansen itself allows.

**Why this is worth a decision.** ADR-001 D6 describes a *daily credit ceiling enforced before any
paid call*. In the default configuration no such non-vendor bound exists, so a runaway agent loop is
limited only by the balance — on a Pro plan, that is the whole subscription. Every other part of the
guard (atomic check+reserve, anchor-rebased ceiling, fail-closed pricing, reconciliation) works as
designed; this is about what the ceiling *is* when the operator hasn't chosen one.

**Raised by:** adversarial review cycle 2 (security R-5), explicitly filed as a design decision for
the owner rather than a defect — the current behavior is intentional and documented, and picking a
default is a policy call (what number? per-plan? fail-closed on an unset cap?).

---

> **RESOLVED 2026-07-25 — implemented as proposed below, with the owner's addition that the guard
> must be switchable off from `.env`.** Shipped behaviour: `NANSEN_DAILY_CREDIT_CAP` now has three
> states — **unset** derives `max(30, 25% of balance)` and pins it per day-bucket; a **positive
> integer** is an explicit ceiling; the literal **`off`** disables the self-imposed ceiling entirely,
> leaving only the vendor remainder (the pre-Q-2 behaviour). `0` stays invalid on purpose. The
> effective ceiling is now announced on stderr once per bucket, closing caveat 3. Two findings from
> implementing it are recorded at the end of this file — one of them a real defect the tests caught.

## Recommendation (engineering proposal — implemented 2026-07-25)

```
cap = max(30, floor(creditsRemainingAtObserve × 0.25))
```

Derived **once per day-bucket, at that bucket's first `/account` resync** (which already happens,
costs 0 credits, and already reads `credits_remaining`), then **pinned into
`NansenAccountSnapshot` for the rest of the bucket** — see "Implementation note" below for why
pinning is load-bearing rather than cosmetic. An explicit `NANSEN_DAILY_CREDIT_CAP` continues to
override it, and the existing `Math.min(vendorCeiling, cap)` shape is unchanged, so the
**cap-can-only-narrow invariant is preserved by construction**.

### What it produces on real numbers

| Balance                | Derived cap | Meaning                                              |
| ---------------------- | ----------- | ---------------------------------------------------- |
| 59 (this account, 2026-07-24) | **30**      | 3 × `smart-money.flows`, or 5 × `token.risk`, per day |
| 100 (fresh free plan)  | **30**      | one incident cannot burn more than ~a third          |
| ~10 000 (Pro)          | **2500**    | one bad day costs a quarter of the allocation         |

### Why a fraction rather than an absolute number

Owner decision #1 (2026-07-23) was *design for `free` and `Pro` simultaneously, zero code change on
upgrade*. Any fixed number violates it in one direction or the other: `30` on Pro is paralysis,
`2500` on free is a no-op (the whole balance is 100). A fraction of the observed balance is the only
shape that satisfies that decision, and it needs no new source of truth — `credits_remaining` is
already read at the resync.

### Why the floor of 30

30 = three calls of the most expensive default-path capability (`smart-money.flows` = 10cr). Without
a floor, a nearly-exhausted account derives a cap of ~0 and the engine refuses **its own** calls
before the vendor would — the guard bricking the product it protects. With it, a working session is
always possible.

The floor **cannot** widen spend beyond the real balance, because `effectiveCeilingFor()` still
takes `Math.min(vendorCeiling, cap)`. Verified numerically across the whole low-balance range:

| Balance | cap | effectiveCeiling | Largest call allowed |
| ------- | --- | ---------------- | -------------------- |
| 0       | 30  | **0**            | 0                    |
| 5       | 30  | **5**            | 5                    |
| 12      | 30  | **12**           | 12                   |
| 30      | 30  | 30               | 30                   |
| 100     | 30  | 30               | 30                   |

There are three regimes, and it is worth naming them precisely rather than saying "the cap binds":

| Balance  | What actually binds                     | Why                                                 |
| -------- | --------------------------------------- | --------------------------------------------------- |
| < 30     | the **vendor ceiling** (floor is inert) | `min(balance, 30) = balance`                        |
| 30 – 123 | the **floor** (30)                      | `floor(0.25 × balance) ≤ 30`, so the floor wins     |
| ≥ 124    | the **percentage** (25%)                | `floor(0.25 × balance) ≥ 31`, so the fraction wins  |

The crossover is **124, not 120** — `floor()` truncation keeps the derived value at 30 through
balance 123 (`floor(0.25 × 123) = 30`). Worth stating because the obvious mental arithmetic
(`0.25 × 120 = 30`) gives the wrong boundary, and a test written against 121 would assert the wrong
regime.

There is no balance at which the floor permits spending money that does not exist.

### A useful property that falls out for free

`entity.labels` with `exhaustive: true` costs **100cr** — the single most expensive call in the
system, and more than an entire free-plan balance. Under this formula it is automatically
unreachable until the balance is ≥ 400 (`0.25 × 400 = 100`), with no special-case rule:

| Balance | cap | `exhaustive` (100cr) |
| ------- | --- | -------------------- |
| 100     | 30  | refused              |
| 200     | 50  | refused              |
| 396     | 99  | refused              |
| 400     | 100 | allowed              |

That is the correct behaviour — the dearest call should not be reachable on a nearly-empty account —
and it emerges from the formula rather than from a hand-maintained threshold that could drift.

### Implementation note (found while validating this proposal — do not skip)

The cap must be **derived once per bucket and pinned**, not recomputed at every resync. Recomputing
makes the "daily" ceiling shrink *during* the day, because each resync sees a smaller balance:

| Step (start: balance 200, cap 50) | usage | balance | cap recomputed | headroom left |
| --------------------------------- | ----- | ------- | -------------- | ------------- |
| spend 20                          | 20    | 180     | 45             | 25            |
| spend 20                          | 40    | 160     | 40             | **0**         |
| spend 10                          | 50    | 150     | 37             | 0             |

The operator is told the daily ceiling is 50 but is locked out after 40 — the number stops meaning
what it says. Pinning at the bucket's first resync gives honest semantics (50 means 50) and costs
one extra field on `NansenAccountSnapshot`, which is already bucket-scoped via `dayBucketMs`.

### Caveats — stated plainly

1. **The 25% is a pacing heuristic, not a derivation.** Nansen does not document a credit reset
   cadence anywhere: the committed spec contains **zero** occurrences of `monthly`, `per month`,
   `per day`, `renew` or `quota`; all 310 hits for `reset` are rate-limit windows in seconds, and all
   `daily` hits describe data granularity.

   Precisely: the *design* question is **resolved** — `architectures/open-questions.md` OQ-1 settles
   that the day-bucket is our own pacing instrument and the engine deliberately does **not** depend
   on any vendor cycle. What stays unknown is the *vendor fact* (`docs/TASK.md` OQ-1, same number,
   drifted title). This proposal inherits that unknown rather than reopening the resolved design: if
   the allocation turns out to refill monthly, the fraction should key off *days remaining in the
   period*; under a non-refilling allocation, rationing merely defers spend without protecting
   anything, and "leave as-is" below becomes the stronger option.
2. **A daily cap is a weak instrument against the actual threat.** The per-provider throttle allows
   `refillPerSec: 10`; a composite capability costs 2 HTTP sub-calls, so the sustained ceiling is
   ~5 paid calls/second ≈ **50 credits/second**. A 2500 cap evaporates in under a minute. The cap
   bounds *damage per day*, not a burst. The complementary guard is a **velocity** limit (credits per
   minute), which is separate, small, and not proposed here — recorded so the cap is not mistaken for
   protection it does not provide.
3. **The active ceiling is currently invisible.** Nothing logs the effective cap, so an operator
   cannot tell which bound is in force. Whatever is decided here should come with one stderr line per
   bucket stating the derived/configured value — the same channel as the existing warn-ratio line.

### Alternatives considered and rejected

- **Refuse to start when `NANSEN_API_KEY` is set but the cap is not.** Rejected: it contradicts the
  D10 canon that every key is optional and an empty `.env` is a valid configuration (`.env.example`),
  and it adds a startup failure mode to solve a problem a sane default already solves.
- **A fixed absolute default.** Rejected: cannot serve `free` and `Pro` at once (see above), and it
  would need re-tuning by hand on every plan change — exactly the coupling owner decision #1 removes.
- **Percentage with no floor.** Rejected: self-bricking near zero balance (cap → 0 refuses even the
  cheapest paid call, while the vendor would still have honoured it).
- **Leave as-is, document in the runbook.** Still a legitimate choice — it is the status quo and
  costs nothing. It is the right pick only if the operator is content that a single runaway session
  can drain the whole balance, which on Pro is the whole subscription.

### Related

- `docs/onchain-analytics/ADR-001-tech-stack.md` D6 — the original "daily ceiling before any paid
  call" requirement this issue measures the implementation against.
- `docs/TASK.md` OQ-1 (reset cadence, unresolved) and OQ-5 (the decision to introduce the optional
  cap at all — this issue is its natural follow-up: the knob exists, its default does not).
- `docs/architectures/system-architecture.md` §3.2 "Формула потолка бакета" — `effectiveCeilingFor()`
  and the anchor-rebasing the `min()` sits on top of.
- [Q-1](q-1-nansen-degrade-stderr-repeats-per-call.md) — the other accepted residual from the same
  review round.

---

## Found while implementing (2026-07-25)

**1. A configured cap must not be routed through the snapshot — caught by an existing test.**
The first implementation resolved *all three* states inside `refreshAccount()` and pinned the result.
That silently broke an explicitly configured cap whenever a snapshot already existed (no resync →
no resolution → the pinned `undefined` read as "off"). In production every snapshot comes from
`refreshAccount`, so it was not reachable — but "a money guard that disappears when state is
pre-seeded" is exactly the fragility this issue is about. Fixed by splitting the concerns
(`capInForce()`): only the **derived** value needs pinning, because only it is a function of the
drifting balance; an explicit number is static and applies directly, independent of snapshot state.

**2. The disable switch earned its keep immediately.** `TC-UNIT-07` asserts the cold-start *anchor*
(`usageAtObserve` must reflect already-persisted spend). With the derived default active, its
pre-persisted usage of 40 exceeded the derived cap of 30, so the case began failing for a reason
unrelated to what it tests. Setting `dailyCreditCap: DAILY_CAP_OFF` isolates it — and doubles as
proof that the escape hatch works.

**Still true, and deliberately not addressed here:** caveat 2 above — a daily ceiling does not stop
a burst (~50 credits/second at the current throttle). The complementary velocity guard remains
unimplemented and unclaimed.
