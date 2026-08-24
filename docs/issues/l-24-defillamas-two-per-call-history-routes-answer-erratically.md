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
