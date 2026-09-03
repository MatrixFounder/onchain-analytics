> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

#### Component: `@onchain-intel/core`

- **Type:** TypeScript library package (no `bin`), consumed by `mcp-server` through a
  `workspace:*` dependency.
- **Purpose:** canonical types, the chain registry, chain/address normalization, the Adapter +
  Capability Registry, twelve provider adapters. Also the two-level cache, the SSRF gate, the rate
  limiter, the credit budget gate, and a read-only PG client (`pg-history` adapter). Of the twelve
  adapters, nine landed in M1 — two of them, `dash-platform` and `dune`, interface/fixture-only —
  plus the paid `nansen` from M2, then the free `blockscout` from TASK-008 and `blockchain-info`
  from TASK-009.
- **Technologies:** TypeScript strict, zod, `better-sqlite3`, `lru-cache`, `ulid`, `@noble/hashes`,
  `bs58`, `pg`. `@noble/hashes` provides keccak256 for EIP-55, its only reason for existing here:
  ADR-001 D5 requires an EVM checksum, not just lowercase (§3.2.1). `bs58` does Solana base58
  decode/validate and is not hand-rolled, because address validation is a security boundary. `pg` is
  the read-only client behind `pg-history`.
  `@grpc/grpc-js` and `@grpc/proto-loader` are **not** dependencies: `dash-platform` is an
  interface + fixture contract with no live transport (below).

**Module: `src/types/*`** (D5, R-1/R-2)

Canonical zod schemas, the single source of truth — used both by runtime validation and by the MCP
tool schemas (re-exported into `mcp-server`):

```ts
// The set of accepted chain values lives in the registry (§3.2, "Module src/chain/registry"), not
// in the type. A closed `z.enum(['ethereum','solana','dash'])` literal had to be edited in five
// layers for every new chain (R-50b).
//
// TWO schemas, deliberately. One schema cannot serve both the input and the canonical output:
//   • on INPUT we must accept anything an agent might write (`ethereum`, `berachain`, `eip155:1`);
//   • on OUTPUT the canonical type must already carry a RESOLVED value — otherwise an alias leaks
//     into the canonical object, from there into the cache key, and one request yields two cache
//     entries (§4.2.2 — a money defect on paid routes, not cosmetics).

// Canonical form — used INSIDE domain types. The canonical value is the chain's SLUG, not its
// CAIP-2 id: R-59d forbids changing the shape of tool responses, and `onchain_get_token` has
// always answered `chain: "ethereum"`. CAIP-2 remains the registry's primary key; the slug is 1:1
// with it, unique, and never an alias — so the §4.2.2 requirement (no alias ever reaches a cache
// key) is met either way.
export const ChainSchema = z.string().min(1);
export type Chain = z.infer<typeof ChainSchema>;

// Input form — used ONLY in MCP tool schemas (§5.1). Accepts slug/alias/caip2. It VALIDATES and
// does not transform: the MCP SDK renders every tool input schema to JSON Schema for `tools/list`,
// and a zod transform has no JSON Schema representation, so a transforming schema makes the server
// answer `tools/list` with `-32603` — taking down tool DISCOVERY, i.e. the whole server. An unknown
// chain fails validation with a "did you mean" list (R-50c), at zero network calls and zero credits.
export const ChainInputSchema = z
  .string()
  .min(1)
  .max(MAX_CHAIN_INPUT_LENGTH)
  .superRefine(assertKnownChain); // registry lookup, skipped entirely for over-length input

// Canonicalization happens one line into each tool handler, still BEFORE the value reaches `args`
// and therefore before `deriveArgsHash`.
export function canonicalizeChain(raw: string, chains?: ChainRegistry): string; // → ChainInfo.slug

export const TokenSchema = z
  .object({
    chain: ChainSchema,
    address: z.string(), // normalized: EVM checksum / Solana base58
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().nonnegative().optional(),
    priceUsd: z.number().nonnegative().optional(),
    marketCapUsd: z.number().nonnegative().optional(),
    source: z.string(), // id of the source adapter
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();

export const BalanceSchema = z
  .object({
    assetType: z.enum(['native', 'token']), // M1 fills only 'native' — see the ERC-20/SPL decision
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
    amountRaw: z.string(), // exact integer as a string (DB-SCHEMA §1.7 convention)
    amountNum: z.number().optional(), // lossy projection
    contractAddress: z.string().optional(), // filled when assetType === 'token'
  })
  .strict();

export const WalletSchema = z
  .object({
    chain: ChainSchema,
    address: z.string(),
    balances: z.array(BalanceSchema),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

export const PoolSchema = z
  .object({
    id: z.string(),
    chain: ChainSchema,
    dexId: z.string(),
    baseTokenSymbol: z.string(),
    quoteTokenSymbol: z.string(),
    pairAddress: z.string(),
    createdAt: z.number().int().optional(),
    liquidityUsd: z.number().nonnegative().optional(),
    volume24hUsd: z.number().nonnegative().optional(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

// Reserved (R-1 requires the type to exist); no tool consumes it yet — the first consumer will be
// a candlestick/chart tool (M1.5+).
export const OhlcvSchema = z
  .object({
    chain: ChainSchema,
    pairAddress: z.string(),
    ts: z.number().int(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volumeUsd: z.number().nonnegative().optional(),
    source: z.string(),
  })
  .strict();

// Persistent form of the D5 addendum (snapshotter mode), aligned with DB-SCHEMA-CONCEPT §2. The
// engine does not write it and will not: the snapshotter stays on n8n permanently (owner decision
// 2026-07-25, ADR-001 D8 addendum). The type exists as the canonical form for READING that table
// (R-2/R-12). Name mapping at the persistence boundary (needed on the reading side in M3):
// valueRaw↔value_raw, valueNum↔value_num — every other field matches literally (§4.1, Entity
// Snapshot).
export const SnapshotSchema = z
  .object({
    metric: z.string(),
    asset: z.string(),
    ts: z.number().int(),
    valueRaw: z.string(),
    valueNum: z.number().optional(),
    source: z.string(),
    height: z.number().int().optional(),
  })
  .strict();
```

