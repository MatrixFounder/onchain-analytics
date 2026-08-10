# Fixture evidence: defillama/protocols-catalog

- recorded_at: 2026-08-11T01:05:00Z
- endpoint: https://api.llama.fi/protocols
- http_status: 200
- capability: protocol.tvl
- envelope_fields: none — the fixture is the vendor array itself, as `normalize()` receives it in
  `DefillamaFetchResult.raw`
- vendor_response_fields (union over the kept rows): address, audit_links, audits, category, chain,
  chainTvls, chains, change_1d, change_1h, change_7d, cmcId, description, dimensions, gecko_id,
  github, governanceID, hallmarks, id, listedAt, logo, mcap, methodology, misrepresentedTokens,
  module, name, openSource, oraclesBreakdown, parentProtocol, parentProtocolSlug, pool2,
  referralUrl, slug, staking, symbol, tags, tokenBreakdowns, tokensExcludedFromParent, treasury,
  tvl, tvlCodePath, twitter, url, wrongLiquidity

## What this replaces, and why

`uniswap.json` / `raydium.json` recorded `GET /protocol/{slug}`, the route `protocol.tvl` used until
L-7. That route cannot be kept: measured the same day, `/protocol/aave-v3` is **28 914 177 bytes
decompressed** (27.57 MiB) against a 10 MiB response cap, and it grows with every further day of
history. This document answers the same question for all 8 009 protocols in **8 539 185 bytes**
(8.14 MiB), once per TTL window instead of once per call.

## Selection

Rows are **verbatim** from the live 2026-08-11 capture — no field was edited, added or reordered
within a row, and their relative order is the document's own. Only the row SET was reduced, to the
seventeen that carry a behaviour this adapter has to get right:

| rows                                                                 | what they pin                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lido`                                                               | a direct row: one slug, one answer, no aggregation                                                                                                                 |
| `aave-v3`                                                            | the L-7 headline protocol, 22 deployment chains — and, asked about `bitcoin`, the not-deployed answer                                                              |
| `uniswap-v1..v4`, `uniswap-auctions`                                 | a parent (`uniswap`) with no row of its own: the aggregate path, including a child whose `tvl` is `null`                                                           |
| `raydium-amm`, `raydium-perps`, `launchlab`                          | the same, on a single-chain protocol, where the vendor's own total matched our sum EXACTLY                                                                         |
| `ether.fi-stake`                                                     | deployed on `Base`/`Arbitrum` with no plain-TVL bucket for them — the `tvlUsd: null` state                                                                         |
| `ether.fi-liquid`, `etherfi-borrowing-market`, `etherfi-cash-liquid` | the rest of the `ether.fi` family; two of them declare `tokensExcludedFromParent`, which is what routes that parent to the vendor's own aggregate instead of a sum |
| `beanstalk`, `basin-exchange`                                        | a slug that is BOTH a row and a parent id: the vendor answers the row, and so do we                                                                                |
| `fantom`                                                             | listed with `tvl: null` and no chains — the "publishes no TVL" refusal                                                                                             |

## Vendor behaviour measured for the resolution rule (not inferred)

Live answers on 2026-08-11, each compared against what this document alone would produce:

| slug              | vendor `/protocol/{slug}` total | from this catalog                            | delta        |
| ----------------- | ------------------------------- | -------------------------------------------- | ------------ |
| `raydium`         | 841 761 617                     | 841 761 617 (sum of 3 children)              | 0.000 %      |
| `beanstalk-farms` | 3 200 912                       | 3 200 913 (sum of 2 children)                | 0.000 %      |
| `sky-lending`     | 5 644 873 089                   | 5 644 873 090 (direct row)                   | 0.000 %      |
| `sky`             | 5 841 432 707                   | 5 841 432 708 (sum of 3 children)            | 0.000 %      |
| `beanstalk`       | 0                               | 0 (**direct row**, not the 3.2 M parent sum) | 0.000 %      |
| `aave`            | 14 661 572 122                  | 14 654 215 342 (sum of 7 children)           | −0.050 %     |
| `uniswap`         | 3 013 826 383                   | 3 010 303 811 (sum of 5 children)            | −0.117 %     |
| `ether.fi`        | 3 491 186 952                   | 3 823 446 099 (sum of 4 children)            | **+9.517 %** |

The sub-percent deltas are one refresh cycle apart, not a different quantity — `lido` and `raydium`
agree to the cent. `ether.fi` is the exception the design turns on: its children declare
`tokensExcludedFromParent`, the vendor nets that double-count out and we cannot reproduce it from
this document, so those parents (38 of 802) are answered by asking the vendor for its own aggregate
rather than by summing. Nine of the ten largest are under 1.7 MiB; `curve-finance` (27.77 MiB) is not,
and fails visibly rather than quietly returning a wrong number.

Also measured, and the reason the code matches on `parentProtocolSlug` rather than on the
`parent#<id>` suffix: `GET /protocol/ether.fi` answers 200 and `GET /protocol/ether-fi` answers 400,
while that row's `parentProtocol` is `parent#ether-fi`. The two fields disagree on 256 of the 2 147
rows that have a parent.
