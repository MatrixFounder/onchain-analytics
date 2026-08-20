# 5. Interfaces

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 5.1. External API — 20 MCP tools

`onchain_ping` (M0, unchanged, R-20) — §5.1.1. Four read tools arrived in M1, three paid
Nansen-backed tools in M2 (§5.1.2), two registry-backed tools with TASK-006 (§5.1.3), one free
DEX-volume tool with TASK-007 (§5.1.4), one free holders tool with TASK-008 (§5.1.4a), and one free
BTC-supply tool with TASK-009 (§5.1.5).

**Two further tools are designed and not registered.** `onchain_pool_info` resolves `pool.info`,
and its contract is §5.1.7 (T-014, R-21.1). `onchain_token_pools` resolves `token.pools`, and its
contract is §5.1.8 (T-014, R-34). Every present-tense count in this section states the registered
inventory, and none of them moves until those tools land.

**The `chain` parameter, stated once.** Seventeen of the twenty tools take a chain, and every one of them
declares `chain: ChainInputSchema` (§3.2): an open string validated against the chain registry and
resolved to the canonical slug inside the handler, before the value reaches the cache key (§4.2.2).
`ethereum` and `solana` are aliases and stay valid indefinitely. What a tool can actually serve is
**coverage** (§4.2.3), never a narrower parameter — the schema accepts the chain and the coverage
matrix refuses the pair with a message naming what IS available. The full contract — schema cost,
the two refusal shapes, backward compatibility — is in §5.1.3.

**The four M1 tools; input/output at the contract level, not literal code:**

```jsonc
// onchain_get_token — { chain: ChainInput, address: string (.max(64)) }
// → Token (§4.1) | isError: true when unavailable or the address is invalid
// Capability: token.price, not token.metadata — coingecko's normalize() yields a byte-identical
// Token on either route, but the entry is cached under the TTL of its most volatile part (60s
// price, not 3600s metadata), otherwise priceUsd could legally go stale for an hour. The
// token.metadata route stays registered for future metadata-only consumers.
// onchain_wallet_balances — { chain: ChainInput, address: string (.max(64)) }
// Capability: wallet.balances.native
// → Wallet (§4.1, balances: Balance[] — only assetType:'native' in M1)
// onchain_active_pairs — { chain: ChainInput, limit?: number }
// Capability: pairs.active
// → { chain, pairs: Pool[], source, fetchedAt }
// (the limit default is materialized BEFORE args are built: an omitted limit and an explicit
// limit:10 would otherwise derive different args hashes for one logical request, duplicating the
// upstream fetch instead of sharing one cache entry)
// onchain_protocol_tvl — { chain: ChainInput, protocolSlug: string (.max(128)) }
// Capability: protocol.tvl
// → { protocol, chain, tvlUsd, totalTvlUsd, deployed, deployments, unmappedDeployments,
//     aggregatedFrom, source, fetchedAt }
// (`tvlUsd` is nullable since L-9: 0 + deployed:false = "not on this chain", null + deployed:true =
//  "on this chain, but the vendor publishes no plain-TVL figure for it")
```

`address`/`protocolSlug` carry explicit `.max()` bounds: `address.max(64)` (a real EVM address is
≤42, a Solana base58 pubkey ≤44) plus a length guard at the top of `superRefine`, and
`protocolSlug.max(128)` as a cheap cut before the value can reach a URL or a cache key. The length
guard is not a second rejection — `.max()` has already failed the parse — it is what actually
guarantees the expensive `isValidAddress`/`bs58.decode` work is skipped for a pathologically long
input, instead of being performed and only then discarded.

`onchain_protocol_tvl`'s handler validates the provider response with `safeParse`, not `parse`: a
failure returns `{ok:false, reason}` per the contract and never throws. `defillama.normalize()`
rejects non-finite or negative `tvlUsd`/`totalTvlUsd` on its own side, before the value reaches the
cache.

Every response carries `_meta.cache: { status: 'hit'|'miss', ageMs?, provider, capability }` (§3.2)
— outside `structuredContent`, so the output schema does not grow.

`chain`+`address` inputs are validated through one shared idiom:

```ts
export const WalletBalancesInputSchema = z
  .object({
    chain: ChainInputSchema, // §3.2 — open string, resolved against the registry
    address: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.address.length > 64) return; // skip expensive isValidAddress/bs58.decode
    if (!isValidAddress(val.chain, val.address)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid address for chain ${val.chain}`,
        path: ['address'],
      });
    }
  });
