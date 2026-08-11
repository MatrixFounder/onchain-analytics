# 6. Technology stack

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 6.1. Backend

The base is ADR-001 unchanged: TypeScript strict / Node 22 LTS, pnpm + tsup/tsx,
`@modelcontextprotocol/sdk`, zod. Runtime dependencies of `packages/core`, each with the reason it
is there:

- **`better-sqlite3`** — the persistent cache layer and the `usage` ledger in `DATA_DIR` (D6,
  §3.2/§4.2). Synchronous API, no connection pool, one file per installation.
- **`lru-cache`** — the hot in-process layer of the two-level cache (D6).
- **`ulid`** — application-generated ids as `TEXT` (DB-SCHEMA-CONCEPT §1: never rely on engine
  autoincrement).
- **`@noble/hashes`** — keccak256 for EIP-55 checksums, and nothing else. The single reason: D5
  requires checksummed addresses, not lowercase. Pulling `viem` or `ethers` in whole for one hash
  function is not a trade this codebase makes.
- **`bs58`** — base58 decode/validate for Solana addresses (`chain/address.ts`).
- **`pg`** — read-only Postgres client, used exclusively by the `pg-history` adapter (R-12).

`@grpc/grpc-js` and `@grpc/proto-loader` are deliberately **absent**: `dash-platform` ships as an
interface plus a fixture contract, with no live `fetch()` (§3.2), so there is no gRPC client to
configure. Both dependencies return together with the deferred backlog task for the live DAPI
transport (§11) — not before.

Two later milestones cost nothing in supply-chain surface:

- **M2 (paid Nansen layer): zero new npm dependencies.** The adapter, the budget gate, the usage
  ledger and the cost table are all built on `better-sqlite3` + `zod`, which were already there.
- **TASK-006 (chain registry, 458 chains): zero new dependencies.** It added exactly one manifest
  line — the `sync:chains` script, run through the `tsx` that `packages/core` already had as a dev
  dependency.

### 6.2. Frontend

N/A — unchanged since M0.

### 6.3. Database

**Cache and usage ledger:** `better-sqlite3` in `DATA_DIR` (§3.2/§4.2) — engine-local, not Postgres
(kickoff decision, §1 item 2 plus the annotation to the D6 addendum). The same file holds the
`cache_entries` table and the `usage` table the budget gate reads before every paid call.

**Optionally readable** Postgres (Supabase, schema `onchain`) — only for Dash Platform history
(R-12, via the `pg-history` adapter, §3.2). It is someone else's database: the engine neither
creates nor migrates it.

### 6.4. Infrastructure

**Monorepo layout** (`packages/core` + `packages/mcp-server`, as built through M2 and TASK-006):

