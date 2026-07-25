# Task 005-7 — live-verification evidence (R-44)

Recorded 2026-07-24, run by the Developer agent. Three sessions: session 1 (original recording,
`NANSEN_DAILY_CREDIT_CAP=30`, through `createNansenAdapter`'s full production path — singleflight
-> budget-gate -> sub-calls -> reconcile — against a real, persistent `DATA_DIR`/`BudgetStore`),
session 2 (coordinator-directed corrective re-run, `NANSEN_DAILY_CREDIT_CAP=10`, fresh `RECDIR`,
exactly one paid call through the same production path, a second refused by our own gate), and
session 3 (one isolated, coordinator-run diagnostic call made DIRECTLY against the vendor API —
NOT through `record-fixture.mjs`/`createNansenAdapter` — to isolate the final root cause; see §3.5
and the affected fixture's own evidence file for the honest provenance distinction). No key value,
request headers, or raw HTTP payloads containing the key appear anywhere below or in any committed
fixture/evidence file.

## 0. Correction history (read this first)

This file went through two corrections as the investigation progressed — both are kept below (§3,
§3.5, §3.6), not silently overwritten, as an honest record of the actual path:

1. **First diagnosis (WRONG):** "deliberate vendor exclusion of base-pair tokens, not a defect."
2. **First correction:** root cause #1 found and fixed (`include_stablecoins`/`include_native_tokens`
   missing) — but a re-test proved this alone did NOT resolve the symptom.
3. **Second correction (FINAL):** root cause #2 found and fixed (`token_address` case-sensitivity on
   this one endpoint) — confirmed live, symptom fully resolved. **DF-1 status: `fixed`.**

## 1. Credits — before / after / actual spend (all three sessions)

