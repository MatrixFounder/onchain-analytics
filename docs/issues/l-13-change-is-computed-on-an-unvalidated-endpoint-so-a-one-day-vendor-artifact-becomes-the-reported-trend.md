---
id: L-13
type: known-issue
status: fixed
opened_at: 2026-08-11
category: logic
severity: SEV-2
slug: l-13-change-is-computed-on-an-unvalidated-endpoint-so-a-one-day-vendor-artifact-becomes-the-reported-trend
resolved_at: 2026-08-12
resolved_by: 'design 1 of the two that survived measurement — `change.endpointContext`, context published, no verdict asserted'
---

# L-13 — `change` is computed on an unvalidated endpoint, so a one-day vendor artifact becomes the reported trend

> Origin: live analysis of `berachain` over the MCP server, 2026-08-11. Not a `run-feedback`
> capture — filed by hand from the session transcript.

> ## Closed 2026-08-12 — the engine now publishes the comparison and claims nothing
>
> `change` carries `endpointContext.prevPoint` and `endpointContext.recentLevel`: the same window
> measured to the point before the endpoint, and to the median of the trailing points with the
> endpoint excluded. Both are measured from the SAME `fromUsd` as the headline, which is what makes
> them comparable to `pct` rather than a second differently-based number. On the window that
> produced this record the three read −16.43% / −3.04% / −4.31%, and a caller can see at a glance
> that the headline rests on one point.
>
> **No threshold shipped, deliberately.** The detector this record originally proposed was measured
> and refused (table above): the artifact is smaller than the ordinary daily noise of the chain it
> appeared on, and at the last point of a window there is no next day to reveal a snap-back. A
> verdict would have been an assertion the data cannot support — the "new legal answer" failure
> L-10 already cost this project once.
>
> ### Proven live, not by the suite
>
> The live gate went from **96 ok to 119 ok**, all 23 `endpointContext` errors gone, verdict `pass`
> with zero new failures. That number matters twice: the same gate is what CAUGHT the fix breaking
> every chain, because a required field was added to a shared schema while the built `dist` the
> server resolves core from still lacked it, and 1380 unit tests stayed green throughout. Recorded
> above as an instance of the WI-44 seam.
>
> ### Adversarial review before closing
>
> Four independent lenses (arithmetic, dexscreener, contract, tests) raised **14 claims; 12 were
> refuted** by verifiers that ran code rather than reasoned. The two that survived were both
> coverage gaps in the private `median()` helper — its even-length branch and its numeric sort
> comparator were each reachable in production and killed by no test. **The shipped arithmetic was
> correct in both cases**; what was missing was the ability to notice if it stopped being. Closed
> with two tests, each verified by applying its mutation and confirming that exactly that test dies
> (`(a+b)/2 → sorted[mid]`, and `.sort((a,b)=>a-b) → .sort()`).
>
> ### Coverage
>
> `eval/cases/shared/endpoint-context.mjs`, wired into both history capabilities. It asserts the
> load-bearing property rather than the field's presence: that both alternatives are based on the
> headline's own `fromUsd`. Re-base either and the three numbers stop being comparable, the field
> becomes decoration, and nothing else in the repository would notice. It lives in the eval rather
> than the suite because only a live call crosses the source/`dist` seam that broke this fix.

**Symptom.** `onchain_chain_tvl_history` returns a ready-made `change` computed as
`last(series) − first(series)`, with no check that either endpoint is representative of the series.
When the vendor's last point is an outlier, the outlier becomes the reported trend.

Measured on `berachain`, `days: 30`:

| ts | date | tvlUsd |
|---|---|---|
| 1786147200000 | 2026-08-08 | 48 786 324 |
| 1786233600000 | 2026-08-09 | **42 850 084** |
| 1786320000000 | 2026-08-10 | 49 793 489 |
| 1786406400000 | 2026-08-11 | **42 913 792** |

`change.pct` was reported as **−16.43%** (51 352 059 → 42 913 792). Computed on the last
non-outlier point it is **−3.04%** (51 352 059 → 49 793 489). The reported figure is 5.4× the
actual 30-day move and carries the opposite reading: a chain in sharp decline versus a chain flat
within noise.

