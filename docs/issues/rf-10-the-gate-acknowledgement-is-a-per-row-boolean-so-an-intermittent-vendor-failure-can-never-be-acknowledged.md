---
id: RF-10
type: known-issue
status: fixed
opened_at: 2026-08-20
category: tooling
severity: SEV-2
slug: rf-10-the-gate-acknowledgement-is-a-per-row-boolean-so-an-intermittent-vendor-failure-can-never-be-acknowledged
resolved_at: 2026-08-22
resolved_by: TASK 014-43
---

# RF-10 — the gate's acknowledgement is a per-row boolean, so an INTERMITTENT vendor failure can never be acknowledged

> **FIXED 2026-08-22 by task 014-43.** An acknowledgement now names a SET of rows and a BOUND on how
> many of them may fail at once, and it carries a `reviewBy` date. The bound absorbs the rotation
> while still blocking growth; the date replaces "the row passes" as the trigger to look again.
>
> **What each half answers.** The bound answers the FAILING run: any `maxFailing` of the set may be
> red and the gate passes, so it no longer matters WHICH chain is cold. `maxFailing` is set to the
> number measured failing when the entry was written — never `rows.length` and never
> `rows.length - 1` — so the first row beyond that is a new fact and blocks. A bound at or above the
> set size is REFUSED by the gate: it could never be exceeded, which is the "may fail anywhere"
> widening this record's own Do-not forbids. The date answers the PASSING run: an entry survives its
> rows going green, which is what lets a filed defect stay filed through a vendor's recovery.
>
> **The date, and not run history, and this record's sibling explains why.** "Green on the last K
> runs" looks like the stronger signal and is biased in exactly the direction of this defect: L-12
> records that a green `token.holders` row means "the cache was warm", so K consecutive green runs in
> one afternoon are not K independent samples. A calendar is weaker and never lies about itself, and
> it keeps the gate a function of ONE run plus ONE file rather than of how many times somebody ran it.
> Capped at 90 days, enforced — memory M6 applied to this file's own new vocabulary, because a
> `reviewBy` far enough out is a permanent exemption in the costume of a review.
>
> **The M6 half of the fix is in the report.** A bound is a wider legal answer than a boolean, so the
> count it is measured against is printed on every run: `1 of 5 failing (bound 1), review by
> 2026-09-20 — base/token.holders`. An entry sliding from one failing row toward its bound never
> blocks, and must never be invisible.
>
> **Three things landed with it, each a hole this defect exposed rather than caused.**
>
> 1. `issue` is now CHECKED against `docs/KNOWN_ISSUES.md`. The file's comment had always required a
>    filed record; nothing verified it, so a typo silenced a row exactly as well as a real record.
> 2. The ledger line records the VERDICT and the problem string of each failing row, not just its
>    key. Four DefiLlama rows blocked the gate on 2026-08-21 and what they actually said was
>    unrecoverable an hour later, because the artifact lives in a temp dir.
> 3. RF-9's residue is gone. A `rate-limited` row is neither failing nor passing; it is counted and
>    printed as NOT TESTED. The old code rendered that case as `now passes (rate-limited)`, and
>    folding it into "not failing" would have been the quieter version of the same error — an entry
>    whose whole set is being throttled reporting `0 of N failing` and reading as recovered.
>
> **The gate finally has tests** (`packages/mcp-server/test/eval-gate.test.ts`, 14 cases driving the
> real script as a subprocess). It had none, which is why both defects in this instrument were found
> in production by a human reading a report that surprised them.
>
> **Observed working on the defect that produced it.** `base/chain.transactions` is acknowledged
> today WHILE PASSING — the state the old mechanism could not represent, and the reason L-20 had to
> be un-acknowledged on 2026-08-21 in the middle of unrelated work.

> Origin: seven live-gate runs on 2026-08-20 across tasks 014-31 and 014-32b. Filed after the
> mechanism was measured, not after the first surprise.

**Symptom.** `pnpm gate` blocks on a vendor failure that nobody can clear, whatever the task under
test. Both branches of its own instrument reject an intermittent row:

- the run where it FAILS reports it under **NEW failures** — "nothing filed, so the gate blocks";
- the run where it PASSES reports the acknowledgement under **STALE acknowledgements** — "remove
  from eval/acknowledged.json", and the gate blocks on that.

Only a row that fails on EVERY run can be acknowledged. Every vendor failure this project has
actually met is intermittent.

**Measured 2026-08-20, seven runs.** Two independently filed defects, both intermittent, both
un-acknowledgeable:

| row | behaviour across the runs |
| :-- | :-- |
| `token.holders` (L-12) | the failing CHAIN rotates: gnosis, then ethereum ×2, then gnosis again, while `ethereum` and `arbitrum` each pass on a later run and are flagged stale |
| `base/chain.transactions` (L-20) | failed 4 of 4 consecutive runs, was filed and acknowledged, then passed on the next run and was flagged stale |

Direct vendor measurement on the same day explains both and refutes "our code is flaky":
`token.holders` cold-entry costs 6.999 s on ethereum against 1.57 s warm, straddling our 5 s hop
ceiling, so whichever chain a run happens to reach cold is the one that fails; `/api/v2/stats` on
`base` answered HTTP 500 on two attempts of three.

**Cause.** `eval/acknowledged.json` is keyed `'<chain>/<capability>'` and its value asserts a
CONSTANT: this row is failing. `scripts/eval-gate.mjs` compares that assertion against one run.
Neither the key nor the value can express "this row fails part of the time", which is the only shape
a vendor latency or a flaky 500 ever has.

**The stale check is not the defect, and must not be removed.** Its own comment states what it is
for, and the reasoning is right: without it the list "would only ever grow — a blindfold assembled
one honest decision at a time". An acknowledgement that never expires is worse than none. The defect
is that the vocabulary has exactly two words for a three-valued world.

**Blast radius.** Every task from 014-31 onward. The project's own rule is that a blocked gate means
the task is not done, so an unfixable block converts that rule into "no task can be completed" — and
the predictable response to a gate nobody can satisfy is to stop reading it, which is the failure
mode `documentation-standards` §4 already records for gates that fail on correct input.

**What a fix looks like, and what it must not be.**

An acknowledgement that carries a BOUND rather than a boolean — for example "at most 3 of the 5
chains serving this capability may fail" — keeps the row named on every run, still blocks a total
outage of the capability, and stops flagging itself stale on the runs that pass. The bound is the
part that matters: memory M6's rule applies to this file too, and a new legal answer with no ceiling
would mask exactly the failure the gate exists to catch.

**Do not** widen it to "this capability may fail anywhere". That accepts the total outage the bound
is there to keep visible.

**Do not** fix it by removing the stale check, or by acknowledging every chain of a rotating
capability — the second is the same thing with more steps, since each passing chain then flags
itself stale.

**Do not** treat a single passing run as evidence a filed defect closed. L-20 was filed on four
consecutive failures and a direct vendor measurement; one green run does not refute either.

**Related.** [L-12](l-12-blockscout-facade-does-not-answer-token-holders-on-base-within-30s-ethereum-is-marginal-at-our-5s-ceiling.md)
and [L-20](l-20-blockscout-answers-http-500-for-the-base-stats-document-on-both-routes.md) are the
two open defects this shape makes unacknowledgeable.
[RF-9](rf-9-the-eval-reports-a-transport-timeout-as-rate-limited-and-names-an-unrelated-knob.md) —
the previous defect in the same instrument, and the one that first made a vendor failure
acknowledgeable at all.
