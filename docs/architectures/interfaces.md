# 5. Interfaces

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 5.1. External API — 20 MCP tools

`onchain_ping` (M0, unchanged, R-20) — §5.1.1. Four read tools arrived in M1, three paid
Nansen-backed tools in M2 (§5.1.2), two registry-backed tools with TASK-006 (§5.1.3), one free
DEX-volume tool with TASK-007 (§5.1.4), one free holders tool with TASK-008 (§5.1.4a), and one free
BTC-supply tool with TASK-009 (§5.1.5).

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
dayBucketMs(Date.now()))` with a **separate** SQLite SELECT after `registry.resolve()` has returned —
purely for display, never part of the gate decision (which has already happened inside
`nansen.fetch()`, §3.2). `BudgetStore` is injected into those three handlers the same way `registry`
is. Both degradation paths — no injected store, or a store that throws — resolve to `undefined`:
visibility must never turn an otherwise successful call into an error.

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

**The `chain` parameter contract (R-50), shared by all eleven chain-taking tools:**

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
finding, `docs/TASK.md` §1.3): `privacy.shielded_pool.history`'s two adapters write two DIFFERENT
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
network globally. `budgetStore` follows the same rule — the real `SqliteBudgetStore` by default
(§3.2), an in-memory/fixture implementation of the same interface in tests.

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