```
onchain-analytics/
├─ pnpm-workspace.yaml                    # packages/* + allowBuilds.esbuild
├─ package.json                           # root scripts: lint, typecheck, test, build,
│                                         #   verify:provenance, eval
├─ tsconfig.base.json                     # both packages extend it
├─ eslint.config.js                       # resolved upward by both packages
├─ .prettierrc / .prettierignore
├─ .githooks/pre-commit                   # runs verify-provenance (RF-2) before every commit
├─ .github/workflows/ci.yml               # §10.2 — core build precedes typecheck/test
├─ scripts/
│  └─ verify-provenance.mjs               # RF-2 — recomputes docs/provenance.json path→sha256
├─ packages/
│  ├─ core/
│  │  ├─ package.json                     # name: @onchain-intel/core, private, Apache-2.0
│  │  ├─ tsconfig.json                    # extends ../../tsconfig.base.json; include src+test
│  │  ├─ tsconfig.build.json              # extends ./tsconfig.json; include src, rootDir src
│  │  ├─ .prettierignore                  # dist (CWD-relative lookup — same pattern as mcp-server)
│  │  ├─ src/
│  │  │  ├─ types/                        # canonical zod schemas (D5): chain, token, wallet, pool,
│  │  │  │                                #   ohlcv, snapshot, entity-label, smart-money-flow,
│  │  │  │                                #   token-risk-score
│  │  │  ├─ chain/                        # the chain layer (TASK-006)
│  │  │  │  ├─ registry.data.json         # committed snapshot of 458 chains — the offline gate
│  │  │  │  ├─ registry-core.ts           # buildChainRegistry(): pure logic + lookup indexes
│  │  │  │  ├─ registry.ts                # binds the logic to the shipped snapshot, memoized
│  │  │  │  ├─ input-schema.ts            # `chain` as accepted at the tool boundary (R-50)
│  │  │  │  ├─ coverage.ts                # capability × chain coverage matrix (R-51)
│  │  │  │  ├─ address.ts                 # normalizeAddress / isValidAddress / hasAddressValidator
│  │  │  │  └─ errors.ts                  # UnknownChainError / ChainRegistryLoadError
│  │  │  ├─ adapters/
│  │  │  │  ├─ types.ts                   # ProviderAdapter, CapabilityDescriptor, chainSupport()
│  │  │  │  ├─ registry.ts                # CapabilityRegistry
│  │  │  │  ├─ cache-store.ts             # CacheStore / CacheGetResult ports
│  │  │  │  ├─ dash-metrics.ts            # shared Dash metric vocabulary — ids reused verbatim
│  │  │  │  │                             #   from the n8n snapshotter, not invented here
│  │  │  │  ├─ not-implemented-error.ts   # loud failure for the stubbed dune/dash-platform paths
│  │  │  │  ├─ stringify-truncated.ts     # bounded error text — never embed a whole raw envelope
│  │  │  │  ├─ truncate-vendor-text.ts    # caps vendor-authored strings entering canonical entities
│  │  │  │  ├─ coingecko/                 # live
│  │  │  │  ├─ dexscreener/               # live
│  │  │  │  ├─ defillama/                 # live
│  │  │  │  ├─ dune/                      # interface/config stub — no live Query API path
│  │  │  │  ├─ rpc-evm/                   # live
│  │  │  │  ├─ rpc-solana/                # live, single confirmed host (§11)
│  │  │  │  ├─ dash-platform/             # interface + fixture contract; fetch() stubbed,
│  │  │  │  │                             #   isAvailable() always false; no proto/ vendored yet
│  │  │  │  ├─ platform-explorer/         # the only live Dash source
│  │  │  │  ├─ pg-history/                # read-only PG adapter over pg/read-client.ts (R-12)
│  │  │  │  └─ nansen/                    # the paid provider (M2)
│  │  │  │     ├─ index.ts                # createNansenAdapter() — the only exported factory
│  │  │  │     ├─ budget-gate.ts          # ceiling check before any paid call (R-37)
│  │  │  │     ├─ account-state.ts        # /account anchor snapshot incl. usageAtObserve
│  │  │  │     ├─ reconcile.ts            # reconciliation + the unreconciled flag (R-38)
│  │  │  │     ├─ singleflight.ts         # dedup of concurrent misses on one args_hash (R-39)
│  │  │  │     ├─ cost-of.ts              # per-call credit price, incl. the premium surcharge
│  │  │  │     ├─ cost-table.ts           # GENERATED from the committed OpenAPI spec
│  │  │  │     ├─ chain-coverage.ts       # GENERATED per-capability chain lists (R-58)
│  │  │  │     ├─ endpoints.ts            # capability → endpoint/method mapping
│  │  │  │     └─ normalize.ts            # vendor DTO → canonical types (anti-corruption layer)
│  │  │  ├─ cache/                        # sqlite-store, lru, two-level-store, ddl, ttl, stats,
│  │  │  │                                #   data-dir, day-bucket, budget-store (usage ledger, M2)
│  │  │  ├─ net/                          # safe-fetch (SSRF gate), rate-limit, args-hash
│  │  │  ├─ pg/
│  │  │  │  └─ read-client.ts             # used only by adapters/pg-history/, not a side channel
│  │  │  ├─ providers.config.ts           # routes + adapterRegistrations (12 adapters)
│  │  │  └─ index.ts                      # public re-export surface (§5.2)
│  │  ├─ test/                            # 876 tests
│  │  │  ├─ fixtures/<adapter>/*.json     # committed (D11), each with a *.evidence.md sibling
│  │  │  ├─ fixtures/chain-registry*/     # vendor catalog fixtures for the offline sync test
│  │  │  ├─ *.contract.test.ts            # per adapter with a fixture/mock path (not `dune`)
│  │  │  └─ …                             # registry, coverage, cache, budget/velocity, ssrf,
│  │  │                                   #   rate-limit, provenance, paid-route-safety
│  │  └─ scripts/                         # dev-only: nothing under src/ imports them, CI never runs them
│  │     ├─ sync-chain-registry.ts        # regenerates chain/registry.data.json from 3 keyless catalogs
│  │     ├─ gen-nansen-coverage.ts        # derives nansen/chain-coverage.ts from the committed spec
│  │     ├─ generate-nansen-cost-table.mjs # derives nansen/cost-table.ts from x-credit-cost
│  │     └─ record-fixture.mjs            # exactly one live call → fixture + evidence file
│  └─ mcp-server/
│     ├─ package.json                     # + "@onchain-intel/core": "workspace:*"
│     ├─ src/
│     │  ├─ index.ts                      # bin; the single transport choice (stdio, D3)
│     │  ├─ server.ts                     # createServer({env,version,registry?}) — registry injectable
│     │  ├─ env.ts                        # zod env schema (D10)
│     │  └─ tools/                        # 19 registered tools + 2 shared helpers
│     │     ├─ ping.ts                    # unchanged since M0 (R-20)
│     │     ├─ get-token.ts               # M1
│     │     ├─ wallet-balances.ts         # M1
│     │     ├─ new-pairs.ts               # M1
│     │     ├─ protocol-tvl.ts            # M1
│     │     ├─ smart-money-flows.ts       # M2, paid
│     │     ├─ entity-label.ts            # M2, paid
│     │     ├─ token-risk.ts              # M2, paid
│     │     ├─ list-chains.ts             # TASK-006 — the discovery tool for an open `chain` string
│     │     ├─ chain-tvl.ts               # TASK-006
│     │     ├─ resolve-capability.ts      # shared _meta.cache resolution helper (§5.1)
│     │     └─ budget-meta.ts             # shared _meta.budget shape (§5.1.2)
│     ├─ test/                            # 285 tests: e2e.stdio (SPAWN), e2e.inprocess
│     │                                   #   (InMemoryTransport), per-tool, degradation, wiring
│     ├─ eval/                            # live eval harness over the free tier (run.mjs, probes.json)
│     └─ scripts/
│        └─ smoke-dist.mjs                # dependency-free smoke test of the shipped dist/index.js
├─ n8n-workflows/ · sql/                  # the snapshotter — a separate system, permanently
└─ docs/
```

