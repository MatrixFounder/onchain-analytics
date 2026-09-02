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
`token.pools` was raised twice the same day — 3 → 4, then 4 → 5 — and the second raise is the first
application of the owner's rule of 2026-08-24: the maximum over TWO CONSECUTIVE runs whose link the
gate measured stable (5 of 9, then 1 of 9). The maximum, not the average: a bound answers "how much
breaks in the worst case", and averaging would make it unexceedable on exactly the bad day.
**`pool.info` was NOT raised, and the reason is the same rule read the other way.** It showed 4 of 9
on one stable run and 2, 1, 1 and 0 on the others, so the two consecutive runs do not agree on 4 —
one run's peak is a sample, not a measurement, and the bound of 2 stands until two runs say
otherwise ([WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md)). `L-22/pairs.active` was retired in the
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

**Update 2026-09-02 — the vendor is nearly well, and the acknowledgement was the thing that had
stopped describing reality.** Twelve gate runs on a measured-stable link, spread over 2026-09-01
(six, 13:13–14:07 UTC), 2026-09-02 evening (three, 17:59–18:19) and 2026-09-02 night (two, 20:31 and
20:52), plus five direct probes of the reproduction command:

| capability | failing across all twelve runs |
| :-- | :-- |
| `pairs.active` | 1 — `bsc`, in ONE run (20:31), a 10 152 ms timeout; the very next run served the same row in 868 ms |
| `pool.info` | 0 |
| `token.pools` | 0 |

**Two entries retired, one narrowed 4 → 1.** `L-23/pool.info` and `L-23/token.pools` are removed:
an acknowledgement covering a vendor that fails nothing is exactly the blindfold `reviewBy` exists
to lift, and with them gone a recurrence blocks the gate instead of being absorbed. The bound on
`pairs.active` becomes the maximum over the two consecutive stable runs the owner's rule of
2026-08-24 names — which is 1, not the 4 measured on the day of the outage.

**Why the record stays open.** One chain still fails intermittently, and it fails by TIMEOUT rather
than by refusal — the same "answering with less than it holds" family the outage was made of, at a
much smaller amplitude. A vendor that degrades one row in twelve runs is not a vendor that is fixed.

**The method was the record's own, and it earned its keep.** The retirement was tested by removing
all three entries and RUNNING the gate: nine previous runs had reported zero failures with the
entries in place, and the very first run without them found `bsc/pairs.active`. Had the entries been
retired on those nine runs alone — as "twelve green rows" invited — the narrowing would have been
written on a vendor condition that does not hold. This is what "do not read a later green run as a
fix" means operationally.

**A separate finding from the same two runs, not part of this record.** `L-26/token.price` went to
2 of 10 against its bound of 1, and `solana/chain.tvl.history` failed unfiled in the first of them.
Both are other vendors and belong to their own entries; they are named here only because they were
measured in the same window and a reader comparing run logs would otherwise wonder.

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
