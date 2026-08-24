---
id: L-24
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-3
slug: l-24-defillamas-two-per-call-history-routes-answer-erratically
---

# L-24 — DeFiLlama's two per-call history routes answer erratically, and only those two

> Origin: three gate runs of 2026-08-24 while WI-63/WI-64 were being closed. Filed after the cause
> was separated from our own deadline AND from our own egress, not after the first red row.

**Symptom.** `capability deadline exceeded` on `dex.volume.history` and `protocol.tvl.history`,
rotating between chains from run to run while every other defillama capability stays green:

| run | `dex.volume.history` (11 rows) | `protocol.tvl.history` (11 rows) |
| :-- | :-- | :-- |
| A | 4 — ethereum, polygon, bsc, avalanche | 1 — solana |
| C | 0 | 3 — bsc, berachain, tron *(link stalled, see below)* |
| D | 4 — bsc, avalanche, berachain, bitcoin | 2 — bsc, bitcoin |
| E | 0 | 4 — bsc, berachain, tron, bitcoin |
| F | 6 of 11 | 5 of 11 |
| **G** | **9 of 11** | **7 of 11** |
| H *(link measured stable)* | 5 of 11 | **9 of 11** |
| I *(link measured stable)* | **9 of 11** | 3 of 11 |

**Runs H and I are the first two whose link the gate measured for itself** (WI-65 landed between G
and H): three unrelated hosts, 54 probes each, zero failures, median TCP connect 13–18 ms and
16–22 ms. Under the owner's rule of 2026-08-24 those two consecutive stable runs are what a bound
may be set from — and what they say is that **the two routes trade places**: 5/9 one run, 9/3 the
next, on the same set, minutes apart.

**Run H also lost a THIRD route, so this record's title understates its own scope.**
`chain.tvl.history` failed on bsc, avalanche and tron. It belongs here by mechanism: it is fetched
per call too (`/v2/historicalChainTvl/{chain}`, `defillama/index.ts`), which makes three per-call
routes, not two. `protocol.tvl`, `chain.tvl`, `protocol.list` and `protocol.incidents` remain
untouched, and they remain the ones reading shared documents.

**But the attribution SPLIT under measurement, and half of it is not the vendor at all.** Probed
within minutes of run I finishing:

- `protocol.tvl.history` **is** vendor-broken: `aave` 39.9 s, `raydium` and `quickswap` no answer in
  60 s, `aerodrome-slipstream` still streaming at 926 KB when the ceiling cut it. Four of five slugs.
- `dex.volume.history` is **not**: all eleven `/overview/dexs/{chain}` documents answered in
  0.58–8.81 s, every one inside the 15 s deadline — and `onchain_dex_volume` on `bsc`, red in run I,
  returned a complete series through the real adapter, limiter and deadline.

That second line was filed as its own record,
[L-25](l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone.md) — **and the same day a
controlled experiment refuted it, so the split did not survive.** Three arms (sweep alone / sweep
with abandoned downloads in flight / sweep alone again) each took 11 of 11, and a full gate run
minutes later took all eleven `dex.volume.history` rows in 89–1730 ms on a link the gate measured
stable. In that run **both routes of this record read 0 of 11**: the vendor had recovered outright.

The reasoning error is worth keeping because it is easy to repeat: the measurements that argued for
the split were taken at DIFFERENT TIMES — the gate run first, then `curl` and a single tool call
minutes later. That is "failed then, passed later", not "fails in the sweep and passes outside it",
and no simultaneous comparison was ever made. So the rows come back here, where "the vendor's
per-call origin degrades in windows" already explains them.

**Run J (2026-08-24, evening, link stable — 42 probes, median connect 14–17 ms): 0 of 11 and 0 of 11.**
Not a closure — this record's own Do-not says a green run is not one, and today produced 5, 9, 3 and
9 on the same two routes before this. It is the fourth data point on the same day, and what it shows
is the amplitude.

**Run G is the first fully attributable run, and it says this is not weather.** Our own egress was
sampled every 30 s THROUGHOUT it, against three hosts the engine never calls: 57 of 57 HTTP 200,
median 0.38–0.52 s, worst CONNECT 0.017 s. The link was healthy from end to end, and the two routes
still lost nine and seven rows of eleven.

**Direct probes minutes later name the failing part exactly — it is the vendor's ORIGIN, not its
edge and not our budget:**

```
504   0.41s   6 KB    /protocol/aave            ← gateway timeout, server-side, in 0.4s
504   0.45s   6 KB    /protocol/pancakeswap
200   0.49s  61 KB    /protocol/raydium         ← same route, different document, fine
200  19.87s 559 KB    /overview/dexs/ethereum
200   0.58s 268 KB    /overview/dexs/solana     ← larger-per-second than ethereum by 40×
200   0.61s 389 KB    /overview/dexs/base
--- control: the SHARED documents on the same host ---
200   0.45s  14 KB    /v2/chains
200   0.85s 2.26 MB   /protocols                ← 2.26 MB in under a second
```