```

Errors are MCP tool errors (`isError: true`), not process failures (UC-2 alt, inherited from the M0
§7.3 invariant: invalid input or an unavailable capability never crashes the server).

#### 5.1.1 `onchain_ping` (M0, unchanged)

```jsonc
// tools/call { name: "onchain_ping", arguments: {} }
// → { "ok": true, "service": "onchain-intel-mcp-server", "version": "0.1.0", "ts": 1784000000000 }
```

#### 5.1.2 The three paid, Nansen-backed tools (M2, TASK-005)

```jsonc
// onchain_smart_money_flows — { chain: ChainInput, tokenAddress: string (.max(64)) }
// → SmartMoneyFlow (§4.1) | isError: true when the key or the budget is unavailable
// Capability: smart-money.flows (costOf() = 10cr fixed — netflow 5cr + tgm/holders 5cr, R-41)
// onchain_entity_label — {
//   chain: ChainInput,
//   query?: string (.max(200)),        // by name/symbol/address, required unless tokenAddress is set
//   tokenAddress?: string (.max(64)),  // token-scoped label enrichment; required when exhaustive
//   exhaustive?: boolean (default false), // opt-in escalation — budget-gated, requires tokenAddress
// }
// → { chain, entities: EntityLabel[] (§4.1), source, fetchedAt } | isError: true
// Capability: entity.labels — costOf() has three tiers: 0cr (query-only) / 5cr (tokenAddress,
// !exhaustive) / 100cr (exhaustive:true — ONLY /profiler/address/labels, it does not duplicate the
// 5cr path)
// onchain_token_risk — { chain: ChainInput, tokenAddress: string (.max(64)) }
// → TokenRiskScore (§4.1) | isError: true
// Capability: token.risk (costOf() = 6cr fixed — tgm/indicators 5cr + tgm/token-information 1cr, R-43)
```

Coverage of the three paid capabilities is per capability and comes from the coverage matrix
(§4.2.3), not from an enum in the schema: `smart-money.flows` is served on 16 chains,
`entity.labels` on 18, `token.risk` on 18. A chain outside that set is refused before any credit is
reserved.

`tokenAddress`/`query` reuse the same `.max()` bounds and the same
`superRefine`/`isValidAddress` idiom as `onchain_get_token` above — reused, not reinvented.
`onchain_entity_label` has the only compound `superRefine` of the twenty tools: **at least one** of
`query`/`tokenAddress` is required (otherwise there is nothing to search for), and `tokenAddress`
is mandatory when `exhaustive: true`.

**`_meta.budget` — budget visibility for the caller (R-41, the analogue of `_meta.cache`):**

```ts
export interface BudgetMeta {
  provider: string; // the PAID adapter this reading belongs to (T-012 012-3 — was the literal 'nansen')
  creditsUsedToday: number; // usage.credits_used of the current day bucket, AFTER this call
}
```

It is present **exactly** when the traversal ENTERED a paid adapter — that is, when
`CapabilityResolution.attempted` contains an adapter registered `tier: 'paid'`. When it entered none,
nothing can have been spent and `_meta.budget` is **absent entirely** rather than coerced to
`0`/`null` — the same principle as `_meta.cache.ageMs` on a miss (§3.2).

The condition used to read "paid AND actually executed (`_meta.cache.status === 'miss'`)". That is
a statement about the ANSWERING adapter, and the two part company on the H-1 return (§9.1): the
registry hands back the first unsatisfying answer, which on a warm cache is a `'hit'` built for the
free source, while the walk behind it entered and paid. The `'miss'` reading then dropped
`_meta.budget` on a call that had just spent credits (T-012 adversarial cycle 3, F-A) — an
under-report, which is the expensive direction, because an agent that believes a call was free
repeats it. Cache status no longer appears in the rule; a pure hit satisfies it by entering nobody.

**`_meta.timing` — the call answered past its own ceiling (OQ-T012-6, owner decision 2026-08-05):**

```ts
export interface TimingMeta {
  overrunMs: number; // ms past the effective deadline; always > 0 when the object is present
}
```

Present **only** when a walk crossed `deadlineMs` and still returned. That happens in exactly one
branch: every source was entered, every one answered, and the last of them ran long — so nothing was
prevented and nothing was aborted, and the H-1 return (§9.1) hands back a complete answer. The owner
resolved that such an answer is returned rather than discarded; the time and, on a paid route, the
credit are already spent, and only the caller can judge whether a late-but-complete answer is still
useful.

Two consequences a client must design around:

1. **`deadlineMs` is a bound on what a call may SPEND, not a latency contract.** A response can
   arrive after it. A caller that needs a wall-clock guarantee applies its own timeout — which is
   also what ADR-003's network client will do.
2. **Late is never silent.** The absent key means "inside budget"; it is never `{overrunMs: 0}`, on
   the same principle as `_meta.cache.ageMs` on a miss.

The read does **not** go through `CapabilityRegistry.resolve()`'s return type as a CREDIT figure:
that type is shared by all twelve adapters and must not grow a budget field for the sake of one paid
provider. The three tool handlers instead read `budgetStore.getUsage(<paid id>,
dayBucketMs(Date.now()))` in a **separate** query after `registry.resolve()` has returned — purely
for display, never part of the gate decision (which has already happened inside
`nansen.fetch()`, §3.2). `BudgetStore` is injected into those three handlers the same way `registry`
is. Both degradation paths — no injected store, or a store that throws — resolve to `undefined`:
visibility must never turn an otherwise successful call into an error.

**This read names no storage engine.** `BudgetStore` has one implementation per storage axis —
`SqliteBudgetStore` or `PgBudgetStore` (`system-architecture.md` §3.4.8). Its methods already return
promises (`packages/core/src/cache/budget-store.ts:63`, `checkAndReserve(`), so the handler above is
unchanged by the axis the profile selects.

**T-014 adds a second condition and keeps this one.** `_meta.budget` reaches only a principal whose
role is `admin` (R-6.1). The rule that governs every `_meta` field, present and future, is stated
once in §5.4.4.

**Which paid id (T-012 012-3, corrected by adversarial cycle 2's F-4).** 012-3 replaced the
hardcoded `getUsage('nansen')` with a reading keyed on the ANSWERING provider
(`CapabilityResolution.source`), which under-reports on the only route where a free adapter comes
first: on `entity.labels` the walk enters and PAYS `nansen`, `nansen`'s answer is unsatisfying too,
and the registry returns `blockscout`'s — so a call that spent credits reported none. `resolve()`
therefore also returns **`attempted`**, the adapter ids whose `fetch()` the traversal actually
entered (a traversal fact, tier-free — the registry never classifies paidness), and the handlers pass
it to `budgetMeta()`, which reports the paid adapter among them. Under-reporting is the expensive
direction: an agent that believes a call was free repeats it (R-41). The WIRE shape is unchanged;
`attempted` never reaches a client. `tier` itself is NEVER added to this object, or to `_meta`
anywhere else, on any of the 20 tools (R-152) — the internal cost-tier classification is our unit
economics, not part of the client's contract (ADR-002 D8, ADR-003 D4).

#### 5.1.3 The two registry-backed tools (TASK-006) — free

```jsonc
// onchain_list_chains — discovery, ZERO network calls (R-52b)
// {
//   query?: string (.max(64)),      // substring over slug / name / aliases
//   family?: "evm"|"svm"|"move"|"cosmos"|"utxo"|"other",
//   capability?: string (.max(64)), // keep only chains where this capability is actually covered
//   minTvlUsd?: number,             // filter on tvlUsdAtRegistrySync — knowingly stale
//   limit?: number (default 50, .max(200)),
// }
// → {
//     chains: Array<{ slug, caip2, name, family, nativeSymbol,
//                     capabilities: string[],            // covered on THIS chain
//                     tvlUsdAtRegistrySync: number|null  // NOT an answer to "what is the TVL"
//                   }>,
//     total: number,            // how many matched the filter BEFORE limit was applied
//     registrySyncedAt: number, // epoch-ms UTC — when the registry was synced
//   }
// onchain_chain_tvl — TVL of a CHAIN (not a protocol), DeFiLlama-backed, keyless
// { chain: ChainInput }
// → { chain, name, tvlUsd, source: "defillama", fetchedAt }
// Capability: chain.tvl
```

Deprecated chains are absent from the listing and from every coverage answer (§4.2.3), so a row in
this payload is by construction a chain that still exists.

**Why `onchain_chain_tvl` is a separate tool and not a parameter of `onchain_protocol_tvl` (R-53b).**
A chain and a protocol are different subjects with different sources (`/v2/chains` vs
`/protocols`) and different output contracts: a protocol has `totalTvlUsd` across all chains, a
chain has no such notion. Merging them would introduce a parameter that changes the meaning of every
other field — the worst form of contract overloading. The result shape follows the `ProtocolTvlResult`
precedent: `tvlUsd: number`, with non-finite or negative values refused **before** the cache is
written (R-53c) — the same protection `defillama.normalize()` already implements.

**Why `total` and a default `limit` are mandatory (R-52c).** Without them `onchain_list_chains({})`
would dump 458 rows into the model's context — a tool created to **save** 8.7k tokens of schema
would spend more than that on its first call. `total` keeps it honest: the agent can see the list was
truncated and narrow the filter, instead of concluding there are only 50 chains.

#### 5.1.4 The DEX-volume tool (TASK-007) — free

```jsonc
// onchain_dex_volume — daily DEX volume of a CHAIN, DeFiLlama-backed, keyless, 0 credits
// { chain: ChainInput, days?: number (int, 1..1825, default 90), includeSeries?: boolean (default true) }
// → {
//     chain, name,                         // OUR slug and OUR display name, never the vendor's text
//     window: { fromMs, toMs, days },      // epoch-ms UTC, what was actually returned
//     series: Array<{ ts: number, volumeUsd: number }>,   // ts = epoch-ms UTC, daily step
//     points: number,
//     gapDays: number,                     // missing daily steps inside the window — counted, never stitched
//     totals: { h24, d7, d30, d1y, allTime },  // vendor's own aggregates, each `number | null`
//     truncated: { series: boolean, reason: string },
//     source: "defillama", fetchedAt
//   }
// Capability: dex.volume.history
//
// onchain_chain_tvl_history — how a CHAIN's TVL changed over time (WI-50), DeFiLlama, keyless
// { chain: ChainInput, days?: 1..1825 (default 90) }
// → {
//     chain, name,
//     window: { fromMs, toMs, days },   // the window ACTUALLY covered, clamped to real history
//     series: Array<{ ts, tvlUsd }>,    // day-bucketed, strictly increasing, never stitched
//     points, gapDays,                  // points + gapDays === window.days, always
//     change: { fromTs, toTs, fromUsd, toUsd, absUsd, pct } | null,  // pct null on a zero base
//     truncated: { series: boolean, reason: string },
//     source: "defillama", fetchedAt
//   }
// Capability: chain.tvl.history
//
// onchain_list_protocols — the protocol POPULATION on a chain, ranked (WI-49), keyless
// { chain: ChainInput, limit?: 1..200 (default 20),
//   sortedBy?: "tvl" | "change1d" | "change7d" | "change30d", minTvlUsd?: number }
// → {
//     chain, name,
//     protocols: Array<{ slug, name, category, tvlUsd, totalTvlUsd,
//                        change: { d1, d7, d30 },   // percent; null where the vendor publishes none
//                        parent }>,                 // the family, e.g. "uniswap" for "uniswap-v3"
//     matched,   // how many matched BEFORE limit — a truncated list looks truncated
//     limit, sortedBy, source: "defillama", fetchedAt
//   }
// Capability: protocol.list
//
// onchain_protocol_tvl_history — ONE protocol's TVL on ONE chain over time (WI-50), keyless
// { chain: ChainInput, protocolSlug: string (.max(128)), days?: 1..1825 (default 90) }
// → { protocol, chain, deployed, window, series, points, gapDays, change, truncated,
//     source: "defillama", fetchedAt }   // deployed:false ⇒ empty series and window.days 0
// Capability: protocol.tvl.history
//
// onchain_gas_price — what one gas unit costs on an EVM chain (WI-51)
// { chain: ChainInput }
// → {
//     chain,
//     gasPriceWei,      // exact decimal string — non-null ONLY from a node (source "rpc-evm")
//     gasPriceGwei,     // lossy projection; derived from wei on the node path, the vendor's
//                       // "average" tier on the indexer path. null ⇒ no price published, NOT free
//     tiers: { slowGwei, averageGwei, fastGwei } | null,   // null on the node path — one price
//     nativeSymbol,     // read it before comparing chains: POL Gwei != ETH Gwei
//     measuredAt,       // the SOURCE's own stamp, epoch-ms; null from a node
//     source, fetchedAt
//   }
// Capability: gas.price
//
// onchain_chain_transactions — how much a chain is used (WI-51), Blockscout
// { chain: ChainInput }
// → { chain, transactionsPerDay,   // the vendor's DAILY aggregate — do NOT difference two reads
//     totalTransactions, totalBlocks, averageBlockTimeMs, networkUtilizationPct,
//     source, fetchedAt }
// Capability: chain.transactions
// NOT SERVED: active addresses. No wired provider publishes an activity-scoped address count;
// the cumulative-since-genesis one that exists is a different statistic (WI-51's named residual).
//
// onchain_protocol_incidents — recorded security incidents for one protocol (WI-52), DeFiLlama
// { protocolSlug: string }
// → { protocol, resolved,           // resolved:false = the slug is UNKNOWN, not "none found"
//     incidents: [{ ts, name, amountUsd, classification, technique, targetType,
//                   chains, bridgeHack, returnedFundsUsd,
//                   matchedBy }],   // 'protocol' | 'parent' — a sibling exploit is a different claim
//     totalAmountUsd,               // null, never 0, when no record stated an amount
//     feedThroughTs,                // the feed's OWN newest record — how current an empty list is
//     feedRecords, unattributedRecords,  // incidents naming no protocol at all (CEX/bridge/person)
//     source, fetchedAt }
// Capability: protocol.incidents
// EDITORIAL, NOT ON-CHAIN: written up after the fact, so it carries its own age rather than
// inheriting the freshness of a TVL number beside it (WI-52's provenance requirement).
// NOT SERVED: developer activity (repositories, commits) and funding (investors, rounds) — the
// other two thirds of WI-52, which need a provider class this engine has not wired.
```

**Why the vendor's aggregates are passed through instead of recomputed (R-67, OQ-1).** `total24h`
and friends are already in the document at no extra cost, and recomputing them from the series would
mean quietly disagreeing with the vendor on rounding and on which protocols are double-counted — the
vendor already excludes 54 aggregator protocols from its own total. They are `number | null`, never
`0`-for-missing: a chain outside the vendor's active set answers HTTP 200 with `change_1d: null` and
a **narrower key set** (measured on `litecoin`, 2026-07-27), and — measured on a chain this
capability actually covers — `doge` answers HTTP 200 with `total24h: null` (274-chain echo probe,
2026-07-28). A missing key rendered as `0` would be a fabricated number rather than an absent one.

**Why gaps are counted rather than stitched (R-67c, OQ-5).** A missing day inside the covered window
is reported as `gapDays`, and the series simply lacks that point. Interpolating would produce a
number no one measured; dropping the count would make an incomplete answer indistinguishable from a
complete one. The DoD this tool was built against is itself a gap measurement — a quarter over ten
chains must return 92 points per chain with `gapDays === 0`.

**`gapDays` is measured against the WINDOW, not against the returned series** (adversarial cycle 3,
logic L-1). Deriving the expected count from the first and last returned points makes any gap at the
window's _leading_ edge arithmetically unreachable — and a chain younger than the window then reports
"five years, nothing missing". Two cases that look identical in the data are separated by asking
whether the vendor has any point _before_ the window: if it does, the window lies inside the chain's
lifetime and a missing first day is a real gap; if it does not, the history simply starts later and
`window.days` shrinks to the range actually covered. The invariant a caller can check is
`points + gapDays === window.days`.

**Points are day-bucketed and unique per day** (cycle 3, logic L-2/L-4). The window anchor is floored
to a day boundary, so the points must be too — otherwise a vendor that stops publishing exactly at
midnight drops the very point that defined the window, and `days: 1` returns an empty series. Two
points landing in one day are folded (last wins) and the fold raises `truncated.series` with a reason,
because silently collapsing them let a duplicate mask exactly one genuine missing day.

**Why `truncated` is not set by ordinary windowing (R-67d).** Slicing a 2825-point series down to the
requested 90 days is the tool doing its job, not a truncation. `truncated.series` is set only when a
hard cap was hit — the request asked for more points than the transport or the point cap will carry —
so the flag keeps meaning "you did not get what you asked for" instead of degrading into decoration.

#### 5.1.4a The token-holders tool (TASK-008) — free

```jsonc
// onchain_token_holders — top holders of a token and their exact balances, Blockscout-backed, keyless
// { chain: ChainInput, tokenAddress: string (.max(64)) }
// → { chain, tokenAddress, holders: TokenHolder[] (.max(200)), truncated, droppedRows,
//     source, fetchedAt }
// Capability: token.holders
```

**`truncated` and `droppedRows` are the contract, not decoration.** The first says the list is not
the complete tail — either the vendor paged, or rows were dropped; the second counts rows the
adapter refused to publish (a malformed balance, a `value_truncated` marker). "50 holders" and "the
first 50 of many" are different answers to a concentration question, and a hole in the middle is a
different defect from a cut at the end — which is why the two are separate fields and not one flag.

`holders[].amountRaw` is an exact decimal string in base units, bounded to 78 digits (the width of
2^256−1). It is never parsed into a number: token balances routinely exceed what a JSON number
holds without losing digits, and losing them silently is worse than refusing.

#### 5.1.5 The BTC-supply tool and the eval's reference axis (TASK-009) — free

```jsonc
// onchain_chain_supply — how much of a chain's native asset exists. Keyless, 0 credits.
// { chain: ChainInput }                     // covered on `bitcoin` only
// → {
//     chain, symbol, decimals,              // decimals = 8, a CONSENSUS constant (the registry's
//                                           // nativeDecimals for bitcoin is null)
//     emissionRaw: string,                  // satoshi — what the halving schedule has released
//     emissionBtc: number,                  //   lossy projection, for charts/comparison only
//     circulatingRaw: string,               // satoshi — what miners actually claimed
//     circulatingBtc: number,
//     blockCount: number,                   // the height the emission figure is consistent with
//     source: "blockchain-info", fetchedAt
//   }
// Capability: chain.supply
```

**Two supply numbers, because there are two facts.** `emission` and `circulating` differ by the
coinbase subsidy miners never claimed (~29–32 BTC, 0.00016%). Serving either one under the other's
name would be a fabrication invisible to any reader. §3.2 records the measurement that separates
them, including the test that settles it: the formula-derived figure sits at an INTEGER number of
subsidies past the halving boundary, the claimed one at a fractional one.

**🔴 The cross-check compares HEIGHTS, not supply (R-89).** Re-deriving `emission` from the halving
schedule can never contradict the vendor, because the vendor derives it the same way — measured
bit-exact at both probed heights. The one thing an independent source can genuinely refute is the
**block height**, which the deterministic formula then propagates into supply. So the eval fetches
`mempool.space`'s tip height as a second, unrelated vendor and grades the difference **in blocks of
subsidy** — never in percent, where one block is 0.000016% and a full day of vendor staleness still
rounds to zero.

**`mempool.space` is deliberately NOT an adapter.** It is the reference, and a source the engine
answers from cannot be the independent check on that answer. The vendor's wider surface (hashrate,
difficulty adjustment, recommended fees, mining pools) has no consumer today, and a capability with
no consumer is the "advertised everywhere, served nowhere" defect TASK-008 spent a task removing.

**The reference source is DATA (R-88).** `eval/probes.json` gains a `referenceSources` block — url,
how to read the body, why this source, when it was last verified — and `eval/run.mjs` learns to
fetch such a source **once, generically**. Adding the next one is a config edit. Two rules keep the
axis honest, both inherited from the eval's existing doctrine: only `https`, with the host living in
the reviewed data file rather than being computed at run time; and a reference source that fails to
answer yields `no-probe`, **never** a provider failure — an eval that scores its own missing test
data as a vendor defect is lying, and a report that cries wolf stops being read.

**The `chain` parameter contract (R-50), shared by all seventeen chain-taking tools** — eleven at
TASK-006, re-measured 2026-08-13: of the 20 tool modules under `packages/mcp-server/src/tools/`,
17 import `ChainInputSchema` (the directory holds 26 files; 6 are shared helpers, not tools)**:**

```ts
// One shared import; zero chain literals anywhere in mcp-server:
chain: ChainInputSchema, // §3.2 — accepts slug | alias | caip2, resolves to the canonical slug
```

- **Schema cost:** ~5 tokens per parameter instead of ~1249. Across the seven tools that carried the
  closed enum, 458 chains would have cost **≈8.7k tokens in every single request to the model**
  (measured, TASK §0). That is the reason for the owner's decision of 2026-07-26, not aesthetics. The
  correctness the enum bought is not lost, only moved into the runtime resolve — which fails with a
  "did you mean" list, zero network calls and zero credits, because a mistyped chain name is the
  most common way an agent misses on a paid route.
- **Validation here, canonicalization in the handler, deliberately not a `.transform()`.** The MCP
  SDK renders every tool input schema to JSON Schema for `tools/list`, and a zod transform has no
  JSON Schema representation — the SDK would answer `tools/list` with
  `-32603 Transforms cannot be represented in JSON Schema`, taking down tool discovery, i.e. the
  whole server. So the schema only validates, and `canonicalizeChain()` resolves one line into the
  handler, still well ahead of `deriveArgsHash`.
- **Unknown chain (R-50c)** — a tool error, zero network calls, zero credits:

  ```
  unknown chain 'beara'. Did you mean: berachain? Call onchain_list_chains to browse 458 chains.
  ```

  The echoed input is truncated: this message travels back into the model's context, so reflecting
  an arbitrarily long argument verbatim would hand a caller a way to put a megabyte of its own text
  there.

- **Uncovered pair (R-51c)** — a distinct type, never merged with "provider unavailable":

  ```
  capability 'smart-money.flows' is not available on chain 'berachain'.
  Available on: arbitrum, avalanche, base, bnb, ethereum, … (+11 more).
  Available on 'berachain' instead: chain.tvl, token.price, token.metadata, pairs.active.
  ```

  Both lists are computed from the coverage matrix (§4.2.3), so they cannot drift from actual
  behavior, and both are capped at ten entries plus an honest `+N more` — an error meant to save the
  caller a wasted call must not itself dump 458 slugs into the context. When the "available instead"
  list was not computed, it renders nothing: an empty list would read as "nothing works here", which
  is a false statement that talks an agent out of calls that would have succeeded.

**Backward compatibility (R-59).** `"ethereum"` and `"solana"` remain valid **indefinitely** — as
aliases, not as a transitional mode. Response shapes do not change: tools still answer
`chain: "ethereum"`, the canonical slug. Cache entries were not invalidated (§4.2.2).

#### 5.1.6 The Dash Platform history tool (T-013) — BUILT and registered (013-7 / 013-8, 2026-08-09)

**Owner decision `OQ-T013-1` (2026-08-05): merging is ON for both eligible capabilities, and the
tool's answer groups by `metric`, never a flat point array.** Modelled on `onchain_dex_volume`
(§5.1.4) for the input/window idiom, but the OUTPUT shape is grouped, not flat, because the merged
`series` can legitimately carry more than one metric under one capability name (§4.2.3-adjacent
finding, `docs/tasks/task-013-series-merge-and-history-tool.md` §1.3): `privacy.shielded_pool.history`'s two adapters write two DIFFERENT
metrics (`platform-explorer` → `shielded_pool_shield_amount`, an inflow; `pg-history` → the n8n
snapshotter's `shielded_pool_balance_credits`, a balance) under the same capability name, so a flat
array would silently read as one series when it is two. `platform.metrics.history` is the case the
merge mechanism was built for: `identities_total` is genuinely the same series from both adapters
(conflict resolved by the compiled rank, system-architecture.md "Merge mechanism"), and
`documents_total`/`data_contracts_total`/`platform_total_credits` exist ONLY on `pg-history` — the
gap-filling D6 reason 3 names directly.

```jsonc
// onchain_dash_platform_history — merged history of a Dash-Platform-only capability pair.
// One call resolves ONE of the two capabilities below, chosen by `series` — never both (R-170a).
// { chain: ChainInput, series: 'shielded_pool' | 'platform_metrics',
//   limit?: number (int, 1..500, default 100 — matches pg-history's own DEFAULT_HISTORY_LIMIT) }
// → {
//     chain,
//     series: 'shielded_pool' | 'platform_metrics',        // echoes the input selector
//     groups: Array<{
//       metric: string,                                    // the Snapshot's own metric id, never renamed
//       points: Array<{ ts: number, asset: string, valueRaw: string, valueNum?: number, source: string }>,
//     }>,
//     truncated: { series: boolean, reason: string },       // M-4 — see below; modelled on
//       // dex-volume.ts's exact shape, not decorative
//     missingSources?: Array<{ adapterId: string, reason: string }>,  // R-171e — forwarded from
//       // `resolution.missingSources` VERBATIM, under the same field name — the ONLY carrier of
//       // "a participant did not contribute" this tool's output has; never folded into `window`.
//     window?: { fromMs: number, toMs: number, days: number },  // best-effort (R-171f) — the two
//       // participants' windows genuinely differ (pg-history's shared LIMIT 100 across four metrics
//       // vs. platform-explorer's own endpoint window) and reconciling them into one honest
//       // `{fromMs,toMs,days}` is explicitly NOT required for acceptance
//     source: string, fetchedAt: number,
//   }
// Serves BOTH capabilities below — one anchor each, bare, within the 25-line attribution window.
// Capability: privacy.shielded_pool.history
// Capability: platform.metrics.history
```

- `groups[].points` is a direct projection of the merged `Snapshot[]` the registry returns — `valueRaw`
  stays a string (DB-SCHEMA §1.7; never parsed to `Number`, R-167d), and grouping by `metric` (R-171b)
  is what keeps `shielded_pool_shield_amount` and `shielded_pool_balance_credits` visibly two
  different quantities instead of one misleadingly-continuous series (AC-32, AC-49).
- `series:'shielded_pool'` always answers with exactly the metric groups actually present (one or
  two, never a synthetic empty group for a metric neither adapter wrote this call);
  `series:'platform_metrics'` can carry up to four groups, three of which exist only when
  `ONCHAIN_PG_URL` is configured and `pg-history` answered (AC-43, AC-49).
- 🔴 **`limit` bounds the TOOL's output, never the underlying fetch (M-4, corrected round 2 —
  MJ-3).** `pg-history`'s own query is not rewritten by this task (R-180c) — it always applies its
  OWN hardcoded `DEFAULT_HISTORY_LIMIT = 100`, `ORDER BY ts DESC` (`packages/core/src/adapters/pg-history/index.ts:37`, `const DEFAULT_HISTORY_LIMIT = 100;`,
  `:142-145`), and it is the SAME query, same cap, for **both** capabilities — not only
  `platform_metrics` (where the 100 rows are additionally shared across four metrics). A first
  draft scoped the always-on disclosure to `platform_metrics` alone, which left
  `series:'shielded_pool'` with `limit: 300` returning a pg-capped 100-point group and
  `truncated.series === false` — a source-truncated answer reported as complete, because no
  TOOL-side slicing ever ran to trigger clause (1) below. `limit` therefore does two things, both
  named, both selector-independent: (1) it slices each group in `groups[]` down to its `limit`
  most-recent points (newest first, mirroring `pg-history`'s own ordering) — `truncated.series:
true` when that slicing actually cut a group; (2) `truncated.series` is ALSO `true`,
  unconditionally, whenever `pg-history` is among the contributors AND the requested `limit`
  EXCEEDS its own 100-row cap — on EITHER selector, not only `platform_metrics` — a coarse, honest,
  always-on signal for a cap the tool cannot measure precisely (matching the `_meta.cache`
  aggregate's same "coarse but true" discipline, system-architecture.md "Merge mechanism"). The
  ceiling stays 500, not 100: `platform-explorer` alone (no `ONCHAIN_PG_URL`, R-164(b)'s UC-12) is
  not bound by `pg-history`'s cap, and lowering the tool's own ceiling to 100 would needlessly
  starve that composition too. **`truncated.reason` (MN-4): when only clause (2) fires, it names
  the source-side cap ("pg-history's own query returns at most 100 rows … request narrowed to that
  many" — for `platform_metrics`, additionally naming that the 100 rows are shared across four
  metrics); when clause (1) also fires (the tool's own slicing cut a group), the reason states BOTH
  facts in one sentence rather than picking one — a caller seeing only the source-side sentence
  when its own `limit` was smaller than 100 would wrongly conclude pg-history, not its own request,
  is why the group is short.
- The handler calls `resolveCapability()` (§5.2, extended additively — `sources`/`missingSources`/
  `perSourceCache` are new optional fields on `ResolveSuccess`, R-175b) and reads `outcome.missingSources`
  to populate the field above; it does not reimplement `CapabilityUnavailableError`/
  `CapabilityDeadlineExceededError` translation — that stays the ONE place it already lives.
- 🔴 **`_meta.cache` is this tool's OWN shape, not the shared `CacheMeta` (M-5 — naming the reader
  `sources`/`perSourceCache` otherwise reach and stop at).** `{ status: 'hit' | 'miss', perSource:
Array<{ adapterId: string, status: 'hit' | 'miss', ageMs?: number }> }`, built directly from
  `outcome.sources`/`outcome.perSourceCache` — the one case R-174(e) names as legal ("a new tool
  builds its own `_meta`, not reusing `resolveCapability()`'s shape literally"). The 11 existing
  tools' `_meta.cache` is untouched (R-175). **Diverges from `CacheMeta` in both directions, named
  (MN-3):** `provider` is DROPPED — genuinely ambiguous for a merge (`perSource[]` already answers
  "which adapter, which status" per contributor, and a single `provider` string would just be
  `source` repeated under a worse name); `capability` is ALSO dropped, but for the opposite reason —
  it is NOT ambiguous (one call resolves exactly one of the two, R-170a), so it is redundant with
  the top-level `series`/output `Capability:` pairing rather than informative, and omitting it is a
  choice, not an oversight this bullet leaves unstated.
- _Narrowed by T-013 013-3 (2026-08-06)._ "which adapter, which status" per contributor, above, is
  the pre-013-3 reading; `perSourceCache` (and this bullet's own `perSource[]`, built directly from
  it) instead covers every participant that ANSWERED, R-174(c) — full argument in
  `docs/architectures/open-questions.md` "T-013 task 013-3".
- `capability` on this tool's `ToolSpec` stays `string | null`, UNCHANGED — set to `null`, same value
  `ping`/`list-chains` already use, but a DIFFERENT fact (system-architecture.md, "Decision:
  `capability` is UNCHANGED"). A new, additive field, `servedCapabilities: ['privacy.shielded_pool.history',
'platform.metrics.history']`, is what R-170(b)'s "both capabilities listed, not null" actually
  reaches — the eval axis and the doc-pairing gate are updated to read it (system-architecture.md
  enumerates the three readers that need an actual behaviour change).
- ✅ **The two `// Capability:` anchors are PRESENT since 013-8** — bare, one per capability, both
  inside the block above and therefore within the attribution window. What follows is the design
  note that governed their absence until the `ToolSpec` existed; it is kept because it records two
  wrong shapes that were tried, and both remain wrong today.
- 🔴 **(Historical, until 013-8.) The `// Capability:` anchor is deliberately ABSENT here, corrected after round 2 (BL-1).**
  Round 1 tried a quoted/conjoined anchor and round 2's fix tried TWO bare ones — both wrong in
  opposite directions: quoted defeats the gate's regex (`/^\/\/ Capability: ([a-z][a-z0-9._-]*)/`)
  SILENTLY (documents nothing, gate stays green), while two bare anchors both attribute to
  `onchain_dash_platform_history` and inflate `documented.size` to 12 against
  `withCapability.length === 11` (13 tools minus 2 `capability: null`) — `docs-counts.test.ts`'s
  R-119 pairing gate fails on a tree where the 14th tool is not even registered yet, and would fail
  differently at its `stale` check (`:318`, not `orphanAnchors`) the moment the count was patched:
  no tool exists for a `served` capability to compare against. **The anchors land in the SAME
  commit that registers the `ToolSpec`** (Development, two bare lines then, one per capability,
  each within the 25-line attribution window) — until then this block carries none, and
  `docs-counts.test.ts` needs no rework: both its checks already tolerate an undocumented capability
  that no tool serves yet. When that commit lands, the gate's `documented` map becomes
  `Map<string, string[]>` so one tool name can attribute more than one anchor, and its equality
  check compares that list, as a set, against `spec.servedCapabilities`.
- `.strict()` on both schemas, the same discipline as the 13 shipped tools (R-171c). Both real
  merge routes carry no `policy` (`{kind:'any'}`), so `missingSources` in practice is populated only
  by UC-12/UC-19/UC-21's compositions (a genuinely unreachable `pg-history`), never by a policy
  exclusion — R-171(e)'s field exists for both causes, but only one is reachable in shipped scope.

**The counts inside §5.1.6 describe the tree T-013 was built on, not today's** (R-23.6). They name
13 tools and 11 capability-bearing ones. Measured 2026-08-12: `toolSpecs` holds 20 entries and
`Object.keys(capabilityManifests)` returns 26. The historical text stands unchanged; the current
numbers stand beside it.

#### 5.1.7 The pool tool (T-014, R-21.1) — DESIGNED, not registered

`onchain_pool_info` takes one pool address and one chain. It answers with the addresses of the two
tokens in that pool and the pool's reserves. It also answers with the pool's fee tier wherever that
tier is derivable, under the rule stated below.

**The gate this section satisfies is AC-29** — no manifest capability is left unresolved by every
registered tool. Its comparison is stated below, under "AC-29's gate".

**Why this tool exists.** `pool.info` is declared in the manifest and no registered tool resolves it
(L-15, `docs/issues/l-15-pool-info-is-advertised-by-the-capability-manifest-and-no-tool-serves-it.md`).
Owner decision `OQ-T014-F` selects variant 1: ship the tool.

**The capability and its route both exist already, verified 2026-08-13.** The manifest declares the
row (`packages/core/src/capability-manifest.ts:291`, `'pool.info': {`) and the routing table sends it
to one adapter (`packages/core/src/providers.config.ts:33`,
`{ capability: 'pool.info', adapterIds: ['dexscreener'] },`). The adapter declares it too
(`packages/core/src/adapters/dexscreener/index.ts:155`,
`capabilities: () => [{ id: 'pairs.active' }, { id: 'pool.info' }],`). This task adds a tool over an
existing route, not a route.

**Why the token ADDRESSES are the point.** WI-56's first link is symbol → contract address, and no
registered tool serves it. `onchain_active_pairs` returns `pairAddress` and both token SYMBOLS,
never a token address (`packages/core/src/types/pool.ts:15`,
`baseTokenSymbol: z.string().max(64),`).

```jsonc
// onchain_pool_info — ONE pool, by address: its two token addresses, its reserves, and its fee
// tier where derivable. DexScreener-backed, keyless, 0 credits. DESIGNED, not registered.
// { chain: ChainInput, pairAddress: string (.max(64)) }
// → {
//     chain,              // OUR canonical slug, never the vendor's chainId
//     resolved: boolean,  // false = this vendor knows no pool at that address on that chain
//     pool: Pool | null,  // null exactly when resolved is false
//     source: "dexscreener", fetchedAt
//   }
// The answer is the canonical `Pool` (§4.1), which T-014 grows by six OPTIONAL fields:
//   baseTokenAddress, quoteTokenAddress   // what WI-56 needs
//   reserveBase, reserveQuote             // token units, lossy — see below
//   feeTierBps                            // derived by eth_call; absent where not derivable
//   versionLabel                          // the vendor's "v2" | "v3" | "v4" | "CLMM" — NOT a fee
```

**The block above carries no capability anchor.** The anchor's gate refuses one naming a capability
that no registered tool serves (`packages/mcp-server/test/docs-counts.test.ts:485`,
`const stale = [...documented.values()]`). The anchor lands in the commit that registers the
`ToolSpec` — the rule §5.1.6 states for the merged-series tool.

**Naming the tool here obliges one companion edit.** `PLANNED_TOOL_NAMES`
(`packages/mcp-server/test/tool-inventory-docs.test.ts:141`,
`const PLANNED_TOOL_NAMES = new Map([`) must gain `onchain_pool_info` with the milestone that adds
it. Measured 2026-08-13: without that entry the R-126 gate reports this document as naming a tool
that does not exist. The entry leaves the map in the commit that registers the `ToolSpec` — the rule
its T-013 entry already states.

**Input validation reuses the shipped idiom.** `chain: ChainInputSchema`,
`pairAddress: z.string().min(1).max(64)`, `.strict()`, and `isValidAddress` inside `superRefine` —
the shape `WalletBalancesInputSchema` already carries above.

**What the vendor publishes, measured 2026-08-13.** Probe:
`GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairAddress}`, keyless, HTTP 200.

- On the L-15 pool `0x2608B7c8Eb17e22CB95b7cD6f872993cf33a4CA1` (`berachain`) the response named
  `baseToken.address` `0xD2C41BF4033A83C0FC3A7F58a392Bf37d6dCDb58` (osBGT) and `quoteToken.address`
  `0x118D2cEeE9785eaf70C15Cd74CD84c9f8c3EeC9a` (sWBERA).
- Reserves arrive as `liquidity.base` and `liquidity.quote`, beside `liquidity.usd`.
- The body carries no fee field. Its 16 keys: `chainId`, `dexId`, `url`, `pairAddress`, `labels`,
  `baseToken`, `quoteToken`, `priceNative`, `priceUsd`, `txns`, `volume`, `priceChange`,
  `liquidity`, `fdv`, `marketCap`, `pairCreatedAt`.
- A 17th key, `info`, is optional and absent from that pool. It carries images and social links, and
  it appears on 12 of the 60 rows of the two search fixtures.
- An address with no pool on that chain answers HTTP 200 with `"pairs":null`.
- An unknown chain segment answers HTTP 400 with an HTML body.

**The unknown-pool case is carried by `resolved: false`, and `pool` is `null` there.**

**Why.** The vendor answers HTTP 200 with `pairs: null` ⇒ an empty `Pool` rendered as success would
read as a pool holding no tokens and no liquidity, which is the L-10 failure class.

**Reserves are lossy, and the contract says so.** `liquidity.base` and `liquidity.quote` are JSON
numbers the vendor has already rounded. `reserveBase`/`reserveQuote` are `number | null` and play
the projection role `emissionBtc` plays beside `emissionRaw` (§5.1.5). An exact base-unit reading
needs an on-chain call, which this tool does not make.

**The fee tier is an OPTIONAL field with a declared derivation.** Owner decision, 2026-08-13,
closing `OQ-T014-IF-3`. The rule: `feeTierBps` is populated where the derivation answers, absent
where it does not, and never guessed.

**The vendor publishes no fee.** Measured 2026-08-13: no fee field in the single-pool response
above, and none in the repo's own search fixtures — 60 rows across
`packages/core/test/fixtures/dexscreener/ethereum.json` and `solana.json`. `labels` carries the AMM
version, not a fee.

**The derivation is one `eth_call` of `fee()`, selector `0xddca3f43`.** Measured 2026-08-13 on three
Kodiak V3 pools on `berachain`: 3000, 3000 and 500 — 0.3%, 0.3% and 0.05%.

**A pool without that method answers with a typed refusal.**
`0xEc5853504219Ef7754bf3d828A5fC92EAB883B08` (beraswap, V2-style) answered `execution reverted`,
measured the same day.

**Why.** A revert is distinguishable from a returned tier ⇒ "this pool declares no fee tier" never
reaches the caller as a number.

**The derivation costs two things, both named.**

1. `eth_call` becomes a third method on `rpc-evm`. The adapter calls `eth_gasPrice`
   (`packages/core/src/adapters/rpc-evm/index.ts:294`, `method: 'eth_gasPrice',`) and
   `eth_getBalance` (`packages/core/src/adapters/rpc-evm/index.ts:298`,
   `method: 'eth_getBalance',`) today, and no third method.
2. The chain needs a curated `rpcHosts` entry. That column is populated only through human review
   and a commit (`docs/architectures/security.md` §7.2.1 rule 1, R-56a).

**Where the field is absent, per chain of the tool's three.**

- `berachain` — absent. The chain carries no curated host
  (`packages/core/src/chain/registry.data.json:5433`, `"rpcHosts": null,`), measured 2026-08-13.
- `solana` — absent. `pool.info` is declared there, and `fee()` is an EVM ABI method: the chain's
  family is `svm` (`packages/core/src/chain/registry.data.json:9596`, `"family": "svm",`).
- `ethereum` — populated where the pool declares `fee()`. The chain carries two curated hosts
  (`packages/core/src/chain/registry.data.json:22`, `"rpcHosts": [`).

**R-21.1's fee-tier clause is satisfied by the derivation, not by the optional marker.**

**Why.** An optional field with no declared derivation is absent on every route ⇒ the clause would
pass with nothing measured, which is the L-10 failure class.

**What the adapter does not produce today.** Five changes, each with the coordinate that must move.

1. `fetch` ignores which capability it serves (`packages/core/src/adapters/dexscreener/index.ts:158`,
   `_cap: string,`). It gains a branch for `pool.info`.
2. The only URL it builds is the relevance search
   (`packages/core/src/adapters/dexscreener/index.ts:165`, `/latest/dex/search?q=`). The `pool.info`
   branch builds the single-pool path instead.
3. `extractFetchArgs` reads `chain` and `limit`, and no address
   (`packages/core/src/adapters/dexscreener/index.ts:114`, `function extractFetchArgs(`). Unbranched,
   a call carrying `pairAddress` answers with a relevance page.
4. The DTO projects neither token addresses nor per-side liquidity
   (`packages/core/src/adapters/dexscreener/index.ts:79`, `baseToken?: { symbol?: unknown };`).
5. `PoolSchema` is `.strict()` and declares none of the six fields
   (`packages/core/src/types/pool.ts:8`, `export const PoolSchema = z`).

**The SSRF allowlist needs no edit.** The new path is on the host the row already declares
(`packages/core/src/providers.config.ts:224`, `hosts: ['api.dexscreener.com'],`), and `safeFetch`
checks the host, not the path (§5.3).

**The fee derivation adds no host either.** Its `eth_call` goes to the requested chain's own
`rpcHosts`, which `rpc-evm` already reaches for its two present methods.

**The vendor sends the addresses on the search route too.** Measured on the repo's fixtures:
`baseToken.address` and `quoteToken.address` are present on 60 of 60 rows. The adapter therefore
projects the new fields on both of its routes, and `onchain_active_pairs` starts answering with
token addresses — WI-56's first link, at no extra call.

**`shape` moves with the route.** The manifest classifies `pool.info` as `shape: 'set'` because both
capabilities share one `normalize()` (`packages/core/src/capability-manifest.ts:291`,
`'pool.info': {`). The address route answers with one pool, so the row becomes `shape: 'point'` and
its AUDIT comment is rewritten rather than left contradicting the code. The registry treats `point`
as unmergeable (`packages/core/src/adapters/registry.ts:582`, `manifest.shape !== 'point' &&`).

**Coverage is 49 chains, and the coverage matrix is what says so.** `dexscreener` answers only where
the registry holds a WITNESSED vendor chain id. Measured 2026-08-20 by
`packages/core/scripts/gen-dexscreener-chains.ts` over all 458 rows: 65 chains are routable at the
vendor and 49 of them additionally echoed their own identifier, which is what a value in the column
requires. Any other chain is refused by §4.2.3's uncovered-pair message, never by the input schema.

**The other 16 routable chains hold `null`, and the refusal says why.** A `200` is returned both by a
segment holding data and by one holding none, so routability alone would read an empty answer as
coverage (L-10). Those rows are `unverified` — "no confirmed vendor identifier" — never "the vendor
does not serve this chain", which is the false sentence L-18 was filed for. Task 014-32a, R-33.5.

**The number 3 that stood here was the previous instrument, not a smaller measurement.** It came from
a single spot-check that witnessed `ethereum`, `berachain` and `solana`; the remaining 455 rows were
`null`, and the runtime read that `null` as a vendor exclusion for 62 chains the vendor serves.

**Cache and deadline come from the existing manifest row, unchanged.**
`packages/core/src/capability-manifest.ts:299` (`ttlSeconds: 300,`) and `:303`
(`deadlineMs: 15_000,`). Token addresses do not move; the 300 s window bounds the reserve figures
beside them.

**The registering commit changes the frozen `tools/list` snapshot (AC-2, second arm).** Two entries
move: the new tool is appended, and `onchain_active_pairs`'s `outputSchema` gains the six optional
fields, because it embeds the same type (`packages/mcp-server/src/tools/active-pairs.ts:62`,
`pairs: z.array(PoolSchema),`). All six fields are optional, and no existing field changes meaning.

**Why the commit message must state it.** AC-2 accepts a snapshot edit only when the commit carries
its justification ⇒ a regenerated snapshot with no stated reason is indistinguishable from RISK-3's
unannounced per-principal tool filtering.

**The rest of the registering commit is already enumerated in code.** `INVENTORY_CHANNELS`
(`packages/mcp-server/test/inventory-channels.ts:36`,
`export const INVENTORY_CHANNELS: readonly InventoryChannel[] = [`) lists eight gates a new tool
must satisfy, measured rather than recalled.

- the frozen snapshot
- the generated tool inventory
- the seven documents that must name the tool
- the capability anchor, plus every present-tense count
- the eval case
- the `ToolSpec` capability field
- the eval capability map
- the post-build smoke check

**AC-29's gate — what it compares.** Input: the keys of `capabilityManifests` and the union of
`capability` and `servedCapabilities` over `toolSpecs`. Postcondition: every manifest key is served
by a registered tool, or named in a declared list with a reason. Both inputs are modules of this
repository, so the gate needs no network and runs in the existing `pnpm test` step.

**Seven manifest keys are served by no tool today** (measured 2026-08-13, 26 keys against 20 tools):
`pool.info`, `token.metadata`, `privacy.shielded_pool`, `platform.identities`, `platform.documents`,
`platform.contracts`, `platform.credits`.

R-21.1 removes one of the seven. R-21.3 covers the other six: each gets a tool or a declared row
before the gate can pass.

**Why a declared list rather than a smaller manifest.** `token.metadata` is deliberately routed for
a future metadata-only consumer (§5.1) ⇒ deleting the row would lose a decision, while an
undeclared gap is indistinguishable from an oversight.

**The declaration mechanism already exists and covers two of the seven.**
`packages/mcp-server/eval/capabilities.mjs:85` (`export const CAPABILITY_KNOWN_GAPS = new Map([`)
names `token.metadata` and `pool.info` with a reason each. The gate reads that map rather than
opening a second list.

**The registering commit deletes the `pool.info` row of that map.** Its reason reads
`declared by the registry, served by no MCP tool at all`, and a registered tool falsifies it.

**The replacement is a case file, not an edit to a list.** The capability axis is derived from
`packages/mcp-server/eval/cases/` (`packages/mcp-server/eval/capabilities.mjs:69`,
`export const CAPABILITY_TOOLS = CAPABILITY_CASES.map((c) => ({`), so the eval obligation is one new
file under that directory (RF-5).

#### 5.1.8 The token-pools tool (T-014, R-34) — DESIGNED, not registered

`onchain_token_pools` takes one token address and an optional chain. It answers with the pools that
token trades in — across every DEX on that chain, or across chains when no chain is given.

**Why this tool exists beside §5.1.7.** `onchain_pool_info` answers by pool address. That is
identification. One token trades in several pools, on several DEXes and on several chains, and
asking for those is discovery. The two questions have different vendor routes and different
completeness guarantees, so they are two capabilities rather than two modes of one.

**Why a separate capability and not a mode of `pool.info`.** The repository already draws this line
on the same three tests: a different endpoint, a different output contract, a different chain set.
`chain.tvl` is separate from `protocol.tvl` on those three (`packages/core/src/providers.config.ts:37`,
`{ capability: 'chain.tvl', adapterIds: ['defillama'] },`). All three hold here.

**Rejected: one tool with a discriminated input.** It costs one `ToolSpec` less and merges an exact,
complete answer with a capped sample into one output shape. A caller then cannot tell which one it
received, which is the class L-10 records.

```jsonc
// onchain_token_pools — the pools a token trades in. DexScreener-backed, keyless, 0 credits.
// DESIGNED, not registered.
// { token: string (.max(128)), chain?: ChainInput, limit?: number }
// → {
//     chain: Chain | null,   // OUR canonical slug; null on the cross-chain form
//     pools: Pool[],         // each row carries its OWN chain — see below
//     truncated: { pairs: boolean; reason: string },
//     source: "dexscreener", fetchedAt
//   }
// Rows are the canonical `Pool` (§4.1) with the six optional fields T-014 adds in §5.1.7.
```

**This block carries no capability anchor.** The anchor's gate refuses one naming a capability that
no registered tool serves (`packages/mcp-server/test/docs-counts.test.ts:485`,
`const stale = [...documented.values()].flat().filter((capability) => !served.has(capability));`).
The anchor lands in the commit that registers the `ToolSpec` — the rule §5.1.6 and §5.1.7 both state.

**`PLANNED_TOOL_NAMES` carries the name until then.** This section is a gated document, so naming a
tool that does not exist requires the entry (`packages/mcp-server/test/tool-inventory-docs.test.ts:141`,
`const PLANNED_TOOL_NAMES = new Map([`). It leaves that map in the same commit that registers the spec.

**Two routes, one per form of the question, measured 2026-08-18.**

| Form              | Vendor route                                   | What it guarantees                              |
| :---------------- | :--------------------------------------------- | :---------------------------------------------- |
| `token` + `chain` | `GET /token-pairs/v1/{chainId}/{tokenAddress}` | every DEX on that chain, capped at 30 rows      |
| `token` alone     | `GET /latest/dex/tokens/{tokenAddress}`        | a sample across chains, capped at 30 rows total |

`osBGT` (`0xD2C41BF4033A83C0FC3A7F58a392Bf37d6dCDb58`, `berachain`) returned 6 pools on two DEXes,
`kodiak` and `winnieswap`. WETH on `ethereum` returned 30 rows across seven DEXes.

**Every row carries its own chain, and the cross-chain form is a sample.**

**Why.** A token address is not unique across chains. Measured 2026-08-18:
`GET /latest/dex/tokens/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — the USDC address on
`ethereum` — returned 30 rows, of which 29 were `pulsechain` and 1 was `ethereum`. A fork
reproduces the addresses of the chain it forked. An answer presented as "this token's pools" would
attribute another chain's pools to it.

**Truncation names three causes separately, never folded.** The vendor page cap, which no argument
of either route widens; the `limit` cut, which a larger `limit` recovers; and dropped rows, which
nothing recovers. This is the L-14 contract the `pairs.active` route already carries
(`packages/core/src/adapters/dexscreener/index.ts:20`,
`* L-14 — the size of one `/latest/dex/search` page, **measured, not assumed**.`).

**The 30-row cap on these two routes is measured, not inherited.** `VENDOR_PAGE_SIZE` was measured
for `/latest/dex/search`. The task that registers this tool records its own evidence for
`token-pairs/v1` and `/latest/dex/tokens/` rather than citing that constant.

**Row order is not declared to mean anything.** No probe of these two routes has established
whether order is stable or size-ranked, so the contract makes no claim about it. `truncated.reason`
names the cap and does not name order until a probe of these two routes measures it.

**Coverage is the registry's answer, not this section's.** The tool serves wherever
`vendors.dexscreener` is non-null, which R-33 makes a measured column (014-32a, L-18). Stating a
number here would pin a value that task changes.

**Cache and deadline follow the `pool.info` row.** Both capabilities read the same vendor at the
same freshness, and pool membership does not move faster than reserves do.

### 5.2. Internal interfaces

```ts
// packages/core — the package's public API (re-exported from src/index.ts)
export {
  ChainSchema,
  TokenSchema,
  WalletSchema,
  BalanceSchema,
  PoolSchema,
  OhlcvSchema,
  SnapshotSchema,
};
export { normalizeAddress, isValidAddress };
export {
  CapabilityRegistry,
  type CapabilityRoute,
  type ProviderAdapter,
  type CapabilityDescriptor,
};
export { routes, adapterRegistrations } from './providers.config.js';
export { safeFetch, assertAllowedHost, throttle };
export { getCacheStats } from './cache/stats.js';

// M2 (TASK-005): three new canonical types + the only publicly exported nansen factory (already
// budget-gated inside, §3.2 — there is NO separate "raw" export) + the BudgetStore
// interface/factory, the same pattern as createCacheStore/CacheStore.
export { SmartMoneyFlowSchema, type SmartMoneyFlow };
export { EntityLabelSchema, type EntityLabel };
export { TokenRiskScoreSchema, type TokenRiskScore };
export { createNansenAdapter, type NansenAdapterDeps } from './adapters/nansen/index.js';
export { type BudgetStore, createBudgetStore } from './cache/budget-store.js';

// TASK-006: the chain registry, the chain-input schema, the derived coverage matrix and the two
// chain errors. `loadChainRegistry`/`createCoverage` are factories, never module singletons (§8),
// so each consumer constructs and injects its own instance.
export {
  loadChainRegistry,
  type ChainInfo,
  type ChainFamily,
  type ChainRegistry,
} from './chain/registry.js';
export { ChainInputSchema, createChainInputSchema, canonicalizeChain };
export { createCoverage, type Coverage };
export { UnknownChainError, ChainRegistryLoadError, CapabilityNotCoveredOnChainError };

// SHIPPED (T-012, commit 6af4b19, 2026-08-05 — ADR-002 D2/D3/D4/D8): the policy-descriptor
// registry, the capability manifest, and the third typed outcome `resolve()` can throw.
// `AdapterRegistration`'s `tier`/`trust` fields ride along on its EXISTING export
// (system-architecture.md, adapters module) — no new export for them alone. `ttlFor` (exported from
// `./cache/ttl.js`, consumed by `readme-tool-table.test.ts`) kept its signature and export path
// UNCHANGED (R-138) and is now a reader of `capabilityManifests` internally, which is not a
// public-API change.
export { type PolicyDescriptor } from './adapters/policy.js';
export { type CapabilityManifest, capabilityManifests } from './capability-manifest.js';
export { CapabilityDeadlineExceededError }; // beside CapabilityUnavailableError

// packages/mcp-server/src/server.ts — the server factory (transport-agnostic, D3):
export function createServer(deps: {
  env: Env;
  version: string;
  registry?: CapabilityRegistry; // injectable for tests (§3.2)
  budgetStore?: BudgetStore; // injected the same way as registry; used by the three paid tool
  // handlers ONLY for the read-only `_meta.budget` (§5.1.2) — the gate itself lives in the nansen adapter
}): McpServer;
```

`registry` defaults to the single real build from `providers.config.ts` + `adapterRegistrations`
(constructed once in `index.ts` and passed into `createServer`); tests pass their own implementation
of the same public `resolve()` contract, assembled from fixtures, rather than mocking transport or
network globally. `budgetStore` follows the same rule — the real store by default (§3.2), an
in-memory/fixture implementation of the same interface in tests.

**T-014 chooses that default by storage axis, not by literal class.** `main()` builds
`SqliteBudgetStore` on the SQLite axis and `PgBudgetStore` on the Postgres axis
(`system-architecture.md` §3.4.8). The parameter's type is `BudgetStore`, so `createServer` keeps
its signature (§5.4.1).

### 5.3. Integrations with external systems

| Provider (`adapter.id`) | Base host(s)                                                                                               | Auth                                                                                     | Transport                               | Status                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| `coingecko`             | `api.coingecko.com`, `pro-api.coingecko.com`                                                               | optional `COINGECKO_API_KEY` (demo tier) / `COINGECKO_PRO_API_KEY` (Pro tier → pro host) | REST                                    | live                                         |
| `dexscreener`           | `api.dexscreener.com`                                                                                      | none                                                                                     | REST                                    | live                                         |
| `defillama`             | `api.llama.fi`                                                                                             | none                                                                                     | REST                                    | live                                         |
| `dune`                  | `api.dune.com`                                                                                             | `DUNE_API_KEY` (free)                                                                    | REST (Query API)                        | **interface/config stub, never called**      |
| `rpc-evm`               | the chain's own curated `rpcHosts` (§4.1) — for `ethereum`, `ethereum-rpc.publicnode.com` + `eth.drpc.org` | none                                                                                     | JSON-RPC over HTTP                      | live                                         |
| `rpc-solana`            | `api.mainnet-beta.solana.com`                                                                              | none                                                                                     | JSON-RPC over HTTP                      | live                                         |
| `dash-platform`         | evonode host(s) — TBD, backlog §11                                                                         | none                                                                                     | gRPC                                    | **interface + fixture contract, not called** |
| `platform-explorer`     | `platform-explorer.pshenmic.dev`                                                                           | none                                                                                     | REST                                    | live — the only live Dash source             |
| `pg-history`            | from `ONCHAIN_PG_URL` (no hostname allowlist — the DSN is the access control)                              | DSN (never logged)                                                                       | Postgres wire (SELECT-only)             | live, optional (R-12)                        |
| `nansen`                | `api.nansen.ai`                                                                                            | `NANSEN_API_KEY` via the `apiKey` header (NOT `Authorization: Bearer`)                   | REST (POST JSON, except `GET /account`) | live, paid (R-29)                            |

Each row is the source of the `hosts` SSRF allowlist for **its own** adapter (§3.2, §7); `dune` and
`dash-platform` register `hosts`/DSN configuration but make no outbound calls. `nansen` is the tenth
row and the only paid, budget-gated adapter in the registry; `NANSEN_API_KEY` obeys the same secret
contract as the five M1 keys (§7.2).

**The verified outbound address is not pinned for the connect** (AC-22 as reformulated by the owner,
2026-08-12). The host is checked against the row's list before the request, and the connect resolves
the name again. Node's built-in `fetch` exposes no DNS hook, so nothing in this design holds the
address that was checked.

**Why the residual is ACCEPTED for T-014.** Every host above is curated, and TLS certificate name
validation bounds what a changed answer can reach ⇒ closing the window would need a new dependency
or a rewritten transport.

The original requirement is filed as WI-60
(`docs/backlog/wi-60-verified-outbound-address-is-not-pinned-for-the-connect.md`). Its trigger is
the first non-curated outbound host, not a date.

### 5.4. T-014 — the wire contract of the network deployment profile

> **T-014 is DESIGNED, not built, as of 2026-08-12.** Every repository coordinate below points at
> code that exists today. Every SDK option name and status code was read from the installed
> `@modelcontextprotocol/sdk@1.29.0`, not recalled.

**Scope.** No registered tool loses or redefines a field it has today.

T-014 changes the twenty-tool surface in three ways:

- it adds a twenty-first tool, `onchain_pool_info` (§5.1.7, R-21.1);
- it adds a twenty-second tool, `onchain_token_pools` (§5.1.8, R-34);
- it adds six optional fields to `Pool`, which `onchain_active_pairs` embeds (§5.1.7) and
  `onchain_token_pools` returns (§5.1.8).

The rest of this section changes the transport that carries the tools, the checks placed in front of
it, and the visibility rule over `_meta`.

**An earlier revision of this paragraph read "the twenty tool contracts of §5.1 do not change".**
That sentence was written before `OQ-T014-F` selected variant 1, and BLOCKING-1 of the round-1
review recorded it as contradicting R-21.1.

**The frozen `tools/list` snapshot therefore changes, and the commit states why** (AC-2, §5.1.7).

**Two things called "profile", kept apart by name.** A **deployment profile** names one combination
of transport and store, and a process runs exactly one. An **access profile** is the settings entity
a token references (§4.5.3), and a process holds many.

**Transport and storage are two independent axes** (owner decision 2026-08-12). Three combinations
carry a name: `local` is stdio over SQLite, `network` is HTTP over Postgres, and `network-sqlite` is
HTTP over SQLite. `ONCHAIN_PROFILE` selects one (`docs/architectures/deployment.md` §10.1.1, `:81`,
`The combination is selected by`). The component each axis builds is
`system-architecture.md` §3.4.8.

**Why `network-sqlite` is named rather than improvised.** It exercises this section's transport
without a Postgres instance.

#### 5.4.1. One endpoint, one session header (R-1, R-12)

The engine serves Streamable HTTP at one path, `/mcp`, beside stdio.

- `POST /mcp` carries a JSON-RPC message.
- `GET /mcp` opens the server-initiated SSE stream.
- `DELETE /mcp` ends the session.
- Any other method answers HTTP 405 with `Allow: GET, POST, DELETE`
  (`@modelcontextprotocol/sdk@1.29.0`, `dist/esm/server/webStandardStreamableHttp.js` line 353,
  `handleUnsupportedRequest() {` — verified 2026-08-13; the package resolves under
  `packages/mcp-server/node_modules/` in this pnpm workspace, so the coordinate is SDK-relative and
  not repo-relative).

The session identity travels in the `Mcp-Session-Id` header, lowercase on the wire
(`…/webStandardStreamableHttp.js` line 234 `headers['mcp-session-id'] = this.sessionId`). The server
mints it on initialization; the client echoes it on every later request.

One `StreamableHTTPServerTransport` and one `McpServer` exist per session, over process-level
dependencies (owner decision 2026-08-12; the dependency set is §3.2's).

The transport is chosen once, in `packages/mcp-server/src/index.ts:166`
(`await server.connect(new StdioServerTransport());`). `createServer`
(`packages/mcp-server/src/server.ts:66`) keeps its signature (§5.2).

**Why the factory signature can stay unchanged.** The principal is a per-request fact, not a
per-process one. It arrives on the tool callback's `extra.authInfo`
(`@modelcontextprotocol/sdk@1.29.0` `shared/protocol.js` line 349 `authInfo: extra?.authInfo`), which
the factory never sees.

**Declared transport options.** Each is an option of `StreamableHTTPServerTransportOptions`
(`…/webStandardStreamableHttp.d.ts` lines 48-96).

| Option                         | Declared value                                   | Requirement           |
| :----------------------------- | :----------------------------------------------- | :-------------------- |
| `sessionIdGenerator`           | a function returning a fresh id                  | R-2.3 — stateful mode |
| `allowedHosts`                 | the list validated from `.env`                   | R-12.1, AC-34         |
| `allowedOrigins`               | the list validated from `.env`, empty by default | R-12.2, R-12.5, AC-35 |
| `enableDnsRebindingProtection` | `true`                                           | R-12.3, AC-37         |
| `onsessioninitialized`         | records the session in the process map           | R-2.3                 |
| `onsessionclosed`              | drops the map entry and its `McpServer`          | R-2.4, R-24.2, RISK-6 |
| `enableJsonResponse`           | unset — answers stream as SSE                    | see the note below    |
| `eventStore`                   | unset — no stream resumption in T-014            | see the note below    |

**Why answers stream instead of returning one JSON body.** A paid composite can lawfully occupy
330 000 ms (§5.4.5). A POST that emits no bytes for that long is dropped by intermediaries.

**Why no `eventStore`.** Resumption is not in T-014's scope. Consequence, stated rather than
implied: a dropped stream is retried by the client as a new server-side request, and it gets its
own `request_trace` row (§4.5.7).

**`allowedOrigins` is an admission check, not a CORS policy.** The SDK emits no `Access-Control-*`
header at all — measured 2026-08-12: zero files under `@modelcontextprotocol/sdk@1.29.0` `dist/`
contain that string. AC-35 therefore holds by abstention, and this process adds no CORS middleware.

**The engine terminates no TLS and holds no certificate (R-12.6).** A reverse proxy owns that.
`EnvSchema` (`packages/mcp-server/src/env.ts:46`) declares no certificate or key path; §10 owns the
test that asserts the absence (AC-36).

#### 5.4.2. The order of checks on an incoming request (R-3, R-12, R-24)

Steps 1 to 3 run in this process's own request listener, before `transport.handleRequest`.

1. **Perimeter.** `Host` and `Origin` are compared with the declared lists. Postcondition: an
   off-perimeter request has caused no token-store read.
2. **Authentication.** The bearer from `Authorization` is hashed and looked up (§4.5.4).
   Postcondition: a request without a valid token has reached neither `CapabilityRegistry` nor the
   cache (R-3.2, R-3.4, AC-3).
3. **Session admission.** An existing `Mcp-Session-Id` selects its instance; a new session is
   created only if the ceiling allows. Postcondition: live sessions never exceed the declared
   ceiling (R-24.1).
4. **Transport.** `transport.handleRequest(req, res)` applies the SDK's own header, session and
   content-type checks.
5. **Tool layer.** The registered callback resolves the capability (§5.2).

**Why the perimeter is checked before the token.** A request from outside the declared perimeter
must not cause a read of the token store.

**Why one value is read twice rather than written twice.** The transport re-checks the perimeter
inside `handleRequest` (`…/webStandardStreamableHttp.js` line 144
`const validationError = this.validateRequestHeaders(req);`). Both readers take the single value
validated from `.env` (R-29.3). Two copies of a list drift; two readers of one value cannot.

#### 5.4.3. Failure representation — two levels (R-26)

| Class                                            | Level          | Wire form                                   | Reaches a tool |
| :----------------------------------------------- | :------------- | :------------------------------------------ | :------------- |
| authentication: absent, invalid or revoked token | protocol       | HTTP 401 + `WWW-Authenticate: Bearer`       | no             |
| perimeter: `Host` or `Origin` refused            | protocol       | HTTP 403, JSON-RPC `-32000`                 | no             |
| session ceiling reached                          | protocol       | HTTP 503 + `Retry-After`, JSON-RPC `-32000` | no             |
| unknown or expired `Mcp-Session-Id`              | protocol       | HTTP 404, JSON-RPC `-32001`                 | no             |
| unsupported HTTP method                          | protocol       | HTTP 405 + `Allow`                          | no             |
| saturated shared limiter                         | tool execution | `{ isError: true, content: [...] }`         | yes            |
| exhausted credit budget                          | tool execution | `{ isError: true, content: [...] }`         | yes            |
| unavailable capability                           | tool execution | `{ isError: true, content: [...] }`         | yes            |
| call deadline expired                            | tool execution | `{ isError: true, content: [...] }`         | yes            |

Rows 2, 4 and 5 are produced by the SDK (`…/webStandardStreamableHttp.js` line 118 and `:127`, `:604`,
`:353`). Rows 1 and 3 are produced by this process's listener.

**The tool-execution form is MCP-prescribed and already implemented.** `toCallToolResult` renders
every unsuccessful outcome as `{ isError: true, content: [{ type: 'text', text: reason }] }`
(`packages/mcp-server/src/tools/registry.ts:205`
`return { isError: true, content: [{ type: 'text', text: outcome.reason }] };`). `defineTool`
(`packages/mcp-server/src/tools/registry.ts:414`, `export function defineTool<`) is the only
registration path, and it wraps every handler in that renderer
(`packages/mcp-server/src/tools/registry.ts:289`,
`toCallToolResult(await definition.handler(`). The form therefore covers all 20 tools.

**A tool-execution failure must not be rendered with `isError: false`** (AC-33). The violation shows
on a handler that returns `ok: true` carrying a refusal message as its output.

**The session-ceiling refusal answers 503, not 429.** Rejected alternative: 429 states that this
caller called too often, while the measured cause is shared process capacity across all principals.
`Retry-After` is what makes the refusal actionable, and AC-30 requires an announced class rather
than a timeout.

**A protocol-level refusal leaves no `request_trace` row.** `request_trace.principal_id` is
`NOT NULL` (§4.5.7), and a request refused at step 1 or 2 has no principal.

**Protocol-level refusals are observable in the stored channel instead** (§4.5.8):
`auth.rejected`, `perimeter.rejected`, `session.limit_reached`, `session.evicted`.

**Why the stored channel and not stderr.** On this transport no client and no client's operator
reads the process stderr (R-19.2, R-32.1).

**A withheld refusal carries the `diagnostics.id` of its own row** (R-31.1a, AC-50; owner decision
2026-08-13, closing `OQ-T014-SEC-2` — §7.5.6, §4.5.8). The client rendering names no route, no
provider, no cost and no budget state; the identifier is what lets an operator recover the text
that was withheld.

| Refusal                         | Produced by   | Where the identifier travels             | Event                   |
| :------------------------------ | :------------ | :--------------------------------------- | :---------------------- |
| authentication (401)            | this listener | JSON-RPC error body, `error.data.event`  | `auth.rejected`         |
| perimeter (403)                 | this listener | JSON-RPC error body, `error.data.event`  | `perimeter.rejected`    |
| session ceiling (503)           | this listener | JSON-RPC error body, `error.data.event`  | `session.limit_reached` |
| the four tool-execution classes | `defineTool`  | the `content[0].text` the client renders | `tool.refused`          |

**The 401 answers with a JSON-RPC error body as well as `WWW-Authenticate`.** Its `error.id` is
`null`: the request body may be unparsed at that point, and JSON-RPC 2.0 licenses `null` for the
case where the id cannot be determined.

**The tool-execution identifier travels in the text, not in `_meta`.** `_meta` visibility is a
function of the principal's role (§5.4.4), so an identifier placed there would be absent for the
role that most needs to quote it. The text is the one field every client renders.

**Rows 4 and 5 carry no identifier, and this is the rule holding rather than a gap in it.** An
unknown `Mcp-Session-Id` and an unsupported HTTP method withhold nothing — there exists no operator
rendering of them to recover. The identifier accompanies exactly those refusals whose full text was
withheld. §4.5.8's vocabulary follows that boundary: it names an event for every row of the table
above and none for rows 4 and 5. A test may therefore assert the absence there without asserting a
defect.

**The row is written before the response leaves the process** (§4.5.8). An identifier that resolves
to nothing is a worse answer than no identifier, because it costs the operator a lookup to learn
that.

#### 5.4.4. `_meta` visibility is a function of the principal's role (R-6)

**The rule.** Every `_meta` field carries exactly one visibility class. A `client` field goes to
every principal. An `operator` field goes only to a principal whose role is `admin`.

**The principal is declared in `system-architecture.md` §3.4.3, not here.** This section reads one
of its fields, `role`, and restates none of them.

Four properties make this a rule rather than a list of fields:

1. The class is declared once, in a compiled table beside the `_meta` type declarations (§5.1.2).
2. The projection runs in one place — `toCallToolResult`
   (`packages/mcp-server/src/tools/registry.ts:201`
   `function toCallToolResult<TOutput extends Record<string, unknown>>(`) — after the handler
   returns and before the SDK sees the result.
3. A field absent from the table is treated as `operator`. A field added later is therefore
   withheld from clients until someone classifies it (R-6.4).
4. The role is read from the request's principal. The principal is never itself a `_meta` field
   (R-5.4).

Classification today:

| `_meta` field                                     | Class                       | Requirement     |
| :------------------------------------------------ | :-------------------------- | :-------------- |
| `cache.status`, `cache.ageMs`, `cache.capability` | client                      | R-6.3           |
| `cache.provider` — it names an adapter id         | client, narrowed by profile | R-6.3; §5.4.4.1 |
| `cache.perSource[]` — the merged shape of §5.1.6  | client, narrowed by profile | R-6.3; §5.4.4.1 |
| `timing.overrunMs`                                | client                      | R-16.4          |
| `budget.provider`, `budget.creditsUsedToday`      | operator                    | R-6.1           |
| `tier`                                            | declared on no transport    | R-6.2, AC-7     |

**A coalesced follower is not a third `cache.status`.** A singleflight follower records
`served_from = 'coalesced'` in the request trace (§4.5.7, owner decision 2026-08-12, closing
`OQ-T014-SA-1`). On the wire `_meta.cache.status` keeps its two values, and the follower reports
`miss`.

**Why.** The answer was produced by the coalesced call rather than read from a stored entry ⇒ `hit`
would tell the caller an entry existed before its request arrived.

**Why the third value stays off the wire.** A new `cache.status` value would redefine a field on all
twenty registered tools. §5.4's scope permits two changes, and this is neither of them.

**Why `timing.overrunMs` is a client field.** Only the caller can judge whether a late but complete
answer is still useful (OQ-T012-6). Withholding the overrun would make late invisible again.

**Why an unclassified field defaults to `operator`.** The two directions of error are not
symmetric. A withheld field is a missing convenience; a leaked field is an operator fact in a
client's context, and R-20 forbids that permanently.

**The local stdio profile keeps today's behaviour.** Its principal holds the role `admin`, so
`_meta.budget` is present (UC-3, AC-6).

**What the rule does not reach.** It governs `_meta` only. `missingSources` (§5.1.6) is a field of
`structuredContent`, so no `_meta` classification can carry it. The setting of §5.4.4.1 reaches both.

##### 5.4.4.1. Route disclosure in a successful response is a profile setting

**The decision.** Owner, 2026-08-13, closing `OQ-T014-IF-1`: route disclosure is a setting on the
access profile. Rejected alternative: a fixed rule of the wire.

Three fields name our adapters to a client in a SUCCESSFUL response:

- `_meta.cache.provider` — the answering adapter id
- `_meta.cache.perSource[]` — one entry per contributing adapter
- `structuredContent.missingSources` (§5.1.6) — the adapters that did not contribute

The setting decides whether those three fields are present. Their visibility class stays `client`.
The setting narrows that class for one principal at a time.

**Where the setting lives.** On the access profile the token references (R-13), beside
`creditsBalance`, `rateLimit` and `toolAllowlist` (R-13.7). It is a property of neither the
transport nor the role. Its field name is assigned with R-13.7's field list in `docs/TASK.md`.

**The setting only removes fields from a response.** It never adds one, and it never widens a class.

**Why that matters.** R-29.4 admits a setting into Postgres only when it acts on narrowing.

**Phase 0 default: disclosure permitted.** The single self-issued token discloses the route, matching
`ADR-003` D5's posture of all tools allowed and unlimited quota.

**Why the field exists while its value is permissive.** `ADR-003` D5 argues that an absent field
cannot be set to unlimited. The same argument holds for a field that cannot be set to withheld.

**`tier` is not covered by this setting.** `ADR-002` D8 keeps `tier` off every response
unconditionally (R-6.2, AC-7). No profile value re-enables it.

**`_meta.budget` is not covered either.** It stays bound to role `admin` (R-6.1, AC-6).

**Why a setting and not one rule for everybody.** The engine has two kinds of client with opposite
needs. An operator debugging a merge reads which source answered. A paying third party must not read
our supplier list from a successful response.

#### 5.4.5. The deadline over the wire (R-16)

**The wire parameter is a duration, and the server converts it.** A tool that accepts a deadline
takes `deadlineMs`, a positive safe integer of milliseconds. The server computes the absolute
moment from its own clock at admission.

**Why a duration and not a moment.** `registry.resolve()`'s fourth parameter is an absolute moment
(`packages/core/src/adapters/registry.ts:671`, `requestedDeadlineAtMs?: number,`). Accepting a moment
from the wire would let a remote clock's skew set our spending bound.

**The caller may only narrow, and a widening value is refused rather than clamped.** A `deadlineMs`
exceeding the capability's manifest number fails at the boundary (AC-12). Rejected alternative:
clamping, which answers under a bound the caller is never told about.

**Where the boundary is.** The tool's zod input schema validates the shape; `resolveCapability`
(`packages/mcp-server/src/tools/resolve-capability.ts:139`) compares it with
`capabilityManifests[capability].deadlineMs` and passes the fourth argument on. That function is the
single place tools reach the registry, and today it calls `registry.resolve(capability, chain, args)`
with three arguments (`resolve-capability.ts:146`).

**The registry keeps its own narrowing as a backstop**
(`packages/core/src/adapters/registry.ts:747`
`const effectiveDeadlineAtMs = Math.min(nowMs + manifest.deadlineMs, requested ?? Infinity);`). Both
readers read `capabilityManifests`, so the boundary and the backstop cannot disagree about the
ceiling.

**The server's response timeout is a different number from `deadlineMs`** (OQ-T012-6).

- `deadlineMs` bounds what a call may SPEND. It does not bound the moment of delivery.
- The response timeout bounds how long one HTTP response may stay open.
- Derived bound: `deadlineMs` covers only the cancellable part of a call and `paidLegMs` is uncut
  (`packages/core/src/capability-manifest.ts:146-151`). Worst case measured 2026-08-12 —
  60 000 ms + 270 000 ms = 330 000 ms on `entity.labels`; applied: the response timeout must exceed
  330 000 ms.
- A response timeout below that bound cuts a call that was completing lawfully.
- The value is a bootstrap setting in `.env` (R-29.2). §10 owns its name and declares it
  `ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS` (`docs/architectures/deployment.md` §10.3, `:187`,
  `ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS`). The name was read there 2026-08-13, not assumed here.
- Its unset default, declared in that same row, is 360 000 ms. It clears the 330 000 ms bound
  derived above.

**An expired response timeout does not cancel the call.** A paid call the vendor accepted is run to
completion (R-17), its result is cached, and `usage` records the spend. `request_trace` records the
outcome (§4.5.7). The client sees a closed connection; its retry is a new server-side request and is
served from the cache.

#### 5.4.6. `shareable` — T-014 is its first reader (R-18)

**Measured state, 2026-08-12.** The field is declared optional at
`packages/core/src/capability-manifest.ts:149` (`shareable?: boolean;`). It carries a value on
**none** of the manifest rows: `Object.keys(capabilityManifests).length` returns 26, and the count
of rows where `shareable !== undefined` is 0. No code reads it.

**T-014 makes the field required.** Each of the 26 rows carries an explicit value with its
derivation recorded beside it (R-18.1). An omitted value is a compile error, never a default
(R-18.3, AC-13).

**Why an explicit value rather than an inferred default.** ADR-002 D3 names `true` as the default.
An inferred default and a never-considered row are indistinguishable in the table, which is the
L-10 failure class the data model states as canon (§4.5).

**What the reader does.**

- `shareable: true` — the answer is cached; any principal may be served from that entry.
- `shareable: false` — the capability is neither read from nor written to the cache; every call
  reaches the source.

**Where the reader lives, measured 2026-08-20 (task 014-31 part 2).**
`CapabilityRegistry.resolve()` binds ONE store for the call —
`manifest.shareable === false ? this.uncached : this.cache` — and the six cache call sites of the
two walks use that binding. The tool boundary (`mcp-server/src/tools/resolve-capability.ts`) was
considered and rejected: it is the single funnel into `resolve()`, and it sits ABOVE both cache
legs, so a check there could refuse the call and could not make it uncached.

**The negative cache is covered.** A negative entry carries no vendor data and still decides what a
LATER caller is told, so the arm is read without a carve-out. Declared price: a non-shareable
capability whose `normalize()` fails re-enters the vendor on every call.

**Coalescing is covered, and it is not the cache.** `singleflight` keys on
`deriveArgsHash(capability, args)`, which carries no principal by design (R-5.1). Two principals
issuing the identical non-shareable call concurrently would therefore share ONE vendor call and be
handed ONE value — the serving this section forbids, reached without the cache. The paid adapter
gives such a call a key nothing else can match, so it is always a leader. Declared price: two
principals pay for two vendor calls, which is the point — their answers differ.

**`_meta.cache.status` stays `'hit' | 'miss'`.** A non-shareable call reports `'miss'`, so the wire
keeps "nothing usable was cached" and "the cache was never consulted" in one value. A third value
would widen `CacheMeta`, a type eleven tools depend on (R-175(b)), for a case no shipped capability
reaches.

**Deviation.** ADR-003 D5 §5 states "`shareable: false` → кеш в пределах принципала либо не
кешируется вовсе"; this document implements the second arm only. **Why.** The owner's decision of
2026-08-12 keeps the principal out of the cache key (R-5.1, §4.5.10), which closes the first arm.
The annotation §5.4.7 called for was written into ADR-003 D5 on 2026-08-20.

**Nothing changes for any shipped capability.** All 26 rows describe public on-chain facts and take
`true`. The first capability whose answer depends on the caller's identity is the first `false`.

#### 5.4.7. Open questions and one obligation raised by this section

**OQ-T014-IF-1 — closed by the owner, 2026-08-13.** The question was whether R-20.3's review of
route composition reaches successful responses. Decision: route disclosure in a successful response
becomes a setting on the access profile, permitted by default in phase 0. Rejected: a fixed rule of
the wire — one fixed value serves the debugging operator or the paying third party, never both. The
fields and the bounds of the setting are recorded in §5.4.4.1.

**What the decision does not settle.** Route composition also appears in FAILURE diagnostics.
`CapabilityUnavailableError` and `CapabilityDeadlineExceededError` each carry `tried[]`
(`packages/core/src/adapters/registry.ts:32`, `readonly tried: CapabilityAttempt[];`), and R-20.3
names `tried[]` beside `missingSources`. R-31 already governs those through its two renderings.

- Success path — the access profile's route-disclosure setting decides (§5.4.4.1).
- Refusal path — R-31.4 withholds adapter names and walk order from every client, always.

**Neither rule reaches the other path.** A permissive profile does not put adapter names into a
refusal. The refusal rule does not remove `_meta.cache.provider` from a successful response.

**Acceptance.** AC-14 and AC-47 cover the refusal path and stay unchanged. AC-14 is a gate over
refusal text, so it observes no successful response. The success path therefore needs a criterion of
its own. Sentence for the Planning phase to lift: "A client whose access profile forbids route
disclosure receives no `_meta.cache.provider`, no `_meta.cache.perSource[]` and no
`structuredContent.missingSources` in a successful response." Its id is assigned in `docs/TASK.md`,
whose T-014 list ends at AC-48.

**OQ-T014-IF-2 — closed by the owner, 2026-08-12.** The question was whether an open SSE stream is
terminated when its token is revoked. A revoked token is refused on the next request, which is what
R-15.6 and AC-26 require. A `GET /mcp` stream opened earlier issues no request, so nothing on the
revocation path reaches it, and the engine does not terminate it mid-stream.

That stream ends on one of two later events: the client sends its next request and receives HTTP 401
(§5.4.3), or the session is evicted for idleness (R-24.2). The residual — a stream that keeps
receiving server-initiated messages between those two moments — is ACCEPTED and recorded here.

**OQ-T014-IF-3 — closed by the owner, 2026-08-13**, in §5.1.7 where it was raised. The question was
whether a fee tier no wired provider publishes satisfies R-21.1. `feeTierBps` stays in the contract
as an optional field with a declared derivation: `eth_call` of `fee()`, selector `0xddca3f43`. It is
populated where that call answers, absent where it does not, and never guessed.

**Obligation — discharged 2026-08-20 (task 014-31 part 2).** ADR-003 D5's `shareable` sentence
carries an annotation naming the arm this project took, in the style of ARCHITECTURE §1.2's
annotation to ADR-001 D6 — not an ADR rewrite.
