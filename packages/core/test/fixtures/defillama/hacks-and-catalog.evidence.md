# `hacks-and-catalog.json` — evidence

- captured: 2026-08-12
- sources: `GET https://api.llama.fi/hacks` and `GET https://api.llama.fi/protocols`, both keyless
- issue: [WI-52](../../../../../docs/backlog/wi-52-no-protocol-risk-signals.md)

## What this fixture is

Verbatim rows from both live documents, selected — never edited — so that one file exercises every
branch of `normalizeProtocolIncidents`. The catalog rows are trimmed to the fields the adapter
reads; no value is rewritten.

- 4 catalog rows: `aave-v3`, `curve-dex`, and the `venus-core-pool` / `venus-flux` pair, which share
  `parentProtocol: "parent#venus-finance"`.
- 8 incident rows: 5 attached by `defillamaId`, 6 reachable through `parentProtocolId`, and 2
  carrying **no protocol identifier at all** — the class that bounds what an empty answer can mean.

## The joins, measured on the FULL documents (not on this slice)

| join | matched |
| --- | --- |
| `hack.defillamaId` → `protocol.id` | 353 of 357 records that carry an id (99%) |
| `hack.parentProtocolId` → `protocol.parentProtocol` | 97 of 97 (100%) |

Neither key was inferred. `cmcId`-style guessing is not available here and was not attempted: the
vendor publishes both identifiers on both documents, and they were compared directly.

## Feed shape, at capture time

| fact | value |
| --- | --- |
| records | 621 |
| date range | 2016-06-17 → 2026-08-09 |
| age of the newest record | 2.5 days |
| records in the last 365 days | 219 |
| records in the last 90 days | 99 |
| records with `defillamaId` | 357 of 621 |
| records with **no** protocol id | 264 of 621 |
| distinct protocols affected | 299 |
| total stated loss | $16.9 B |

Field fill rates ran from 621/621 (`date`, `name`, `targetType`, `bridgeHack`) down to 29/621
(`returnedFunds`) — which is why every field but `date`/`name` is nullable in the canonical shape.

## Why the age numbers are recorded here

WI-52 requires that non-on-chain signals carry their own provenance and age rather than inheriting
the freshness of the on-chain metric beside them. "2.5 days old, 99 records in 90 days" is the
evidence that this feed is maintained rather than an archive — and it is also the reason
`feedThroughTs` exists in the result instead of a prose note in a docstring.