The control is what settles it. The same host streams 2.26 MB in 0.85 s while returning a 6 KB
`504` page for `/protocol/aave` — so neither our link nor DeFiLlama's edge is the problem. What is
failing is the origin BEHIND the cached documents, which is precisely the half these two capabilities
depend on and the half `protocol.tvl` / `chain.tvl` / `protocol.list` / `protocol.incidents` were
moved off (L-7).

**This is therefore closer to [L-23](l-23-dexscreener-stopped-answering-entirely-and-took-three-capabilities-with-it.md)'s
original shape than to drift**, and the title's "erratically" now understates it: at 9 of 11 the
capability is mostly unserved rather than intermittently slow. The bounds in
`eval/acknowledged.json` are NOT raised to cover it — a bound is a claim about how much breakage is
accepted, and accepting nine rows of eleven is accepting the outage the bound exists to keep visible.


**It is the vendor, and both alternative explanations were measured away.**

*Not our deadline, and not the document size.* Direct probes, 2026-08-24, decompressed sizes as the
transfer reported them:

```
200   9.18s   620 KB   /overview/dexs/bsc
200  32.84s   320 KB   /overview/dexs/avalanche
000  60.01s     0 B    /protocol/pancakeswap
200   1.06s    48 KB   /protocol/babylon-protocol
```

The 320 KB document took three and a half times as long as the 620 KB one, and a 48 KB one answered
in a second. Size does not order these; the vendor's mood does. Our capability deadline is 15 s
(`capability-manifest.ts`) and the same routes answer well inside it when the vendor is well — so
this is NOT the shape of [L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md),
where our own budget was the ceiling. Raising the deadline would buy a 33 s answer sometimes and
nothing at all the rest of the time.

*Not our egress.* Run C's failures coincided with a measured local stall — five unrelated hosts at a
uniform ~1.6 s floor, recovering to 0.39–0.53 s ninety seconds later (WI-65). That run is therefore
NOT used as evidence here: its three failing rows are excluded from the bound, and the bound comes
from run D, taken on a link measured healthy. Run A and run D agree at 4 for `dex.volume.history`.

**Why only these two capabilities.** They are the only defillama routes still fetched PER CALL.
`protocol.tvl`, `chain.tvl`, `protocol.list` and `protocol.incidents` all read shared documents
(`/protocols`, `/v2/chains`, `/hacks`) that are fetched once per TTL — so one slow origin request is
amortised across every chain and never reaches a per-row deadline. L-7 moved `protocol.tvl` onto the
catalog for a size reason; the same move is why it is invisible to this failure.

**Blast radius.** Two capabilities on up to 11 chains, intermittently. `onchain_dex_volume` and
`onchain_protocol_tvl_history` answer `capability deadline exceeded` for the duration of a bad
window. Everything else defillama serves is green in the same runs.

**Fix path.**

1. **Wait and re-measure.** The reproduction below is one command; a green run is not a closure
   (RF-10's own Do-not).
2. **If it persists, the question is a cheaper route, not a longer deadline.**
   `dex.volume.history` already has an `includeSeries` switch, and a summary-only answer is a
   smaller document; `protocol.tvl.history` has no lighter source, which is what the 32 MiB cap on
   it already records.
3. **Do NOT raise `deadlineMs` to cover this.** A deadline is a promise to the caller about how long
   a tool may take, and stretching it to absorb a vendor that sometimes never answers converts a
   loud refusal into a slow one.

**Acknowledged** in `eval/acknowledged.json` as `L-24/dex.volume.history` (bound 4 of 11) and
`L-24/protocol.tvl.history` (bound 4 of 11) — the maxima measured, with each run's conditions named
in the entry rather than averaged away. Run E's link degraded part-way through (the rate case's own
control arm read 4420 ms of RPC latency against ~265 ms on earlier runs), so its 4 is a CEILING that
includes a bad link: at review it must come down if the vendor recovered, never drift up. The first
version of that entry listed ten chains and lost `bitcoin`, which the very next run surfaced as an
unfiled failure — a set error, not a bound raise, and fixed as one.

**Reproduction.**

```sh
for u in /overview/dexs/bsc /overview/dexs/avalanche /protocol/pancakeswap /protocol/babylon-protocol; do
  curl -sS -o /dev/null -m 60 --compressed -w "%{http_code} %{time_total}s %{size_download}B  $u\n" "https://api.llama.fi$u"
done
```

**Related.** [L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md)
— the failure this is NOT: there our deadline was the ceiling and the vendor was serving.
[L-23](l-23-dexscreener-stopped-answering-entirely-and-took-three-capabilities-with-it.md) — the
other vendor degrading the same day, on a different host, measured separately.
[WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md) — the
instrument gap that made run C's evidence unusable and had to be checked by hand.