The dip is attributable and is not an outflow. Two lending protocols drop out of the aggregate on
the same snapshots and return on the next one:

| day | chain Δ | BEND Δ | Dolomite Δ | pair / chain |
|---|---|---|---|---|
| 08-10 → 08-11 | −6 879 697 | −3 154 202 | −3 399 803 | **95.3%** |
| 08-08 → 08-09 | −5 936 240 | −2 825 505 | −2 935 964 | **97.1%** |

Three routes carry the artifact outward, none of them marked:

1. `onchain_chain_tvl_history.change` — as above.
2. `onchain_list_protocols` reports `BEND change.d1 = −33.70%` and `change.d30 = −37.52%`. BEND's
   own series alternates 9 027 376 / 6 201 871 / 9 268 256 / 6 114 054 across those four days; its
   stable level is ≈9.0M. These fields are the vendor's own arithmetic and we pass them through
   unqualified.
3. `onchain_chain_tvl` returned `42 913 791.71` — the dipped value — as the chain's current TVL,
   with no series context available to the caller at all.

**Why the existing gates do not catch it.** This is the L-6 / L-10 class: no commit of ours
triggers it, and the suite runs on fixtures by design (R-21), so it verifies our arithmetic against
a snapshot in which the endpoint happened to be clean. The live gate runs the routes and reads the
shapes, not the plausibility of the numbers. Every one of these three responses is schema-valid.

**Reproduction.**

```sh
# 1. The reported change and the series it is computed from.
onchain_chain_tvl_history({chain: "berachain", days: 30})
#    -> change.pct = -16.43, series alternates on the last four points

# 2. The two contributors, same window.
onchain_protocol_tvl_history({chain: "berachain", protocolSlug: "bend",     days: 30})
onchain_protocol_tvl_history({chain: "berachain", protocolSlug: "dolomite", days: 14})
#    -> both alternate on exactly the days the chain aggregate does

# 3. The pass-through on the ranking route.
onchain_list_protocols({chain: "berachain", limit: 15, sortedBy: "tvl"})
#    -> BEND change.d1 = -33.70 against a stable ≈9.0M level
```

**Workaround.** Do not read `change` without reading `series`. On a single-point route
(`onchain_chain_tvl`) there is no workaround inside the engine — the caller must fetch the history
separately and compare.

**Fix path.** Item 1 as first written — "flag an endpoint that deviates from a robust statistic of
the recent window" — was **measured and refused, 2026-08-11, before any code was written.**

Deviation of each point from the median of its preceding 7, over the last 393 days:

| chain | median | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| Berachain | 2.90% | **17.47%** | 23.75% | 29.38% | 34.08% |
| Ethereum | 1.99% | 7.06% | 8.76% | 13.82% | 17.69% |
| Arbitrum | 2.17% | 7.52% | 10.00% | 13.61% | 17.20% |
| Base | 2.09% | 6.64% | 8.24% | 11.65% | 14.95% |
| Solana | 2.39% | 7.21% | 9.92% | 14.96% | 18.20% |

The artifact this record was filed for deviates by ≈12–14% — **below Berachain's own p90**. A
threshold that catches it fires on more than one day in ten of this chain's normal history, and on
Ethereum it would flag 2026-04-20…22 (16.3/16.9/17.7%), which look like real market moves. A
per-chain threshold does not rescue it either: the artifact is smaller than the chain's ordinary
noise, so no magnitude cut separates the two populations. **Magnitude is the wrong discriminator.**

What actually separates them in the observed data is the **snap-back**: the artifact returns to the
prior level on the next snapshot (48.79 → 42.85 → 49.79 → 42.91), while a real move persists. That
is detectable — but only for INTERIOR points. The last point of the window, which is precisely the
one `change` is computed from, has no next day yet, so at the endpoint the two are indistinguishable
by any statistic available at call time. Any fix claiming to identify an endpoint artifact would be
asserting something it cannot know.

