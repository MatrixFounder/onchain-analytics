# 6. Технологический стек

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 6.1. Backend

Без изменений в базе (TS strict / Node 22 LTS, pnpm + tsup/tsx, `@modelcontextprotocol/sdk`, zod).
**Новые в `packages/core` (M1):** `better-sqlite3`, `lru-cache`, `ulid`, `@noble/hashes` (keccak256
для EIP-55 — единственная причина: D5 требует checksum, не lowercase), `bs58` (base58 decode/
validate), `pg` (read-only PG-клиент, используется `pg-history`-адаптером). Обоснование каждой —
§3.2 (не `viem`/`ethers` целиком ради одной checksum-функции — Zero-Dependency, architecture-design
skill).

**Убрано из M1-зависимостей (F-3, ревью цикл 1):** `@grpc/grpc-js` + `@grpc/proto-loader` — были в
v2 для живого DAPI-транспорта; `dash-platform` в v2.1 сужен до interface + fixture-контракта
(§3.2), живого `fetch()` в M1 нет, поэтому и gRPC-клиент не нужен в M1. Обе зависимости возвращаются
вместе с отложенной backlog-задачей живого gRPC-транспорта (§11) — не раньше.

### 6.2. Frontend

N/A — без изменений (M0).

### 6.3. Database

**Кеш (M1):** `better-sqlite3` в `DATA_DIR` (см. §3.2/§4.2) — движко-локальный, не Postgres
(кикофф-решение, §1 п.2 + аннотация к D6 addendum). **Опционально читаемый** Postgres (Supabase,
схема `onchain`) — только для истории Dash Platform (R-12, через `pg-history`-адаптер, §3.2),
чужая БД, движок её не создаёт/не мигрирует.

### 6.4. Инфраструктура

**Монорепо-раскладка (M1 — добавляет `packages/core`, `packages/mcp-server` расширяется):**