**Module: `src/chain/registry.ts` + `src/chain/registry.data.json`** (TASK-006, R-48/R-60)

The single source of facts about chains — **458** rows. Data lives in its own `.json`, code in its
own `.ts`: a registry diff (hundreds of lines on every sync) must not be mixed with a logic diff in
review.

```ts
export interface ChainInfo {
  caip2: string; // PK, e.g. 'eip155:80094'
  slug: string; // UNIQUE, e.g. 'berachain'
  name: string;
  family: 'evm' | 'svm' | 'move' | 'cosmos' | 'utxo' | 'other';
  aliases: readonly string[]; // including the legacy 'ethereum'/'solana' (R-59a)
  nativeSymbol: string | null;
  vendors: Readonly<Record<string, string | null>>; // NAMING, not coverage (§4.1, rule 4)
  rpcHosts: readonly string[] | null; // curated SSRF allowlist (§7.2)
  tvlUsdAtSync: number | null; // knowingly stale, only for list_chains
  deprecated: boolean;
}

export interface ChainRegistry {
  resolve(input: string): ChainInfo; // throws UnknownChainError with candidates
  tryResolve(input: string): ChainInfo | null;
  get(caip2: string): ChainInfo | null;
  list(filter?: ChainListFilter): ChainInfo[];
  size(): number;
}

export function loadChainRegistry(deps?: { data?: unknown }): ChainRegistry; // validates at startup
```

- **Resolution is a pure function with no network.** Order: exact `caip2` → `slug` → `aliases` →
  normalized form (lowercase, `[^a-z0-9]` collapsed). A miss raises `UnknownChainError` with
  candidates by Levenshtein distance over `slug ∪ aliases` (R-50c). A miss costs zero network calls
  and zero credits, which matters more than convenience: misses happen most often on the paid route,
  where an agent is guessing a chain name.
- **Indexes** (in memory, built once at load): `Map<caip2>`, `Map<slug>`, `Map<alias>`. Resolution
  is O(1) on an exact match. The O(n) "did you mean" path runs only while building an error. The
  458 rows are tens of kilobytes, so there is no scaling question here, and none is coming (even the
  2660 EVM chains of `chainid.network` would be single-digit megabytes).
