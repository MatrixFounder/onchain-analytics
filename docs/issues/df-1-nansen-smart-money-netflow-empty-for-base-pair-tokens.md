---
id: DF-1
type: known-issue
status: fixed
opened_at: 2026-07-24
resolved_at: 2026-07-24
resolved_by: TASK-005 / task 005-7
category: dogfood
severity: SEV-3
slug: df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens
component: nansen-adapter
evidence_paths:
  - packages/core/test/fixtures/nansen/smart-money-netflow.json
  - packages/core/test/fixtures/nansen/smart-money-netflow.evidence.md
  - docs/onchain-analytics/raw/task-005-7-live-verification-evidence.md
  - packages/core/src/adapters/nansen/endpoints.ts
  - packages/core/test/nansen.contract.test.ts
---

# DF-1 — Nansen `POST /api/v1/smart-money/netflow` silently returned zero rows for a real, well-known token — two request-construction defects, both fixed

> **Resolution (2026-07-24).** Two real, confirmed root causes, both in OUR OWN request
> construction, both fixed in `packages/core/src/adapters/nansen/endpoints.ts`'s
> `postSmartMoneyNetflow`: **(#1)** `filters.include_stablecoins`/`include_native_tokens` were never
> set and both default to `false` server-side, silently excluding the named token whenever it was a
> stablecoin or wrapped-native asset; **(#2)** `filters.token_address` matches CASE-SENSITIVELY
> against a lowercase-stored column on this ONE endpoint (its `/tgm/*` siblings accept the EIP-55
> checksummed form fine) — `normalizeAddress()`'s canonical checksummed output silently matched
> nothing. Both confirmed live: fixing #1 alone did not resolve the symptom (a 3rd live attempt
> still returned `data: []`); a 4th, isolated diagnostic call (identical request, ONLY the
> `token_address` casing differed) proved #2 — checksummed → `data: []`, lowercase → 1 real,
> populated row. `nansen.contract.test.ts`'s TC-CONTRACT-01 is restored to a populated-result
> assertion against that real recorded response; TC-UNIT-07 now asserts the corrected request body
> (both fixes) directly. Total diagnostic cost: **35cr** across 4 live attempts (this was originally
> misdiagnosed — see the superseded hypothesis below, kept for an honest record of the investigation
> path, not deleted).

> Owning decision: task 005-7 (live-verification recording, R-44) — found while live-verifying the
> `smart-money.flows` capability against real Nansen data, 2026-07-24.

## History (four live attempts, 35cr total diagnostic cost, chronological)

**Attempts 1+2 (20cr, first recording session):** `smart-money.flows` on WETH then USDC (the
task's sanctioned fallback) both returned `{"data": [], "pagination": {...}}` — well-formed,
HTTP 200, correctly priced (5cr `netflow` + 5cr `holders` per attempt). **Originally
misdiagnosed** as a deliberate vendor exclusion of base-pair/numeraire tokens from smart-money
tracking ("not a defect") — **that diagnosis was WRONG**, corrected below.

**Root cause #1 — CONFIRMED, REAL code defect (FIXED):** `postSmartMoneyNetflow` never set
`filters.include_stablecoins` / `filters.include_native_tokens`. Per the committed spec
(`docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json`,
`components.schemas.SmartMoneyNetflowFilters`), BOTH default to `false` server-side — WETH is a
wrapped-native token, USDC is a stablecoin, so BOTH were silently excluded by the vendor's own
default category filters, unrelated to whether Nansen tracks them at all. The vendor's own
`token_address` filter example is literally the USDC address, confirming it is meant to be
reachable with the right flags set. Fix independently verified compiled into `dist/` before the
next live attempt.

**Attempt 3 (10cr, fresh session, `NANSEN_DAILY_CREDIT_CAP=10` so a second attempt in that session
is refused by our own gate):** `smart-money.flows` on USDC again, WITH fix #1 applied and
confirmed sent. Result: **`data: []` again — the symptom persisted even after the confirmed,
correctly-applied fix #1 alone.** `credits_remaining` 74 → 64.

**Root cause #2 — CONFIRMED, REAL code defect (FIXED):** `normalizeAddress()`
(`packages/core/src/chain/address.ts`) always returns the EIP-55 **checksummed** (mixed-case) form,
e.g. `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — this is what was sent as
`filters.token_address` on all three attempts above. The vendor spec's own documented example for
this EXACT filter (`SmartMoneyNetflowFilters.token_address.examples`) is all-lowercase. The SAME
checksummed address, sent to the sibling `POST /api/v1/tgm/holders` endpoint in the SAME
`smart-money.flows` call, DID return real matching data on every attempt — circumstantial evidence
that `/tgm/holders`' address matching is case-insensitive while `/smart-money/netflow`'s
`token_address` matching is not.

**Attempt 4 (5cr, isolated diagnostic call, NOT through `record-fixture.mjs`/`createNansenAdapter`
— see `smart-money-netflow.evidence.md`'s own provenance note):** the identical request sent
twice, differing ONLY in `token_address` casing — checksummed → `data: []` (confirms the bug);
lowercase `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` → **1 real row**
(`net_flow_24h_usd: -325939.12`, `trader_count: 142`, `token_sectors: ["Stablecoin"]`, ...). This
row is now the committed `smart-money-netflow.json` fixture. `credits_remaining` 64 → 59.

**Fix applied and verified:** `postSmartMoneyNetflow` now sends
`token_address: params.tokenAddress.toLowerCase()` — the canonical EIP-55 checksummed form remains
what this package stores/returns/cache-keys on; ONLY this one vendor filter is lowercased.

## Impact (resolved)

`nansen.contract.test.ts`'s TC-CONTRACT-01 (task 005-4's "happy path, populated netflow" golden
case) is restored to a populated-result assertion against the real recorded response (attempt 4) —
the earlier `toThrow(...)` form, which had accidentally codified the (partially fixed, then fully
fixed) defect as expected behavior, is removed entirely. TC-UNIT-07 asserts the exact corrected
request body (both fixes) against a fake `fetchImpl`, closing the "does production code really
build the request the fixture's real response was recorded against" gap without further live
spend. TC-VERIFY-10 (M-6 exit criterion) now **fully passes** — both `netflow*Usd` values and
`topHolders[].addressLabel` are present in the live-derived normalized result.

## Superseded hypothesis (kept for an honest investigation record, NOT the final conclusion)

*(Originally filed here as "root cause #2 — NOT yet confirmed" before attempt 4. Superseded by the
CONFIRMED root cause #2 above — kept verbatim below for the historical record, not deleted.)*

> `normalizeAddress()` ... always returns the EIP-55 **checksummed** (mixed-case) form ... The
> vendor spec's own documented example for this EXACT filter ... is **all-lowercase** ... **Not
> proven** — the only way to confirm is a live call passing a lowercase `token_address`, which
> costs another 10cr and has NOT been run.

**Do-not (still applicable).** Do not re-attempt the checksummed-address request expecting a
different result — reproducible, not transient, confirmed across 3 independent attempts. Do not
assume EVERY Nansen endpoint is case-sensitive on `token_address` from this one finding — `/tgm/*`
siblings are confirmed case-insensitive; treat each endpoint's address-matching behavior as its own
fact, not a blanket assumption, unless/until independently verified.
