---
id: L-23
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-2
slug: l-23-dexscreener-stopped-answering-entirely-and-took-three-capabilities-with-it
---

# L-23 — DexScreener stopped answering entirely, and took all three of its capabilities with it

> Origin: the live gate run of 2026-08-24, immediately after L-22's fix landed. Filed after the
> outage was isolated to the vendor, not after the first red row.

**Symptom.** The gate fell from `ok 147 · error 2` to `ok 126 · error 24` in one run. Every
capability this vendor serves is failing:

| capability | rows failing |
| :-- | :-- |
| `pairs.active` | 8 of 9 |
| `pool.info` | every chain with a curated pool |
| `token.pools` | every chain |

**It is the vendor, and that was measured rather than assumed.** Four hosts, same machine, same
minute:

```
000  15.0s  https://api.dexscreener.com/latest/dex/search?q=WETH
200   0.50s https://api.llama.fi/v2/chains
200   0.58s https://api.coingecko.com/api/v3/ping
200   0.95s https://mempool.space/api/blocks/tip/height
```

Our egress is healthy. Only DexScreener does not answer.

**The degradation was gradual, over hours, and the samples are worth keeping** because they show an
endpoint sliding rather than dropping:

| time (2026-08-24) | `q=WETH` / `q=berachain` |
| :-- | :-- |
| morning | 1.3–2.5 s |
| afternoon | 6.8–7.2 s when it answered, most probes no answer in 40 s |
| evening | no answer in 15–20 s, every probe |

**Nothing in our code is at fault, and one thing in it improved during the slide.**
[L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md)
was fixed hours earlier, and its fix is why these rows now report `capability unavailable` — "this
vendor did not answer" — rather than `capability deadline exceeded`, which would have blamed our own
budget for a vendor that has stopped serving. The attribution is right; the rows are red because the
vendor is down.

**Update, same day, 14:22–14:31 UTC — the total outage lifted into intermittent PARTIAL failure, and
the acknowledgement rule flipped with it.** Two consecutive gate runs, one set:

| run | `pairs.active` | `pool.info` | `token.pools` |
| :-- | :-- | :-- | :-- |
| A (14:22) | 2 of 9 | 1 of 9 | 1 of 9 |
| B (14:31) | 4 of 9 | 2 of 9 | 3 of 9 |

**And not the same chains.** Run A named base/`pool.info` and avalanche/`token.pools`; run B named
ethereum + avalanche/`pool.info` and arbitrum + bsc + tron/`token.pools`. Rotation without a growing
total is exactly the shape RF-10 replaced a per-row boolean for: under the old mechanism every run
would have reported some rows as unfiled and others as stale, on one unchanged vendor condition.

The failures read as three different sentences and mean one thing — the vendor is answering with
less than it holds: `pairs is empty` where a live DEX chain cannot have zero new pairs;
`resolved: false` on a pool curated on 2026-08-21 *because it holds real liquidity*; an empty page
for a chain's own wrapped native token (L-10 in its pure form — a confident zero where zero is
impossible). berachain's `truncated.pairs is false` belongs to the same family from the other side:
that case rests on the vendor always returning its full 30-row page, and it stopped doing so.

So as of 2026-08-24 the three capabilities ARE acknowledged, with bounds 4 / 2 / 4 for
`pairs.active` / `pool.info` / `token.pools` — the maxima MEASURED, never the size of the set.
`token.pools` was raised from 3 to 4 later the same day on two further runs, one of them taken on a
link measured healthy; the entry says so, because raising a bound is an act of measurement and a
number lifted from a run whose own egress had stalled would bake weather into the record
([WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md)). `L-22/pairs.active` was retired in the
same edit: that entry described OUR defect (a capability deadline equal to one hop's ceiling), which
is fixed, and the rows failing under it today fail for the vendor's reason instead.

**A total outage cannot be acknowledged, and that was the mechanism working rather than failing.**
`eval/acknowledged.json` refuses a bound at or above the size of the set it covers
([RF-10](rf-10-the-gate-acknowledgement-is-a-per-row-boolean-so-an-intermittent-vendor-failure-can-never-be-acknowledged.md),
task 014-43): a bound that cannot be exceeded accepts the total outage the bound exists to keep
visible. A total vendor outage is therefore un-acknowledgeable BY DESIGN, and while it lasted the gate
stayed blocked. Partial failure is a different fact and takes a bound; the refusal above applies again
the moment the whole vendor goes away.

L-22's own entry went `over the bound of 2` with 8 of 9 failing during the outage, which is the same
mechanism reporting that the filed fact had grown into a different one — and it is why that entry was
retired rather than widened.

**Blast radius.** Three capabilities on up to 49 chains. `onchain_active_pairs`, `onchain_pool_info`
and `onchain_token_pools` answer `capability unavailable` for the duration. No other provider is
affected: `defillama`, `coingecko`, `blockscout` and the RPC adapters are green in the same run.

**Fix path — none of it is code.**

1. **Wait and re-measure.** The reproduction below is one command. A vendor that degraded over a day
   may recover over one.
2. **If it persists, the question is a second adapter for these three capabilities**, which is a
   coverage decision with a budget attached, not a wiring one — the same shape L-6 recorded when
   `token.holders` had a single vendor and that vendor closed keyless access.
3. **Do not widen the acknowledgement to cover it.** See above: the refusal is deliberate.

**Do not** read a later green run as a fix. This record was filed on a measured slide across a day,
not on one bad minute.

**Reproduction.**

```sh
for u in "https://api.dexscreener.com/latest/dex/search?q=WETH" "https://api.llama.fi/v2/chains"; do
  curl -sS -o /dev/null -m 15 -w "%{http_code} %{time_total}s  $u\n" "$u"
done
```

**Related.** [L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md)
— the deadline defect on this vendor's search route, fixed hours before this outage and the reason
these rows are attributed correctly.
[L-6](l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) — the single-vendor
capability whose vendor withdrew, and the precedent for what direction 2 costs.
[L-24](l-24-defillamas-two-per-call-history-routes-answer-erratically.md) — a DIFFERENT vendor
degrading on the same day, filed separately because it was measured separately: same-minute probes
are what keep two coincident outages from being written up as one.
