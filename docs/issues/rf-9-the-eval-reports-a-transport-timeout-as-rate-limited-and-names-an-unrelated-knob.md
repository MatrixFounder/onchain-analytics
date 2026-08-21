---
id: RF-9
type: known-issue
status: fixed
opened_at: 2026-08-11
category: workflow-docs
severity: SEV-3
slug: rf-9-the-eval-reports-a-transport-timeout-as-rate-limited-and-names-an-unrelated-knob
provenance: machine
component: eval-harness
fingerprint: 26208cead6f01645
finding_ref: fnd-20260811-130934-26208cea
---

# RF-9 — The eval reports a transport timeout as rate-limited and names an unrelated knob

> Filed by `run-feedback` from capture `fnd-20260811-130934-26208cea`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

**Symptom.** The live eval reports a transport TIMEOUT as `⏳ rate-limited`, and its remediation line
names a knob that cannot affect it:

```
base   token.holders   ⏳  5013   tool reported error: capability unavailable: token.holders on
                                  base — tried: blockscout (safeFetch: timed out after 5000ms ...)

Not tested — provider rate-limited us (raise ONCHAIN_EVAL_CG_THROTTLE_MS or rerun):
 ⏳ base/token.holders
```

`ONCHAIN_EVAL_CG_THROTTLE_MS` throttles CoinGecko. The failing call is to Blockscout. Raising it
changes nothing about this row, and rerunning does not either — the upstream does not answer within
30 s (measured; [L-12](l-12-blockscout-facade-does-not-answer-token-holders-on-base-within-30s-ethereum-is-marginal-at-our-5s-ceiling.md)).

**Why this is worth a record rather than a shrug.** The verdict does two harmful things at once.
It tells the reader the run was INCONCLUSIVE ("not tested") when it was in fact conclusive — the
provider is unusable — and it hands them an action that will appear to fail for no reason. The whole
value of this gate is that it distinguishes "we broke it" from "they broke it"; a bucket that
absorbs a genuine vendor outage into "try again later" removes exactly that distinction. The
practical cost was measurable in this run: the row was nearly dismissed as throttling noise, and the
real 30-second vendor stall behind it was found only by probing the vendor by hand.

**A third consequence, found while running the gate on it (2026-08-11).** The misclassification does
not merely mislabel the row — it makes the row **unacknowledgeable**. `eval/acknowledged.json` is
read by `scripts/eval-gate.mjs` to decide whether a FAILING row should block a task, and a
`rate-limited` row is not failing, it is "not tested". So the gate reported

```
STALE acknowledgements (3) — remove from eval/acknowledged.json:
 ✗ base/token.holders (L-12): now passes (rate-limited)
 ✗ polygon/token.holders (L-12): now passes (rate-limited)
```

for two chains whose upstream had just been measured not answering in 12 s. "Now passes
(rate-limited)" is three words describing three different things, none of them true. The practical
effect is that a genuine, filed, open vendor outage cannot be named in the one file built for
naming vendor outages — the entry is refused as stale on every run.

**Reproduction.**

```sh
cd packages/mcp-server
ONCHAIN_EVAL_CHAINS=base node eval/run.mjs
# -> base/token.holders is bucketed under "provider rate-limited us", with the CoinGecko
#    throttle named as the remedy, while the recorded problem string says "timed out after 5000ms".

# The classifier that produces the verdict:
grep -rn "rate-limited" eval/run.mjs | head
```

**Workaround.** Read the `problems[]` string rather than the verdict — it carries the real cause
(`safeFetch: timed out after 5000ms`). The JSON artifact (`ONCHAIN_EVAL_JSON=...`) has the same text.

**A residue of this defect survived in a DIFFERENT file, and was closed 2026-08-22 by task 014-43.**
This record was fixed in `eval/run.mjs` — the classifier stopped bucketing a timeout as
`rate-limited`. `scripts/eval-gate.mjs` kept its own half: an acknowledged row whose verdict was
`rate-limited` was reported as **`now passes (rate-limited)`**, the exact string quoted above as the
defect. Nobody noticed because after the classifier fix almost no row reached that branch. The gate
now counts a `rate-limited` row as NOT TESTED — neither failing nor passing — and prints it as such,
which also closes the quieter version of the same error the new bounded acknowledgements would
otherwise have introduced: an entry whose whole set is being throttled reporting `0 of N failing`
and reading as recovered.

**Fix path.** Separate the verdicts by the evidence that distinguishes them, and let the remediation
line follow the verdict rather than being fixed prose:

- HTTP 429, or an error naming the client-side limiter -> `rate-limited`, remedy: the throttle knob
  **for the provider that answered 429**, resolved from the failing adapter rather than hardcoded to
  CoinGecko's.
- `SafeFetchTimeoutError` / `timed out after` -> a distinct `timeout` verdict, remedy: none —
  it is a finding about the vendor, which is what this gate exists to produce.

**Related.** [L-12](l-12-blockscout-facade-does-not-answer-token-holders-on-base-within-30s-ethereum-is-marginal-at-our-5s-ceiling.md) — the vendor
outage this hid. [RF-5](rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested.md)
and [RF-8](rf-8-the-live-eval-never-read-the-repo-root-env-so-a-correctly-configured-secret-reported-as-missing.md)
— same instrument, same family: a gate that reports something other than what happened.

**Do-not.** Do not fix this by dropping the `rate-limited` bucket. It is a real and useful verdict
for a real 429 — the defect is that a timeout falls into it, not that it exists.