Two designs survived the measurement. **Owner chose option 1, 2026-08-11** ("если вариант 1 не
ошибается, то это хорошо; главное не сломай остальные сети"), and it is implemented:

1. **Report the shape, assert nothing — SHIPPED.** `change` gained `endpointContext`, carrying the
   same window measured to two other endpoints on the **same base as `pct`**, so all three are
   directly comparable: `prevPoint` (as if the window ended one point earlier) and `recentLevel`
   (the median of the trailing points, **endpoint excluded** — a level the endpoint helped compute
   could not disagree with it). On the window from this record: `pct` −16.43%, `prevPoint` −3.04%,
   `recentLevel` −4.31%. No threshold exists in the code, so there is nothing to tune and no case
   it can misclassify.
2. **Detect the snap-back on interior points** — still OPEN. A window-level note ("N point(s)
   deviate from BOTH neighbours and revert") would catch the berachain case for its two interior
   dips. It needs a threshold, but a loose one is safe there because the revert requirement carries
   the discrimination, not the magnitude. Not built: option 1 was the part that had to be right.

Additivity was the owner's stated constraint and is enforced by test: the six original fields are
asserted unchanged, and the shape degrades to `null` rather than to a fabricated zero on every
short series (2 points → `prevPoint` null, because "the window ending at its own start" is not an
alternative reading; fewer than 3 trailing points → `recentLevel` null; zero base → every `pct`
null, never `Infinity`). Both duplicated declarations of this shape — the two core result types and
the two tool schemas — were collapsed to one (`WindowChange`, `WindowChangeSchema`) in the same
change, because the extension had to be made twice in each pair to stay in sync.

Unchanged from the original filing: do **not** silently substitute a smoothed value for the reported
one. A smoothed `change` is a new legal answer, and a new legal answer widens what the gate accepts
— the response stops being wrong and starts being unfalsifiable, the failure mode L-10 already cost
us once.

Also unchanged: `onchain_list_protocols` `d1/d7/d30` are vendor-computed. We cannot fix that
arithmetic; the open question is whether to recompute them from our own history route (consistent,
more calls) or to mark them as vendor-supplied and unvalidated (cheap, leaves the number in place).

**Reproduction of the measurement.**

```sh
# per-chain deviation distribution against a 7-point trailing median
curl -sS https://api.llama.fi/v2/historicalChainTvl/Berachain
curl -sS https://api.llama.fi/v2/historicalChainTvl/Ethereum
```

**Acceptance.** `change` never ships without `endpointContext` when the series can supply it, the
six original fields are unchanged, and every short/degenerate series yields `null` rather than a
fabricated number. Covered by `test/daily-series-change.test.ts`, built from the 2026-08-08…11
`berachain` series.

**One thing the fix cost, worth keeping.** Adding a REQUIRED field to a shared output schema broke
**every chain** on the live gate — 23 rows of
`change.endpointContext: expected object, received undefined` on chain.tvl.history and
protocol.tvl.history — while all 1380 unit tests stayed green. The suite imports `@onchain-intel/core`
from SOURCE; the gate spawns the real server, which resolves core from its BUILT `dist/`. Until
`pnpm build` ran, the tool schema demanded a field the adapter in the build did not produce. This is
the seam [WI-44](../backlog/wi-44-typecheck-reads-stale-core-dist-so-cross-package-type-breakage-is-invisible.md)
already records for `typecheck`, and it applies to the live gate identically: a cross-package
contract change is not verified by `pnpm test`, only by building first. The gate earned its keep on
exactly the failure class it exists for.

**Related.** [L-10](l-10-two-defillama-chain-vocabularies-43-of-458-chains-answer-a-confident-not-deployed.md)
— same class: a schema-valid response that asserts something the engine did not verify.
[L-14](l-14-truncated-reports-only-losses-inside-our-process-not-the-vendor-page-cap.md) — found in
the same session, same shape of unverified assertion.
[WI-57](../backlog/wi-57-chain-tvl-delta-attribution-by-protocol.md) — the attribution table above
was assembled by hand across four calls; that work-item makes it one.