| Step | `credits_remaining` | Note |
| --- | --- | --- |
| Before (first `nansen account`, session 1) | **100** | matches the pre-verified MONEY FACTS |
| After session 1 (WETH + USDC netflow attempts, token.risk) | **74** | 26cr spent, see §3 |
| After session 2 (one corrective `smart-money.flows` on USDC, fix #1 applied) | **64** | 10cr spent, see §3.5 |
| After session 3 (one isolated diagnostic call, fix #2 confirmed) | **59** | 5cr spent, see §3.6 |
| **Actual spend, total across all three sessions** | **41cr** | owner-authorized in full (session 2's 10cr and session 3's 5cr both explicitly authorized) |

TC-VERIFY-01 (`remaining_before − remaining_after === 16 ± documented deviation`): the ≈16 point
estimate does not hold; final actual spend is 41cr. Fully accounted for: 10cr sanctioned diagnostic
retry (session 1, WETH→USDC, pre-authorized by "14cr headroom, exactly one retry") + 10cr
owner-authorized corrective re-run (session 2, fix #1 verification) + 5cr owner-authorized isolated
diagnostic (session 3, fix #2 confirmation) = 25cr of diagnostic/corrective spend on top of the
16cr plan. Every session's own `NANSEN_DAILY_CREDIT_CAP` was respected — session 2's cap of 10
correctly refused a second attempt in that session at zero further cost, proving the tight gate
worked exactly as designed.

## 2. Per-endpoint observed cost vs. `NANSEN_COST_TABLE` (TC-VERIFY-02, sanity-check)

| Endpoint | Observed `X-Nansen-Credits-Used` | Cost-table `free` | Sanity |
| --- | --- | --- | --- |
| `GET /api/v1/account` | (absent — header not sent on this endpoint) | 0 | UNKNOWN (no header on this endpoint; consistent with a free op, not a mismatch) |
| `POST /api/v1/search/general` | (absent) | 0 | UNKNOWN (same — free endpoint, no header observed) |
| `POST /api/v1/smart-money/netflow` | **5** (all 4 attempts: WETH, USDC pre-fix#1, USDC post-fix#1-pre-fix#2, USDC post-both-fixes) | 5 | **MATCH** |
| `POST /api/v1/tgm/holders` | **5** (session 1 + session 2 attempts) | 5 | **MATCH** |
| `POST /api/v1/tgm/indicators` | **5** | 5 | **MATCH** |
| `POST /api/v1/tgm/token-information` | **1** | 1 | **MATCH** |

No pricing vendor-drift found on any paid endpoint, across all four `smart-money/netflow`
attempts — every observed credit cost matched `NANSEN_COST_TABLE` exactly, including the 3 attempts
that returned `data: []` (the vendor charges for the query, not for a non-empty result).

## 3. Session 1 — original (wrong) diagnosis

Order of live calls (chronological), against the two sanctioned tokens (WETH primary, USDC
fallback):

1. `smart-money.flows` on **WETH** (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) — **10cr spent**.
   `POST /smart-money/netflow` returned `{"data": [], "pagination": {...,"is_last_page":true}}` —
   ZERO rows. `POST /tgm/holders` returned 10 real, well-labeled rows.
2. Diagnosed (not blindly retried): HTTP 200, exact credit match, well-formed response. Retried
   ONCE with the sanctioned USDC fallback, per the task's own "14cr headroom, one deliberate retry"
   allowance.
3. `smart-money.flows` on **USDC** (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) — **10cr spent**.
   Same empty netflow shape; 10 real, well-labeled holder rows again.
4. Per the anti-loop protocol, no third token was tried at this point.
5. `token.risk` on USDC — **6cr spent**, succeeded fully (`market_cap_usd`, `market_cap_group`,
   `is_stablecoin`, 2 risk + 2 reward indicators, all real).
6. **Live proof of the machine gate (0 additional cost):** a deliberate 3rd `smart-money.flows`
   attempt was refused BEFORE any HTTP call (`self-imposed cap: need 10, NANSEN_DAILY_CREDIT_CAP
allows 30`) — confirmed zero spend via a follow-up `account` resync (`credits_remaining` stayed
   74).

**Original hypothesis (WRONG, corrected in §3.5/§3.6):** "WETH/USDC are base-pair tokens, plausibly
excluded from smart-money tracking by vendor design, not a defect." Kept here as an honest record
of the investigation's actual path, not silently erased.

**One transient, unrelated finding (session 1):** one `GET /api/v1/account` resync attempt timed
out after 15s (`safeFetch: timed out after 15000ms`) — a genuine network hiccup, zero budget
impact.

## 3.5. Session 2 — root cause #1 (missing category-inclusion flags), fixed, symptom persisted

**Root cause #1 — CONFIRMED, REAL code defect in OUR request construction (fixed):** per
`docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json`'s
`components.schemas.SmartMoneyNetflowFilters`, `include_stablecoins` and `include_native_tokens`
both default to `false` server-side. `postSmartMoneyNetflow` never set either — so USDC (a
stablecoin) and WETH (a wrapped-native token) were BOTH silently excluded by our own request shape.
The vendor's own `token_address` filter example is literally the USDC address, confirming it is
meant to be reachable with the right flags. **Fix applied** (by the coordinator, built on and
independently verified here): both flags now sent as `true` unconditionally for this token-scoped
capability.

**Independent verification performed before spending again:**

1. Confirmed the spec's defaults directly (`python3` read of the committed openapi JSON) — matched
   the claim exactly.
2. Confirmed the fix was genuinely compiled into `dist/` before the live call ran: grepped
   `dist/adapters/nansen/endpoints.js` for both `true` literals — present.
3. Fixed the necessary, downstream consequence: `nansen.contract.test.ts`'s TC-UNIT-07
   (HTTP-contract test) asserted the OLD, now-incomplete outgoing request body — updated to also
   assert the two new flags.

**Live re-test — tightly gated, exactly one paid call:**

```sh
export RECDIR="$(mktemp -d)"          # fresh ledger, session 2
export NANSEN_DAILY_CREDIT_CAP=10     # allows EXACTLY one 10cr call
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen smart-money.flows ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

Result: `credits_remaining` 74 → 64 (**10cr spent**, correctly priced, MATCH). `POST
/smart-money/netflow` returned **the SAME empty shape again, even with fix #1 confirmed applied.**
`POST /tgm/holders` again returned 10 real, well-labeled rows. A follow-up second
`smart-money.flows` attempt in the SAME session was correctly refused by our own gate (`already
used 10, NANSEN_DAILY_CREDIT_CAP allows 10`) — zero further spend.

## 3.6. Session 3 — root cause #2 (case-sensitive `token_address`), confirmed and fixed

**Hypothesis traced before spending further:** `normalizeAddress()` always returns the EIP-55
checksummed (mixed-case) form — this is what was sent as `filters.token_address` on all three
attempts above. The vendor spec's own documented example for this EXACT filter is all-lowercase.
The SAME checksummed address, sent to the sibling `/tgm/holders` endpoint in the SAME calls, DID
return real matching data every time — evidence that `/tgm/holders` is case-insensitive while
`/smart-money/netflow`'s `token_address` matching might not be.

**Owner-authorized isolated diagnostic call (5cr, made directly against the vendor API by the
coordinator — NOT through `record-fixture.mjs`/`createNansenAdapter`, see
`smart-money-netflow.evidence.md`'s own provenance note for why this fixture's recording mechanism
differs from its siblings):** the identical request sent twice, differing ONLY in `token_address`
casing:

- checksummed `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` → `data: []` (confirms the bug)
- lowercase `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` → **1 real, populated row** (now the
  committed `smart-money-netflow.json` fixture: `token_symbol: "USDC"`,
  `net_flow_24h_usd: -325939.1223102985`, `trader_count: 142`, `token_sectors: ["Stablecoin"]`,
  `token_age_days: 2912`, HTTP 200, `x-nansen-credits-used: 5`, matches cost table)

`credits_remaining` 64 → 59.

**Root cause #2 — CONFIRMED, REAL code defect (fixed):** `/smart-money/netflow`'s
`filters.token_address` matches case-sensitively against a lowercase-stored column — unlike its
`/tgm/*` siblings, which accept the checksummed form fine. **Fix applied:** `postSmartMoneyNetflow`
now sends `token_address: params.tokenAddress.toLowerCase()` — the canonical EIP-55 checksummed
form remains what this package stores/returns/cache-keys on; only this one vendor filter is
lowercased.

**Closing the production-path provenance gap for free (no further live spend):** TC-UNIT-07
(`nansen.contract.test.ts`) now asserts, against a fake `fetchImpl`, that `postSmartMoneyNetflow`
constructs EXACTLY the request body used for the session-3 diagnostic call (lowercase
`token_address`, `include_stablecoins`/`include_native_tokens: true`, `chains: [chain]`) — proving
the production code genuinely builds the same request whose real response this fixture records,
without needing to re-record it through `record-fixture.mjs` itself.

**Total diagnostic cost of the whole investigation: 35cr** (10 WETH + 10 USDC-pre-fix#1 + 10
USDC-post-fix#1 + 5 isolated diagnostic) out of 41cr total task spend.

## 4. TC-VERIFY-10 (M-6 exit criterion #1) — FULLY PASSES

> "живой ответ smart-money.flows содержит netflow\*Usd И topHolders[].addressLabel"

Verified directly against `createNansenAdapter`'s own `normalize('smart-money.flows', raw)`, fed
the real committed fixtures (`smart-money-netflow.json` + `tgm-holders.json`):

```
netflow24hUsd: -325939.1223102985 (number)
has any netflow*Usd number: true
topHolders count: 10
>=1 addressLabel: true
```

- **Holder-label half: PASS** — `topHolders[].addressLabel` populated on all 10 rows.
- **Netflow half: PASS** — `netflow1hUsd`/`netflow24hUsd`/`netflow7dUsd`/`netflow30dUsd` are all
  real numbers on the normalized result.

**Both halves pass. TC-VERIFY-10 is satisfied.**

## 5. Offline-run proof ("0 credits forever after") — re-run on the final, corrected state

Full workspace suite run with the real global `fetch` overridden to throw on any invocation
(`NODE_OPTIONS="--import <block-network.mjs>"`, independently verified to genuinely propagate into
vitest's worker environment and to not be a false-negative), after both fixes, the restored
TC-CONTRACT-01, and the TC-UNIT-07 update:

```
packages/core test:  Test Files  27 passed (27)
packages/core test:       Tests  310 passed (310)
packages/mcp-server test:  Test Files  13 passed (13)
packages/mcp-server test:       Tests  143 passed (143)
```

453/453 green, zero outgoing network calls. Identical counts to an ordinary (non-network-blocked)
`pnpm test` run.

> ⚠️ **That run is NOT the shipped tree** (recorded 2026-07-25, `/vdd-multi` cycle 4, completeness
> G-11). It predates commit `15b8dfa` (Q-2), which added ~52 tests. The claim above that it was run
> "against the final, corrected, committed state" was true when written and stopped being true one
> commit later.

**Re-run 2026-07-25, against the tree that actually ships** (post-Q-2, post-cycle-4 fixes). Same
mechanism, hardened: the block now also stubs the raw `node:http`/`node:https` clients, not only
`fetch` — a direct `http.request` would otherwise slip past a fetch-only stub. Propagation into the
vitest worker re-verified first with a throwaway probe test that asserts `fetch(...)` rejects with
`NETWORK BLOCKED` (it did), so a green suite cannot be a false negative from an inert block.

```
packages/core       Test Files  28 passed (28)   Tests  369 passed (369)
packages/mcp-server Test Files  14 passed (14)   Tests  150 passed (150)
```

**519/519 green, zero outgoing network calls**, identical to the ordinary run. `TC-VERIFY-06`/
`TC-VERIFY-08` are now demonstrated for the shipped commit rather than an ancestor of it.

## 6. Golden-test (`nansen.contract.test.ts`) — M-2 overrides logged (final)

- **Baseline SHA** (005-4, pre-005-7, spec-derived fixtures):
  `c514c8ac129a568aa2e8330458d2a08928d5c75b4fd76c0999e2d1d6cd747cf8`
- **SHA after the first 005-7 pass** (session 1 fixtures, TC-CONTRACT-01 as a throw-assertion,
  TC-CONTRACT-02/04 rewritten):
  `5668ad7c64c8812e748b996cbb735fb5c68b024f50bd28c003c928f32b10682b`
- **SHA after the first correction pass** (session 2, TC-UNIT-07 gained the two flags):
  `d8400f91e0178a03c124ffe657d6fedc724dda40e1a17879acd5590dff1473c5`
- **SHA logged at the end of session 3** (TC-CONTRACT-01 restored to a populated-result assertion,
  TC-UNIT-07 gained the lowercase `token_address` assertion, header comment finalized):
  `4f3a923dac4ed14bd04adb67cd48985aaecae825ef82e6e53e9a6e8cba14bf6e`
- ⚠️ **PROVENANCE BREAK, recorded 2026-07-25 (`/vdd-multi` cycle 4, completeness G-2).** That SHA is
  **not** the file that was committed. The file in commit `4c51126` hashes to
  `7bc03cd8bd03f9e7f7a27851ec309b615927d0a9bae1f3fb87ef08e418457a3d` — so at least one unlogged edit
  landed between the last recorded override and the commit. The whole point of this SHA chain is to
  make a silent test-tuning detectable; for that window it cannot, and no amount of later hashing
  recovers what changed. Stated plainly rather than quietly re-baselined. The assertions themselves
  were independently re-derived from the vendor spec during cycle 4's completeness audit and match
  what this document describes, which is corroboration, not proof.
- **SHA after `/vdd-multi` cycle 4** (added the Solana no-case-fold request-shape assertion, L-1;
  hashed after `prettier --write`, which is what lands in the commit):
  `e24d077a0940c5ec5a11002a800d96a078afaab9fd209b09081e1a016d45b36e`
  Re-hash with `shasum -a 256 packages/core/test/nansen.contract.test.ts` and compare **against the
  committed blob** (`git show <sha>:<path> | shasum -a 256`), not the working tree — the mismatch
  above is exactly the failure that comparing only the working tree hides.

Assertion changes, all logged in the test file's own header comment:

1. **TC-CONTRACT-01** — restored to a POPULATED-result `toEqual({...})` assertion against the real
   recorded USDC netflow row (§3.6) merged with the real `tgm-holders.json` — asserting
   `tokenSymbol: 'USDC'`, `netflow24hUsd: -325939.1223102985`, `traderCount: 142`,
   `tokenAgeDays: 2912`, `tokenSectors: ['Stablecoin']`, and the auto-derived `topHolders[]`. The
   `toThrow(...)` form used during the investigation is REMOVED entirely — it had accidentally
   codified our own (by-then-partially-fixed) defect as expected behavior.
2. **TC-CONTRACT-02** — unchanged since the first pass: `UNI_ADDRESS` → `USDC_ADDRESS`; the stale
   "Wintermute" entity expectation removed (live search returned zero entity matches).
3. **TC-CONTRACT-04** — unchanged since the first pass: full literal rewrite to the real recorded
   USDC `tgm/indicators` values.
4. **TC-UNIT-07** — the outgoing `smart-money/netflow` request-body assertion now expects BOTH
   fixes: `include_stablecoins`/`include_native_tokens: true` AND a LOWERCASED `token_address`
   (`/tgm/holders`' own `token_address` stays checksummed, unaffected — different endpoint,
   different matching behavior). This is the "unit assertion that production code builds exactly
   the request the fixture's real response was recorded against" the resolution calls for.

No other test file's assertions were touched. `registry.ts` — zero edits, re-verified
(`git diff --stat -- packages/core/src/adapters/registry.ts` empty).

## 7. Other observed vendor-shape note (zero functional impact, not filed as an issue)

Live `tgm/token-information` wraps its fields under a top-level `data` key vs. the spec-derived
provisional fixture's unwrapped top-level fields. `normalizeTokenRiskScore` never reads
`raw.tokenInformation`'s content at all (documented, by design) — zero behavioral effect, no code
change needed, not filed as a KNOWN_ISSUES entry.

## 8. Fixtures replaced vs. intentionally left provisional

**Replaced with genuinely recorded live data:** `account.free`, `search-general`, `tgm-holders`
(session 2's post-fix-#1 recording), `tgm-indicators`, `tgm-token-information` — all recorded
through `scripts/record-fixture.mjs`/`createNansenAdapter`'s full production path, `.evidence.md`
reading `provenance: live, recorded via scripts/record-fixture.mjs through createNansenAdapter
(task 005-7)`.

**One exception, honestly distinguished:** `smart-money-netflow.json` was recorded via the
session-3 **isolated diagnostic call**, made directly against the vendor API to isolate root cause
#2 — NOT through `record-fixture.mjs`. Its own `.evidence.md` says so explicitly and does not claim
production-path provenance. TC-UNIT-07 (§3.6/§6) is the free, zero-spend proof that the production
code (`postSmartMoneyNetflow`, post-fix) genuinely constructs the identical request this fixture's
real response was recorded against.

**Intentionally left provisional (out of this task's own documented scope, unchanged throughout):**
`account.pro` (no live Pro subscription), `search-general.empty`, `tgm-holders.empty-labels` (no
reproducible-live "0 results"/"0 labels" shape was ever this task's concern). `grep -l "provenance:
spec-derived" packages/core/test/fixtures/nansen/*.evidence.md` correctly still matches exactly
these 3 files.

## 9. Verification commands run (all against the final, corrected, committed state)

```
pnpm --filter @onchain-intel/core build                                    # clean
pnpm --filter @onchain-intel/core exec tsc --noEmit                         # clean
pnpm --filter @onchain-intel/core exec eslint src/adapters/nansen/endpoints.ts test/nansen.contract.test.ts scripts/record-fixture.mjs   # clean
npx prettier --check <every touched file>                                  # clean
pnpm --filter @onchain-intel/core exec vitest run test/nansen.contract.test.ts   # 14/14 green
pnpm test                                                                    # 453/453 green
NODE_OPTIONS="--import <block-network.mjs>" pnpm test                       # 453/453 green, offline
shasum -a 256 packages/core/test/nansen.contract.test.ts                   # final SHA, see §6
git diff --stat -- packages/core/src/adapters/registry.ts                  # empty
grep -l "provenance: spec-derived" packages/core/test/fixtures/nansen/*.evidence.md   # 3 expected matches (§8)
grep -c "x_nansen_credits_used" packages/core/test/fixtures/nansen/*.evidence.md      # 1 on each of the 6 live files, 0 on the 3 provisional ones
grep -rn "record-fixture" .github/workflows/                               # no matches (recorder not in CI)
grep -rn "profiler/address" packages/core/test/fixtures/nansen/            # no matches (no expensive endpoint recorded)
```

No commits made.
