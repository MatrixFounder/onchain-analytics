# 5. Interfaces

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 5.1. External API — 13 MCP tools

`onchain_ping` (M0, unchanged, R-20) — §5.1.1. Four read tools arrived in M1, three paid
Nansen-backed tools in M2 (§5.1.2), two registry-backed tools with TASK-006 (§5.1.3), one free
DEX-volume tool with TASK-007 (§5.1.4), one free holders tool with TASK-008 (`onchain_token_holders`
— `{ chain, tokenAddress }` → `TokenHolders`, capability `token.holders`), and one free BTC-supply
tool with TASK-009 (§5.1.5).

**The `chain` parameter, stated once.** Eleven of the thirteen tools take a chain, and every one of them
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
// onchain_new_pairs — { chain: ChainInput, limit?: number }
// Capability: pairs.new
// → { chain, pairs: Pool[], source, fetchedAt }
// (the limit default is materialized BEFORE args are built: an omitted limit and an explicit
// limit:10 would otherwise derive different args hashes for one logical request, duplicating the
// upstream fetch instead of sharing one cache entry)
// onchain_protocol_tvl — { chain: ChainInput, protocolSlug: string (.max(128)) }
// Capability: protocol.tvl
// → { protocol, chain, tvlUsd, totalTvlUsd, source, fetchedAt }
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
`onchain_entity_label` has the only compound `superRefine` of the thirteen tools: **at least one** of
`query`/`tokenAddress` is required (otherwise there is nothing to search for), and `tokenAddress`
is mandatory when `exhaustive: true`.

**`_meta.budget` — budget visibility for the caller (R-41, the analogue of `_meta.cache`):**

```ts
export interface BudgetMeta {
  provider: 'nansen';
  creditsUsedToday: number; // usage.credits_used of the current day bucket, AFTER this call
}
```

It is present **only** when the capability is paid AND actually executed (`_meta.cache.status ===
'miss'`). On a hit the gate, `costOf()` and the network are not exercised at all (UC-5), so
`_meta.budget` is **absent entirely** rather than coerced to `0`/`null` — the same principle as
`_meta.cache.ageMs` on a miss (§3.2).

The read does **not** go through `CapabilityRegistry.resolve()`'s return type: that type is shared
by all twelve adapters and must not grow for the sake of one paid provider. The three tool handlers
instead read `budgetStore.getUsage('nansen', dayBucketMs(Date.now()))` with a **separate** SQLite
SELECT after `registry.resolve()` has returned — purely for display, never part of the gate decision
(which has already happened inside `nansen.fetch()`, §3.2). `BudgetStore` is injected into those
three handlers the same way `registry` is. Both degradation paths — no injected store, or a store
that throws — resolve to `undefined`: visibility must never turn an otherwise successful call into
an error.

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
`/protocol/{slug}`) and different output contracts: a protocol has `totalTvlUsd` across all chains, a
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
  Available on 'berachain' instead: chain.tvl, token.price, token.metadata, pairs.new.
  ```

  Both lists are computed from the coverage matrix (§4.2.3), so they cannot drift from actual
  behavior, and both are capped at ten entries plus an honest `+N more` — an error meant to save the
  caller a wasted call must not itself dump 458 slugs into the context. When the "available instead"
  list was not computed, it renders nothing: an empty list would read as "nothing works here", which
  is a false statement that talks an agent out of calls that would have succeeded.

**Backward compatibility (R-59).** `"ethereum"` and `"solana"` remain valid **indefinitely** — as
aliases, not as a transitional mode. Response shapes do not change: tools still answer
`chain: "ethereum"`, the canonical slug. Cache entries were not invalidated (§4.2.2).

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
