---
id: Q-2
type: known-issue
status: open
opened_at: 2026-07-24
category: quality
severity: SEV-3
slug: q-2-nansen-daily-credit-cap-has-no-default
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

**Options if it is taken up:** ship a conservative default (e.g. a fraction of the observed balance
at first resync); or require the cap to be set explicitly whenever `NANSEN_API_KEY` is present and
refuse to start otherwise; or leave as-is and document it in the operator runbook.
