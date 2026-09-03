> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [data-model.md](data-model.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

### 4.1. Entities Overview

**Canonical types (M1, `packages/core/src/types/*`)** — full zod schemas in §3.2. In brief:

#### Entity: `Token`

- **Description:** token metadata and price for one chain/address.
- **Key attributes:** `chain`, `address` (normalized), `symbol`, `name`, `decimals?`, `priceUsd?`,
  `marketCapUsd?`, `source`, `fetchedAt`.
- **Business rule:** `address` has always passed `normalizeAddress(chain, raw)` before it reaches
  the type — no adapter puts raw user input into a canonical object.

#### Entity: `Wallet` / `Balance`

- **Description:** a wallet's balances on a chain. `Balance` is an array element and distinguishes
  `assetType: 'native' | 'token'`; in M1 only `'native'` is populated (§3.2).
- **Relationships:** `Wallet 1:N Balance` — an embedded array, not a separate table: M1 does not
  persist balances outside the cache.
- **Business rule:** `amountRaw` is the exact integer **as a string** (DB-SCHEMA §1.7: wei/lamports
  exceed the safe 2^53); `amountNum` is a lossy projection and never the source of truth.

#### Entity: `Pool`

- **Description:** a DEX trading pair — consumed by `onchain_active_pairs`.
- **Key attributes:** `id`, `chain`, `dexId`, `baseTokenSymbol`/`quoteTokenSymbol`, `pairAddress`,
  `createdAt?`, `liquidityUsd?`, `volume24hUsd?`, `source`, `fetchedAt`.

#### Entity: `OHLCV` (reserved, not consumed in M1)

- Fields — see the §3.2 schema. The type exists because R-1 requires it to exist; the first consumer
  is M1.5+.

#### Entity: `Snapshot` (D5 addition, persistent form — DB-SCHEMA-CONCEPT §2)

- The engine **never writes** snapshots. The autonomous loop stays on n8n + Postgres permanently
  (owner decision 2026-07-25, ADR-001 D8 addendum). The type exists as the canonical **read** form
  of that same `snapshots` table — the form the `pg-history` adapter returns (R-12).
- **Name mapping at the persistence boundary:** `SnapshotSchema` is camelCase (`valueRaw`,
  `valueNum`); the persistent columns of DB-SCHEMA §2 are snake_case (`value_raw`, `value_num`).
  `metric`/`asset`/`ts`/`source`/`height` match literally and are not renamed. Nothing implements
  the mapping today because nothing on the engine side writes `snapshots`; it is needed on the
  **reading** side once M3 rules start parsing history. It must be an explicit (de)serializer for
  exactly `valueRaw↔value_raw`/`valueNum↔value_num`, not a blanket camelCase→snake_case over every
  field. Recorded here so M3 does not have to reopen the question.

#### Entity: `SmartMoneyFlow` (M2, TASK-005, D5 extension, R-31)

- **Description:** smart-money net flow for a token over several rolling windows, plus the top
  holder addresses with labels — consumed by `onchain_smart_money_flows`. A composite type: it is
  built from TWO Nansen endpoints (`POST /smart-money/netflow` →
  `SmartMoneyNetflowResponse.data[]`, `POST /tgm/holders` → `TGMHoldersResponse.data[]`) merged
  inside a single `nansen.fetch()` call (§3.2) — not two separate canonical types.
- **Key attributes** (traced field-by-field onto the `SmartMoneyNetflow`/`TGMHolder` schemas of
  `nansen-openapi-2026-07-23.json`): `chain`, `tokenAddress` (normalized via `normalizeAddress`),
  `tokenSymbol`, `netflow1hUsd`/`netflow24hUsd`/`netflow7dUsd`/`netflow30dUsd`
  (`SmartMoneyNetflow.net_flow_{1h,24h,7d,30d}_usd`), `traderCount?`/`tokenAgeDays?`/
  `tokenSectors?[]` (`SmartMoneyNetflow.trader_count`/`token_age_days`/`token_sectors`),
  `topHolders[]`, `source`, `fetchedAt`. Each entry of `topHolders[]` is `{address, addressLabel?,
tokenAmount?, valueUsd?, ownershipPercentage?}` (from `TGMHolder[]`) — a subset of `TGMHolder`'s
  fields, not the full DTO.
- **Four fixed windows, not one generic `windowStart`/`windowEnd`:** the live response does not
  offer an arbitrary window, it offers a fixed set. R-31's `netflowUsd` is read as a floor —
  `netflow24hUsd` satisfies it and the other three are extra precision.
- **Business rule:** anti-corruption layer — the Nansen DTOs (`SmartMoneyNetflow`/`TGMHolder`,
  including the `{data, pagination}` envelope) never leak outward, the same pattern as
  `Token`/`Pool` (§3.2). Golden test on a fixture (R-31 acceptance).

#### Entity: `EntityLabel` (M2, TASK-005, D5 extension, R-32)

- **Description:** the label of an address or entity (wallet, fund, exchange, known trader) —
  consumed by `onchain_entity_label`. The source depends on the call tier (§3.2 `costOf()` table).
  The default tier is `POST /search/general` → `GeneralSearchResponse.{tokens[], entities[]}`
  (`TokenSearchResult`/`EntitySearchResult`). Token-scoped enrichment comes from
  `TGMHolder.address_label`. The exhaustive escalation is `POST /profiler/address/labels` (its
  response shape is fixtured from a live call on first real use, R-44).
- **Key attributes:** `chain?` and `address?` are both optional — `EntitySearchResult` carries
  neither, because an entity can be cross-chain (a name and tags with no particular address);
  results derived from `TokenSearchResult`/`TGMHolder` do carry them. Plus `name?`, `tags[]`
  (default `[]`, from `EntitySearchResult.tags`), `labels[]` (default `[]`, from
  `TGMHolder.address_label` wrapped in an array), `premiumRequested: boolean`, `source`,
  `fetchedAt`. For `labels[]`, **an empty array is a valid result** — "no labels", not an error
  (R-32). `premiumRequested` is an explicit flag: `true` only when the call went through the
  `exhaustive: true` path (R-42).
- **Business rule:** neither `chain` nor `address` is mandatory (unlike `Token`/`Wallet`) — the only
  M2 type where that holds, and it holds because of the real shape of `EntitySearchResult`. Golden
  tests on a fixture with ≥1 label AND on a fixture with 0 labels (R-32 acceptance).

#### Entity: `TokenRiskScore` (M2, TASK-005, D5 extension, R-33)

- **Description:** risk/reward indicators for a token — consumed by `onchain_token_risk`. A
  composite type: `POST /tgm/indicators` (`TGMIndicatorsResponse`) + `POST /tgm/token-information`
  (token metadata), one `nansen.fetch()` call.
- **Key attributes** (traced onto the `TGMIndicatorsResponse`/`TGMIndicatorTokenInfo`/`TGMIndicator`
  schemas): `chain`, `address`, `marketCapUsd?`/`marketCapGroup?`/`isStablecoin?`
  (`TGMIndicatorTokenInfo`), and `riskIndicators[]`/`rewardIndicators[]` as **separate** arrays
  (R-33: not flattened into one list). Each element is `{indicatorType, score?, signal?,
signalPercentile?, lastTriggerOn?}` (`TGMIndicator`), where `score` is qualitative per the spec —
  risk → low/medium/high, reward → bearish/neutral/bullish. The `signal` and `signalPercentile`
  fields are `number`, not strings (R-33: these are not wei-like on-chain integers, so a JS
  `number`/`REAL` is safe). Plus `source`, `fetchedAt`.
- **Business rule:** anti-corruption layer, golden test on a fixture (R-33 acceptance).

#### Entity: `ChainSupply` (TASK-009, D5 extension, R-83)

- **Description:** how much of a chain's native asset exists — consumed by `onchain_chain_supply`.
  Served for `bitcoin` only, from the keyless `blockchain-info` adapter. It is the first canonical
  type whose subject is a **chain's monetary state** rather than a token, wallet, pool or label.
- **Key attributes:** `chain`, `symbol`, `decimals`; `emissionRaw` and `circulatingRaw` as
  **satoshi strings**, each with a lossy `…Btc` number projection for charts and comparison;
  `blockCount` (the height the vendor's own emission figure is consistent with); `source`,
  `fetchedAt`.
- **Why two supply fields and not one:** they are different quantities and the difference is real.
  `emission` is what the halving schedule has released, `circulating` is what miners actually
  claimed, and ~29–32 BTC of subsidy was never claimed (§3.2, measured 2026-07-29). Collapsing them
  would mean serving one under the other's name at a 0.00016% error — invisible, and a fabrication.
- **Business rule:** `circulating ≤ emission` is a **consensus** invariant, not a heuristic, and is
  enforced in `normalize()`: a response violating it is refused, never rounded into agreement.
  Exact values stay strings and are computed through `bigint` (DB-SCHEMA §1.7); `decimals: 8` is a
  Bitcoin consensus constant, taken from consensus rather than from the registry, whose
  `nativeDecimals` for `bitcoin` is `null` (see OQ in `docs/TASK.md`).

#### Entity: `ChainInfo` (TASK-006, R-48) — **the chain registry**

- **Description:** one chain, described in full. This is **not** a canonical domain type in the D5
  sense (it is not an observation obtained from a provider) — it is the **registry** against which
  canonical types are interpreted. Hence where it lives: a **vendored build artifact**, not a DB
  table and not a network call (rationale — §4.2.1).
- **Key attributes:**

| Field            | Type                                                        | Purpose                                                                                                               |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `caip2`          | `string` **PK**                                             | Canonical id in CAIP-2 form: `eip155:80094`, `solana:5eykt4Xh…`.                                                      |
| `slug`           | `string` UNIQUE                                             | Human-readable canonical slug (`berachain`).                                                                          |
| `name`           | `string`                                                    | Display name (`Berachain`).                                                                                           |
| `family`         | `'evm' \| 'svm' \| 'move' \| 'cosmos' \| 'utxo' \| 'other'` | Determines **address validation** (R-55) and whether `rpc-evm` can serve the chain.                                   |
| `aliases`        | `string[]`                                                  | Every other accepted spelling, including the legacy `ethereum`/`solana` (R-59a) and vendor ids.                       |
| `nativeSymbol`   | `string \| null`                                            | Symbol of the **gas** token (`BERA`, `XDAI`).                                                                         |
| `nativeDecimals` | `number \| null`                                            | Decimals of that same gas token.                                                                                      |
| `vendors`        | `Record<vendorId, string \| null>`                          | **Naming only:** what this chain is called at each vendor.                                                            |
| `rpcHosts`       | `string[] \| null`                                          | The curated SSRF allowlist for this chain (R-56a). `null` = `wallet.balances.native` is honestly uncovered, see §7.2. |
| `tvlUsdAtSync`   | `number \| null`                                            | TVL **as of the registry sync**, knowingly stale.                                                                     |
| `deprecated`     | `boolean`                                                   | The chain disappeared from the vendors, but the row is kept (R-49f) — references and cache keys do not break.         |

**Details by field** — the detail moved out of the cells above, keyed by the same field name:

- **`caip2`** — the registry's stable primary key.
- **`slug`** — what an agent writes in `chain`, what `onchain_list_chains` returns, and what goes
  into the cache key (§4.2.2).
- **`aliases`** — globally unique.
- **`nativeSymbol`** — consumed by `pairs.active` (R-57a) and `wallet.balances.native` instead of
  a hardcode.
- **`vendors`** — `defillama`→`"Berachain"`, `coingecko`→`"berachain"`,
  `dexscreener`→`"berachain"`. `null` = **we hold no confirmed identifier**, which is NOT the same
  as the vendor not having the chain — see §4.2.3a.
- **`tvlUsdAtSync`** — exists **solely** to filter and rank in `onchain_list_chains` without a
  network call.

The two native-token columns carry the failure they prevent:

- `nativeSymbol` is the **gas** token, never the chain's listing/governance token: `arbitrum` is
  `ETH`, not `ARB`. `null` means we do not know, and the capability that needs it is honestly
  uncovered rather than silently wrong.
- `nativeDecimals` is required because `eth_getBalance` returns an integer in the minimal unit —
  with no decimals there is nothing to label it with. The value 18 is an EVM convention, not a
  rule: 29 chains in the EIP-155 catalog use something else. A hardcoded 18 is a wrong answer that
  looks right.
  For non-EVM families the value comes from the generator's curated table
  (`CURATED_NATIVE_DECIMALS`), because EIP-155 knows nothing about them.

- **Relationships:** `ChainInfo 1:N` aliases (embedded array). It references no other entity — the
  reverse holds: `Token`/`Wallet`/`Pool`/`SmartMoneyFlow` reference a chain through their own
  `chain` field.

- **Business rules (each one is a test, R-60c):**
  1. `caip2` is unique; `slug` is unique; **the set of all `aliases` intersects no `slug` and no
     other `aliases`** — otherwise resolution is ambiguous. Checked at startup.
  2. **An alias is resolved to the canonical chain BEFORE the cache key is built.** Otherwise
     `"ethereum"` and `"eth"` produce two cache entries for one and the same request. This is not
     an optimization, it is correctness (§4.2.2).
  3. `tvlUsdAtSync` is **never** returned as the answer to "what is the TVL" — that is `chain.tvl`
     (R-53). In the `onchain_list_chains` payload the field is named `tvlUsdAtRegistrySync`, so the
     two cannot be confused.
  4. `vendors` describes **naming, not coverage.** Coverage is a derived quantity (§4.2.3), and
     mixing the two is forbidden: otherwise "Nansen does not have this chain" and "we never checked
     Nansen on this chain" become indistinguishable (R-58d).

#### Entity: `CoverageProbe` (TASK-006, R-58) — a recorded fact about a vendor

- **Description:** the recorded result of establishing the chain coverage of a vendor whose coverage
  cannot be derived from a public catalog. In the MVP there is exactly one consumer: `nansen`.
- **Key attributes:** `vendorId`, `probedAt` (epoch-ms UTC), `chains: string[]` (the chains
  confirmed by the evidence), `creditsSpent`, `evidencePath` (a file under `raw/`).
- **Business rule:** the absence of a probe means **`unverified`, not `unsupported`** (R-58d). What
  the engine actually gates on is described in §4.2.3.
- **Consumers: two, not one.** `nansen/chain-coverage.ts` was the first; task 014-32a added
  `dexscreener/chain-coverage.ts`, which carries a per-chain `status` beside the identifier.

##### 4.2.3a. What a `null` in `vendors.<id>` means, stated once

**Two readings of this `null` were in circulation and they contradicted each other.** The
description of the `vendors` column above read it as "the vendor does not have the chain", while the
probe rule three lines down reads an absent probe as `unverified`. The second is authoritative, and
the first was the defect. DexScreener's column was populated on 3 rows of 458, so the first reading
declared 455 chains unserved. That was false for 62 of them, filed as L-18 and fixed by task
014-32a.

**The column names, it does not cover.** `vendors.<id>` answers "what is this chain called at vendor
X". A `null` means we hold no confirmed name — because nobody probed, or because a probe reached the
vendor and could not confirm the identifier. Coverage is decided by the adapter's predicate. WHY a
pair is uncovered is answered by `CoverageStatus` (R-33.5). It distinguishes "the vendor does not
serve this chain" from "no confirmed vendor identifier" from "the vendor serves it and this
capability is not built on it".

#### Artifact: `CapabilityManifest` + `PolicyDescriptor` (T-012, ADR-002 D2/D3) — compiled facts, not tables

**SHIPPED (T-012, commit `6af4b19`, 2026-08-05).**

- **Description:** like `ChainInfo` above, these are **not** canonical domain types in the D5
  sense: they describe how a capability is ROUTED, not an observation obtained from a provider.
  They are committed TypeScript literals (`capabilityManifests` in `src/capability-manifest.ts`,
  the policy class dictionary in `src/adapters/policy.ts`). They are validated once at
  `CapabilityRegistry` construction and held in process memory, never in the cache DB or in
  Postgres (D1 — tier-1 config in the commit).
- **Key attributes:** `CapabilityManifest` is a DISCRIMINATED union, not a flat interface (H4,
  architecture review 2026-08-03). A flat shape would let a future `merge` field attach to a
  `point` manifest with no compiler objection. The union has two variants:
  `{shape:'point', ttlSeconds, deadlineMs, shareable?}` or
  `{shape:'set'|'series', ttlSeconds, deadlineMs, shareable?}`. Both variants also carry an
  optional `paidLegMs`, present only when the capability's route can reach a `tier:'paid'` adapter.
  That field documents the UNCANCELLABLE tail past a committed credit reservation (OD-3, owner
  2026-08-03; worst case for such a capability is `deadlineMs + paidLegMs`, never `deadlineMs`
  alone). `PolicyDescriptor` is a discriminated union: `{ kind: 'any' }` or
  `{ kind: 'someElementHasAny', fields: string[] }`.
- **Relationships:** every `CapabilityRoute.capability` must resolve to exactly one
  `CapabilityManifest` entry, and every `CapabilityRoute.policy.kind`, when present, must resolve
  against the policy dictionary. Both are enforced the same way the chain registry enforces its
  own invariants (§4.2.1: at construction, never at first request). The order is FIXED — manifest
  presence is checked before policy `kind` — so a negative test can isolate exactly one failure
  (C2, architecture review 2026-08-03).
  **M-6 correction (architecture review round 2, 2026-08-03):** only the MANIFEST map is an
  injected, defaulted constructor parameter on `CapabilityRegistry`
  (`manifests: Readonly<Record<string, CapabilityManifest>> = capabilityManifests` —
  system-architecture.md, "Capability Registry"). It is the same seam the chain registry already
  uses one parameter to the left. A test route table with synthetic capabilities therefore supplies
  its own small manifest map instead of inheriting the real 20-row one. The POLICY class dictionary
  is a **module-level registry** (`src/adapters/policy.ts`, system-architecture.md
  "Policy descriptor + class registry"), not a constructor parameter, and needs no injection of its
  own. A test exercising an unregistered `kind` expresses the bad value in the ROUTE itself
  (`{ policy: { kind: 'bogus' } }`), which is the thing under test either way. There is no scenario
  where a test needs a DIFFERENT policy dictionary, only a route referencing a `kind` the real one
  does not have. (An earlier draft of this section said "both maps are injected... one parameter to
  the left" — two maps cannot both occupy one parameter position, and the code only injects the
  one that has a real reason to vary.)
- **Business rules:** manifest carries no `chains`/`providers`/`price`. Those are derived from
  `chainSupport()`, `routes`, `costOf()` respectively — the identical "one fact, one place" rule the
  chain registry already applies to coverage (§4.2.3). A `policy.kind` or `capability` unresolved
  against either artifact is a construction-time failure, never a silent default.

**DESIGNED, not built (T-013, ADR-002 D5/D6, 2026-08-05) — the merge-eligibility field, and how
`CapabilityResolution` grows to carry a merged answer.** The `set | series` arm of `CapabilityManifest`
gains one optional field (illustrative name `mergeable?: boolean`; final name is Development's
choice, R-159a). That field discharges the obligation the union's own docstring already names for
T-013 (`packages/core/src/capability-manifest.ts:158-159`,
`the obligation the paragraphs below used to describe as future is discharged.`).
Declaring it on the `point` arm is a compile error (R-159/R-160).
Eligibility is a fact about the CAPABILITY's identity key (`Snapshot.metric`/`asset`/`ts`, D6 reason
1). It is deliberately NOT sufficient to activate collection by itself: `CapabilityRoute` gains a
second, independent field (`merge?: boolean`) checked against `mergeable` at construction
(`OQ-T013-2`, full reasoning in [system-architecture.md](system-architecture.md) "Merge mechanism").
Two gates, not one. (1) A route flag is a literal deviation from D5's text, which R-181 already
budgets for at exactly two deviations elsewhere — a third would go unrecorded. (2) UC-20 phrases the
failure as an act the ROUTE performs, which manifest-only activation cannot even construct. **A
capability with more than one `CapabilityRoute` is explicitly OUT OF SCOPE.** No construction-time
check enforces that sibling routes agree on `merge`. The two-gate design does not, on its own, let
one route of a capability merge while another does not. system-architecture.md states this plainly
rather than implying selectivity the design cannot deliver.

`CapabilityRegistry.resolve()`'s return shape gains three OPTIONAL fields, all populated ONLY on a
merge-enabled walk (R-174d/R-175): `sources?: string[]`, `missingSources?: {adapterId, reason}[]`
and `perSourceCache?: {adapterId, cache, ageMs?}[]`. `sources` names the CONTRIBUTORS — participants
whose points are actually present in `result`, rather than everyone who answered. The distinction
matters because an "answered" reading would attribute a merged payload to a participant that
returned nothing of its own. The 18 non-merge capabilities and their tools see no shape change, and
no existing field type changes. `source`'s MEANING does not change either, on a merge walk or off
one. It is, and stays, the highest-ranked adapter among those whose data is IN `result` (`sources`,
the CONTRIBUTORS above) — never simply the first to answer. Corrected here after round 2 (MJ-2):
stating only the fallback below without this primary rule reads as "unchanged" = "first answerer".
On the ordinary composition where `platform-explorer` answers `[]` and `pg-history` returns 40
points, that reading would publish `source: 'platform-explorer'` over a payload containing none of
its data — exactly the defect B-2 raised. `source` falls back to the highest-ranked ANSWERED
participant ONLY in the corner case where `sources` is empty (everyone answered with zero points, so
there is no contributor to rank).
The compiled conflict rank on a dedup collision (`(metric, asset, HOUR of ts)` — bucketed
2026-08-07 by owner decision, R-161(e); the stored point keeps its own `ts`) reuses the
route's own `adapterIds` order. It does not add a rank table, and it reads neither
`AdapterRegistration.trust` nor `onchain.metrics.source_priority` (`OQ-T013-3`; `TC-GATE-02` and
R-180 both forbid the latter two readers). This is a narrow, provisional reuse pending T-016's real
per-row trust axis, reasoned in full in [system-architecture.md](system-architecture.md).
**Enforced, not only documented:** a new construction-time assertion requires every
participant of a `merge: true` route to be `tier: 'free'` (reading `AdapterRegistration.tier`, never
`.trust`). A paid, presumably-authoritative participant would sit last in spend order and therefore
lowest in this reused rank, silently losing every dedup collision. The assertion turns that hazard
into a startup failure until T-016.
