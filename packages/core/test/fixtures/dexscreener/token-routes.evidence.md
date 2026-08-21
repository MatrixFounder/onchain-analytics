# Fixture evidence: the two `token.pools` routes (task 014-32d, R-34)

- probed_at: 2026-08-21
- endpoints:
  - `https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}` — the per-chain form
  - `https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}` — the cross-chain form
- http_status: 200 on every call
- auth: none (keyless)
- purpose: pin `TOKEN_ROUTE_PAGE_SIZE` and the row-order claim in
  `src/adapters/dexscreener/index.ts` to values MEASURED on these two routes
- full run, including per-sample DEX and chain counts:
  `docs/onchain-analytics/raw/dexscreener-token-routes-2026-08-21.json`

## Why this file exists beside `page-size.evidence.md`

`VENDOR_PAGE_SIZE = 30` was measured on `/latest/dex/search`, a route that takes a `q` parameter
neither of these has. Carrying that number across would state a measurement nobody took on these
routes. The two constants are equal today and are separate on purpose: if the vendor moves one cap
and not the other, two constants report it and one hides it.

## Both routes cap at 30 rows

| subject                       | chain       | per-chain rows | cross-chain rows |
| ----------------------------- | ----------- | -------------- | ---------------- |
| WETH `0xC02aaA39…`            | `ethereum`  | **30**         | **30**           |
| USDC `0xA0b86991…`            | `ethereum`  | **30**         | **30**           |
| WBNB `0xbb4CdB9C…`            | `bsc`       | **30**         | **30**           |
| osBGT `0xD2C41BF4…`           | `berachain` | 6              | 6                |
| CONTROL `0x00000000…DeaDBeef` | `ethereum`  | **0**          | **0**            |

## 30 is a CAP, not a fixed-size response

The CONTROL row is what makes the table above readable. It is a well-formed EVM address nothing
deploys, and both routes answer **0 rows** for it rather than padding to 30. So a 30-row response
means "the vendor had at least 30 and stopped", not "the vendor always sends 30" — the same
reasoning `page-size.evidence.md` records for the search route, re-established here rather than
assumed. `osBGT` at 6 rows is the same point from the middle of the range.

## The two routes answer different questions, and the shapes differ

`token-pairs/v1` returns a **bare JSON array**; `/latest/dex/tokens/` returns `{"pairs": [...]}`.
The normalizer handles both rather than assuming one: reading only the object shape would render the
per-chain route's answer as "this token trades nowhere".

The per-chain route is scoped server-side — all 30 WETH rows carried `chainId: "ethereum"` — while
the cross-chain route mixes chains:

| subject | cross-chain composition        |
| ------- | ------------------------------ |
| USDC    | `pulsechain` 29, `ethereum` 1  |
| WETH    | `ethereum` 17, `pulsechain` 13 |

A fork reproduces the addresses of the chain it forked. Presenting the USDC page as "this token's
pools" would attribute 29 `pulsechain` pools to an `ethereum` token, which is why the cross-chain
form answers `chain: null` and every row states its own chain.

## Row order is STABLE and is NOT a size ranking

Two samples of `/latest/dex/tokens/0xA0b86991…`, **300 s apart**:

| question                       | answer  |
| ------------------------------ | ------- |
| same set of pairs?             | **yes** |
| same order?                    | **yes** |
| sorted by liquidity, sample 1? | **no**  |
| sorted by liquidity, sample 2? | **no**  |

The liquidity of the first ten rows, in the order the vendor returned them:

```
89 772 · 9 929 652 · 121 922 · 127 398 · 88 318 · 77 278 · 76 366 · 63 818 · 54 317 · 36 436
```

The second row holds ~110× the first. **So a `limit` cut takes an arbitrary subset, not the largest
pools**, and `truncated.reason` says exactly that whenever it cuts. Rows are deliberately not
re-sorted in the normalizer: that would publish a ranking the vendor does not make, over a
`liquidityUsd` the vendor omits on some rows.

Before this probe the contract made no claim about order at all (`interfaces.md` §5.1.8: _"no probe
of these two routes has established whether order is stable or size-ranked"_). It now makes the one
claim the measurement supports, and the one warning it obliges.

## Committed fixtures

| file                               | route       | rows | what it is for                                 |
| ---------------------------------- | ----------- | ---- | ---------------------------------------------- |
| `token-pairs-ethereum-weth.json`   | per-chain   | 30   | the cap, and the bare-array shape              |
| `token-pairs-crosschain-usdc.json` | cross-chain | 30   | the fork case — 29 `pulsechain`, 1 `ethereum`  |
| `token-pairs-berachain-osbgt.json` | per-chain   | 6    | a short page: under the cap, nothing truncated |

## Reproduction

```sh
pnpm --filter @onchain-intel/core probe:token-routes
# ONCHAIN_PROBE_ORDER_GAP_MS=600000 to widen the ordering interval
```

## Re-probe trigger

`TOKEN_ROUTE_PAGE_SIZE` is used only as "the page came back full", so a cap RAISED by the vendor
keeps the signal correct and a cap LOWERED makes it go quiet. The ordering claim is the fragile one:
it is a statement about vendor behaviour that a caller acts on, so re-run the probe before widening
anything that depends on order, and before adding a "top pools" reading anywhere.