```
onchain-analytics/
├─ pnpm-workspace.yaml                 # без изменений: packages/* + allowBuilds.esbuild
├─ package.json                        # без изменений (root scripts)
├─ tsconfig.base.json                  # без изменений — обе пакета его extend'ят
├─ eslint.config.js                    # без изменений — резолвится upward обоими пакетами
├─ .prettierrc / .prettierignore       # без изменений
├─ .github/workflows/ci.yml            # см. §10.2 — шаги те же, порядок доп. пакета учтён
├─ packages/
│  ├─ core/                            # НОВЫЙ (M1)
│  │  ├─ package.json                  # name: @onchain-intel/core, private, Apache-2.0
│  │  ├─ tsconfig.json                 # extends ../../tsconfig.base.json; include src+test
│  │  ├─ tsconfig.build.json           # extends ./tsconfig.json; include src, rootDir src
│  │  ├─ .prettierignore               # dist (CWD-relative lookup — тот же паттерн, что mcp-server)
│  │  ├─ src/
│  │  │  ├─ types/                     # ChainSchema, Token, Wallet, Balance, Pool, OHLCV, Snapshot
│  │  │  ├─ chain/
│  │  │  │  └─ address.ts              # normalizeAddress / isValidAddress
│  │  │  ├─ adapters/
│  │  │  │  ├─ types.ts                # ProviderAdapter, CapabilityDescriptor
│  │  │  │  ├─ registry.ts              # CapabilityRegistry
│  │  │  │  ├─ coingecko/
│  │  │  │  ├─ dexscreener/
│  │  │  │  ├─ defillama/
│  │  │  │  ├─ dune/                    # interface/config-stub в M1 — fetch()/normalize() не реализованы (F-2/minor)
│  │  │  │  ├─ rpc-evm/
│  │  │  │  ├─ rpc-solana/
│  │  │  │  ├─ dash-platform/           # interface + fixture-контракт в M1 — fetch() stub, isAvailable() всегда false (F-3)
│  │  │  │  │                           #   нет proto/ в M1 — вендоринг живого .proto приходит с backlog-задачей §11
│  │  │  │  ├─ platform-explorer/       # единственный live Dash-источник M1
│  │  │  │  └─ pg-history/              # NEW (F-2) — ProviderAdapter поверх pg/read-client.ts, R-12
│  │  │  ├─ cache/                     # store.ts, lru.ts, key.ts, stats.ts
│  │  │  ├─ net/                       # safe-fetch.ts, rate-limit.ts
│  │  │  ├─ pg/
│  │  │  │  └─ read-client.ts          # используется только adapters/pg-history/, не side-channel
│  │  │  ├─ providers.config.ts        # routes + adapterRegistrations (9 адаптеров)
│  │  │  └─ index.ts                   # публичный реэкспорт (§5.2)
│  │  ├─ test/
│  │  │  ├─ fixtures/<adapter>/*.json  # закоммичены (D11) — все, кроме `dune` (F-2/minor, нет live-пути в M1)
│  │  │  ├─ *.contract.test.ts         # по адаптеру, где есть fixture/mock-путь (не `dune`)
│  │  │  ├─ registry.fallback.test.ts
│  │  │  ├─ cache.test.ts
│  │  │  ├─ safe-fetch.test.ts
│  │  │  ├─ rate-limit.test.ts
│  │  │  └─ chain-address.test.ts
│  │  └─ scripts/
│  │     └─ record-fixture.mjs         # ручной, вне CI (R-22)
│  └─ mcp-server/                      # M0, расширяется
│     ├─ package.json                  # + "@onchain-intel/core": "workspace:*"
│     ├─ src/
│     │  ├─ index.ts                   # без изменений в контракте (bin, единственный transport-выбор)
│     │  ├─ server.ts                  # createServer({env,version,registry?}) — registry injectable
│     │  ├─ env.ts                     # + 4 опц. ключа (§3.2)
│     │  └─ tools/
│     │     ├─ ping.ts                 # не меняется (R-20)
│     │     ├─ get-token.ts            # NEW
│     │     ├─ wallet-balances.ts      # NEW
│     │     ├─ new-pairs.ts            # NEW
│     │     └─ protocol-tvl.ts         # NEW
│     └─ test/
│        ├─ env.test.ts / ping.test.ts     # без изменений
│        ├─ e2e.stdio.test.ts              # SPAWN — tools/list===5 + ping only (F-1)
│        └─ e2e.inprocess.test.ts          # NEW — InMemoryTransport, 4 tools, fixture registry (F-1)
├─ n8n-workflows/ · sql/               # без изменений, отдельная система
└─ docs/
```

**`packages/core/package.json` (ключевые поля):**

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
    "build": "tsc -p tsconfig.build.json", // без tsup — plain tsc, обходит dts-баг M0 целиком
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
  },
  "dependencies": {
    "zod": "^4.4.3",
    "better-sqlite3": "^11",
    "lru-cache": "^11",
    "ulid": "^2",
    "@noble/hashes": "^1",
    "bs58": "^6",
    "pg": "^8",
    // @grpc/grpc-js + @grpc/proto-loader — НЕ здесь в M1 (F-3, ревью цикл 1): dash-platform
    // сужен до interface + fixture-контракт, живой gRPC-fetch не реализован; обе зависимости
    // приходят вместе с отложенной backlog-задачей живого DAPI-транспорта (§11).
  },
  "devDependencies": {
    "typescript": "^6.0.3", // тот же пин, что mcp-server — единый TS6-line (см. M0 .AGENTS.md)
    "vitest": "^4.1.10",
    "@types/node": "^22",
    "@types/pg": "^8",
    "@types/better-sqlite3": "^7",
  },
}
```

> Версии — реалистичные мажоры, не резолвленные `pnpm add` (в отличие от уже установленных M0
> зависимостей выше в §mcp-server) — точные minor/patch фиксируются в Development.

`pnpm -r build`/`test`: `mcp-server` зависит от `@onchain-intel/core` через `workspace:*` →
pnpm-топология по умолчанию строит `core` раньше `mcp-server` — **предположение, подлежащее
эмпирической проверке в Development** (тот же стиль верификации, что M0 `.AGENTS.md` уже
практикует для tsup/tsc-квирков), не гарантия, зафиксированная здесь как факт.

**Контейнеризация/деплой:** без изменений от v1.1 — вне скоупа, FUTURE (M6).