- **Injection (`deps.data`)** is the same DI pattern as `CacheStore`/`BudgetStore`: tests load a
  small synthetic registry instead of the production one, touching no filesystem. The registry is a
  **factory, not a module singleton** (§8 already requires that of
  `CapabilityRegistry`/`SqliteCacheStore`).
- **Startup validation (R-60c):** `caip2`/`slug` uniqueness, global non-overlap of `aliases`, CAIP-2
  format, non-empty `name`. A violation throws at load, not on the first request. Degrading to an
  empty registry is forbidden (§4.2.1).

**Module: `scripts/sync-chain-registry.ts`** (dev-only, TASK-006, R-49)

- **Not part of the runtime build** and imported by no module under `src/` — it is a dev script the
  operator runs by hand (TASK-006 UC-4). A test asserts that `src/` contains no imports from
  `scripts/`; otherwise the offline gate (R-60a) could be broken unnoticed.
- **Sources and join keys** (all three keyless; live probe 2026-07-26, evidence in
  [raw/chain-registry-probe-2026-07-26.json](../onchain-analytics/raw/chain-registry-probe-2026-07-26.json)):

  | Source                             | Provides                                              | Join key                                                                                                |
  | ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | DeFiLlama `/v2/chains` (461)       | `name`, `tvlUsdAtSync`, `gecko_id`                    | — the base list                                                                                         |
  | CoinGecko `/asset_platforms` (461) | `coingecko` platform id, `chain_identifier` (EIP-155) | `defillama.gecko_id` → `coingecko.native_coin_id` (**235** matches, an explicit vendor cross-reference) |
  | `chainid.network` (2660)           | `nativeCurrency`, `rpcHosts` candidates               | `coingecko.chain_identifier` → `chainId` (**257 of 270**)                                               |

  The registry ends at **458** rows: the vendor catalogs list 461 each, and testnet rows are
  excluded after the join.

- **The fuzzy key (normalized name, 255 matches) is a fallback only, and it MUST be visible.** Rows
  glued by name land in a separate section of the diff report and require a commit confirmed by
  eye. A silent fuzzy join is exactly the class of error that later surfaces as "TVL of the wrong
  chain", with nothing left to find it by.
- **Determinism (R-49c):** stable sort by `caip2`, no timestamps **inside** the file (the sync date
  lives in a separate header meta field that changes only when the data actually changes), stable
  key order. The acceptance criterion is that two consecutive runs produce a byte-identical file.
- **Failure behaviour (R-49e):** if any of the three sources is unavailable, exit loudly with a
  non-zero code and **write no file**. A partially written registry is worse than a missing one: it
  passes validation and silently narrows the world.
- **Vanished chains (R-49f):** never deleted, marked `deprecated: true`. Deleting would break
  resolution of already-stored references, and "the chain died" is indistinguishable from "the
  vendor did not return it this time" from the outside.

**Module: `src/chain/coverage.ts`** (TASK-006, R-51)

Implements `covered(capability, chain)` from §4.2.3 — the composition of `routes` ×
`adapter.chainSupport()`. The text of `CapabilityNotCoveredOnChainError` is built here too: both
lists (chains for a capability, capabilities for a chain) are computed from those same two sources,
so they cannot drift away from actual behaviour.

**The call site is money-critical (R-51d).** The coverage check runs inside
`CapabilityRegistry.resolve()` **before** the adapter is touched — before the budget gate and
before HTTP. The gate order on a paid route:

```
resolve(capability, args)
  → 1. resolve chain against the registry  (no network, no money)
  → 2. check coverage of the pair          (no network, no money)
  → 3. cache lookup                        (no network, no money)
  → 4. adapter.isAvailable()               (no network, no money)
  → 5. budget gate: check + reserve        (money is reserved)
  → 6. adapter.fetch()                     (network, money is spent)
```

The coverage gate must sit **above** step 5. Growing the chain set from 2 to 458 multiplies the ways
to miss coverage, and if a miss cost a credit reservation, the expansion itself would become a
spending vector (NFR, TASK §7). This also removed a whole class of knowingly useless calls from the
paid path — part of the surface **SEC-1** described before the velocity guard existed. SEC-1 is
closed: credits per window, checked in the same transaction as the daily reservation (see "Two
second denominators" below).
