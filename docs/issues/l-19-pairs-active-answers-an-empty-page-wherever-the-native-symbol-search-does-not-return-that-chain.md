---
id: L-19
type: known-issue
status: open
opened_at: 2026-08-20
category: logic
severity: SEV-2
slug: l-19-pairs-active-answers-an-empty-page-wherever-the-native-symbol-search-does-not-return-that-chain
---

# L-19 — `pairs.active` answers an empty page wherever the native-symbol search does not return that chain

> Origin: the live gate of task 014-32a, 2026-08-20. Not a `run-feedback` capture — the gate blocked
> on four rows and the mechanism was measured before filing.

**Symptom.** `onchain_active_pairs` answers with an empty `pairs` array on chains the coverage matrix
declares. Measured 2026-08-20 by `pnpm gate --task 014-32a`: four of the nine probed chains report
`[degraded] pairs is empty` — `arbitrum`, `polygon`, `bsc`, `avalanche`. The eval case's own comment
says such a result "is not a live possibility on any chain with DEX activity", and on those four
chains that comment is right: the emptiness is ours, not the vendor's.

**Cause.** The adapter serves `pairs.active` from the keyless SEARCH endpoint, queried by the chain's
**native symbol**, and then filters the returned rows by `pair.chainId === chain.vendors['dexscreener']`
(`packages/core/src/adapters/dexscreener/index.ts`). That endpoint is a global relevance ranking, not
a per-chain listing: it answers with whatever tokens match the ticker anywhere, dominated by whichever
chain currently has the hottest matches.

Measured 2026-08-20, 30 rows per response:

| query  | rows on the chain that asked | where the rows actually were            |
| :----- | :--------------------------- | :-------------------------------------- |
| `BNB`  | **0** of 30 on `bsc`         | 30 of 30 on `solana`                    |
| `POL`  | **0** of 30 on `polygon`     | 14 `ethereum`, 7 `solana`, 3 `bsc`      |
| `AVAX` | **0** of 30 on `avalanche`   | 16 `solana`, 7 `bsc`, 5 `polygon`       |
| `ETH`  | 2 of 30 on `ethereum`        | 11 `solana`, 9 `bsc`, 5 `starknet`      |

So the filter is doing its job and there is nothing left to filter. The capability works where the
ticker happens to rank on its own chain, and answers an empty page where it does not.

**This is older than the change that revealed it.** The defect did not arrive with task 014-32a. Until
that task the matrix declared `pairs.active` on three chains — `ethereum`, `berachain`, `solana` — and
all three happen to be chains whose native symbol ranks on themselves. Every other chain was REFUSED
before the query ran, so the strategy was never exercised there. L-18's title names this shape from the
other side: *the live gate counts each refusal as a pass*. Removing the false refusals is what made
the real behaviour observable.

**Blast radius.** `pairs.active` on the 46 chains that gained a witnessed vendor id and whose native
symbol does not rank on them. The answer is an empty page rather than an error, so a caller reads it
as "this chain has no new pairs" — a false statement about the chain, delivered with a `200`.

**Do not** narrow coverage again to hide it. A chain the vendor serves, refused with "the vendor does
not serve this chain", is exactly the defect L-18 was filed for; trading a visibly empty answer for an
invisibly false one is not a fix.

**Do not** grade the empty page as `ok` in the eval case. The case's assertion is correct — an empty
`pairs` on a live DEX chain is implausible — and weakening it would delete the only instrument that
found this.

**What a fix looks like, for whoever takes it.** The vendor has per-chain routes that a ticker search
does not need: `/token-pairs/v1/{chainId}/{tokenAddress}` and `/latest/dex/pairs/{chainId}/{pairId}`
both take the chain as a path segment, which is what the probe of task 014-32a used as its
routability oracle. Task 014-32c already owns the `pool.info` route and the predicate relaxation for
this adapter, so the query strategy belongs there rather than in a separate change.