**`packages/core/package.json` (key fields):**

```jsonc
{
  "name": "@onchain-intel/core",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json", // no tsup — plain tsc sidesteps the M0 dts bug entirely
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "sync:chains": "tsx scripts/sync-chain-registry.ts", // dev-only, never invoked at runtime
  },
  "dependencies": {
    "@noble/hashes": "^1.8.0",
    "better-sqlite3": "^11.10.0",
    "bs58": "^6.0.0",
    "lru-cache": "^11.5.2",
    "pg": "^8.22.0",
    "ulid": "^2.4.0",
    "zod": "^4.4.3",
    // @grpc/grpc-js + @grpc/proto-loader are NOT here: dash-platform is an interface plus a
    // fixture contract, live gRPC fetch is unimplemented. Both arrive with the deferred
    // backlog task for the live DAPI transport (§11).
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.20.1",
    "@types/pg": "^8.20.0",
    "tsx": "^4.23.1",
    "typescript": "~6.0.3", // same pin as mcp-server — one TS6 line across the workspace;
    // tilde, so the range cannot exceed typescript-eslint's peer <6.1.0
    "vitest": "^4.1.10",
  },
}
```

**Build topology.** `mcp-server` depends on `@onchain-intel/core` through `workspace:*`, so
`pnpm -r build` / `pnpm -r test` build `core` before `mcp-server`. This is confirmed by the output
order of a live `pnpm -r build`, not inferred from pnpm's documented default. CI additionally runs
`pnpm --filter @onchain-intel/core build` explicitly before `typecheck`/`test` (§10.2), so the
declaration files consumed across the package boundary exist regardless of topology.

**Containerization / deployment:** out of scope, FUTURE (M6).
