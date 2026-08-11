# Fixture evidence: dexscreener `/latest/dex/search` page size (L-14)

- probed_at: 2026-08-11
- endpoint: `https://api.dexscreener.com/latest/dex/search?q=<query>`
- http_status: 200 on every call
- purpose: pin `VENDOR_PAGE_SIZE` in `src/adapters/dexscreener/index.ts` to a MEASURED value

## Page size is 30

| `q`     | rows in `pairs[]` |
| ------- | ----------------- |
| `BERA`  | 30                |
| `ETH`   | 30                |
| `SOL`   | 30                |
| `AVAX`  | 30                |
| `MATIC` | 30                |
| `USDC`  | 30                |
| `HOLD`  | 30                |

## 30 is a CAP, not a fixed-size response

| `q`               | rows in `pairs[]` |
| ----------------- | ----------------- |
| `zzzqqxunlikely9` | **0**             |

A query with no matches returns an empty array rather than 30 padded rows, so a 30-row response
means "the vendor had at least 30 and stopped", not "the vendor always sends 30". This distinction
is the whole basis of the check: without it, `pairs.length === 30` would carry no information.

## Cross-chain slot consumption, measured on the same pages

The search index is not chain-scoped server-side, so rows for other chains occupy slots in the same
capped page and the requested chain gets whatever is left.

| `q`                                      | total rows | rows on the intended chain | slots to other chains                                     |
| ---------------------------------------- | ---------- | -------------------------- | --------------------------------------------------------- |
| `BERA` (→ berachain)                     | 30         | 20                         | 10 — solana 5, bsc 2, ethereum 2, robinhood 1             |
| `ETH` (→ ethereum), from `ethereum.json` | 30         | **2**                      | 28 — solana 13, bsc 8, starknet 5, polygon 1, robinhood 1 |
| `SOL` (→ solana), from `solana.json`     | 30         | 15                         | 15 — base 10, polygon 3, arbitrum 2                       |

The `ETH` row is the one worth keeping in view: the recorded fixture that has shipped in this repo
since M1 returns **two** ethereum pairs out of a full page, and before L-14 the adapter reported
`truncated: {pairs: false, reason: ''}` for it.

## Reproduction

```sh
for q in BERA ETH SOL AVAX MATIC USDC HOLD zzzqqxunlikely9; do
  curl -sS "https://api.dexscreener.com/latest/dex/search?q=$q" \
    | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('pairs') or []))"
done
```

## Re-probe trigger

`VENDOR_PAGE_SIZE` is used only as "the page came back full". A cap RAISED by the vendor keeps the
signal correct (a full page still reads as full). A cap LOWERED by the vendor makes the check go
quiet, and that is what the pinned-30 regression test exists to catch.
