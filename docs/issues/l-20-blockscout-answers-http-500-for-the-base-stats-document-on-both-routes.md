---
id: L-20
type: known-issue
status: open
opened_at: 2026-08-20
category: logic
severity: SEV-3
slug: l-20-blockscout-answers-http-500-for-the-base-stats-document-on-both-routes
---

# L-20 — Blockscout answers HTTP 500 for the `base` stats document, on the facade and on the public instance alike

> Origin: the live gate of task 014-31, 2026-08-20. Four consecutive gate runs, then measured
> directly against the vendor before filing.

**Symptom.** `chain.transactions` on `base` reports `capability unavailable`. It failed on **four of
four** gate runs on 2026-08-20, while every other new failure of those runs appeared once and
cleared.

**Cause — the vendor answers 500, quickly.** `gas.price` and `chain.transactions` both read ONE
document, `/api/v2/stats` (WI-51, `adapters/blockscout/index.ts:236`). Measured 2026-08-20 through
the PRO facade, chain id 8453:

```
attempt 1: http=500 t=9.33s   {"error":"500 Internal Server Error - Details: Internal server error"}
attempt 2: http=200 t=~1.7s   (real document — average_block_time 2000.0, gas_prices, …)
attempt 3: http=500 t=3.32s   {"error":"500 Internal Server Error - Details: Internal server error"}
```

Same request against three other chains in the same sweep, for contrast:

```
chain 1     (ethereum)  1.42s  200
chain 8453  (base)      1.70s  500
chain 42161 (arbitrum)  0.87s  200
chain 137   (polygon)   0.93s  200
```

**Both routes fail together.** The keyless public instance answers the same way:
`GET https://base.blockscout.com/api/v2/stats` → **500** in 4.55 s. So this is the vendor's `base`
stats document, not the facade, not auth, and not our transport — the same one-backend shape L-12
established for the holders route.

**This is NOT L-12.** L-12 is *latency* on `/api/v2/tokens/<addr>/holders`, and it uses
`/api/v2/stats` as its CONTROL — measured at 0.77–1.37 s and consistently fast. Here that control
endpoint is the one failing, on one chain, with a fast 500 rather than a timeout. Different
endpoint, different failure mode, different remedy. Filing it under L-12 would have buried a new
fact inside a record whose own reasoning depends on this endpoint being healthy.

**Blast radius.** `chain.transactions` and `gas.price` on `base` — the two capabilities that read
this document. Intermittent rather than total: roughly one attempt in three answered during the
measurement, which is why `gas.price` can pass a gate run that `chain.transactions` fails, and why
the row looks flaky rather than dead.

**Nothing to fix in our code.** A 500 from the vendor is reported as `capability unavailable`, which
is the honest answer. There is no second route to switch to — the public instance was measured and
fails identically.

**Fix path.**

1. Re-measure on a different day. Every sample here is from 2026-08-20, so persistence is unmeasured
   — the same gap L-12's fix-path item 1 names, and the same reason it is written down rather than
   assumed.
2. If it persists, the owner's options are the ones L-12 already frames: keep acknowledging, or stop
   advertising the two capabilities on `base`. **Do not** retry-loop around the 500 to make the row
   green — one attempt in three answering means a retry budget large enough to hide it would also
   hide a total outage.

**Do-not.** Do not grade the failure as `ok` in the eval case, and do not narrow the coverage matrix
to drop `base`. The vendor serves the chain; it is answering 500 today. Removing the chain would
convert a visible vendor fault into an invisible false claim about coverage — the L-18 trade this
project has already made once.

**UPDATE 2026-08-21 — the acknowledgement was REMOVED, and not because this closed.** Re-measured
the morning of 2026-08-21: `/api/v2/stats` on base answered 500 on four of five attempts, worse than
the one-in-three of the day it was filed. Hours later the same document answered in 0.98 s on every
chain including base, and `base/chain.transactions` passed the live gate. The gate then reported the
acknowledgement as STALE and blocked on it — which is [RF-10](rf-10-the-gate-acknowledgement-is-a-per-row-boolean-so-an-intermittent-vendor-failure-can-never-be-acknowledged.md)
exactly, observed inside one working session rather than reconstructed from the ledger.

The row was cleared from `eval/acknowledged.json` because leaving it blocks every unrelated task,
and that is the only move the file's two-word vocabulary allows. **This record stays `open`**: one
green run does not refute four consecutive failures plus a direct vendor measurement, as this
record's own fix-path item 2 already says. When it fails again it will arrive as a NEW failure with
nothing filed against it, and re-adding the row is the whole cost of the missing third word.

Acknowledged in `eval/acknowledged.json` so it stayed named on every run without blocking unrelated
work — until the removal above.

**Related.** [L-12](l-12-blockscout-facade-does-not-answer-token-holders-on-base-within-30s-ethereum-is-marginal-at-our-5s-ceiling.md)
— same vendor, same `base` chain, different endpoint and different failure mode.
