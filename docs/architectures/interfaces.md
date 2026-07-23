# 5. Интерфейсы

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 5.1. Внешние API — 5 MCP-tools

`onchain_ping` (M0, не меняется, R-20) — см. v1.1 §5.1 (сохранено ниже в §5.1.1).

**Новые 4 (M1), input/output — уровень контракта, не буквальный код:**

```jsonc
// onchain_get_token — { chain: "ethereum"|"solana", address: string (.max(64)) }
// → Token (§4.1) | isError: true при недоступности/невалидном адресе
// (chain сужен до 2 сетей, TASK.md UC-2 сам ограничивает M1-tools ethereum+solana; 'dash'
// остаётся в ChainSchema/Token для консистентности словаря, но ни один M1-tool его не принимает
// на входе — см. также WalletBalancesInputSchema ниже, Major-2 ревью цикла 1)
// Capability: token.price (переключено с token.metadata в цикле 3 — normalize() coingecko даёт
// побайтово идентичный Token по обоим маршрутам, но кешируется под TTL самой волатильной
// составляющей: 60с price, а не 3600с metadata — иначе priceUsd легально мог протухнуть до часа;
// маршрут token.metadata остаётся зарегистрированным для будущих metadata-only потребителей)
// onchain_wallet_balances — { chain: "ethereum"|"solana", address: string (.max(64)) }
// → Wallet (§4.1, balances: Balance[] — только assetType:'native' в M1)
// onchain_new_pairs — { chain: "ethereum"|"solana", limit?: number }
// → { chain, pairs: Pool[], source, fetchedAt }
// (limit-дефолт материализуется ДО построения args — post-M1 polish, fix 1: раньше опущенный
// limit и явный limit:10 давали разные deriveArgsHash-ключи для одного и того же логического
// запроса, что дублировало апстрим-фетч вместо одного общего кеш-попадания)
// onchain_protocol_tvl — { chain: "ethereum"|"solana", protocolSlug: string (.max(128)) }
// → { protocol, chain, tvlUsd, totalTvlUsd, source, fetchedAt }
```

`address`/`protocolSlug` — явные `.max()`-границы (адверсариальный цикл 2, finding 3 + post-M1
polish, fix 2): `address.max(64)` (реальный EVM-адрес ≤42, Solana base58-pubkey ≤44) с
дополнительной length-guard-проверкой в начале `superRefine` (гарантирует, что дорогой
`isValidAddress`/`bs58.decode` пропускается целиком для патологически длинного входа, а не просто
«в итоге отклоняется» уже после его выполнения); `protocolSlug.max(128)` — дешёвый отсеч на уровне
схемы до того, как значение попадёт в URL/кеш-ключ. `onchain_protocol_tvl`'s хендлер использует
`safeParse` (не `parse`) при валидации ответа провайдера — сбой возвращает `{ok:false, reason}` по
контракту, никогда не бросает (цикл 2, finding 1a); `defillama.normalize()` со своей стороны уже
отвергает non-finite/negative `tvlUsd`/`totalTvlUsd` до попадания в кеш (finding 1b).

Каждый ответ несёт `_meta.cache: { status: 'hit'|'miss', ageMs?, provider, capability }` (§3.2) —
вне `structuredContent`, схема выхода не растёт.

`chain`+`address`-входы валидируются через общий idiom:

```ts
// chain сужен до z.enum(['ethereum','solana']) — НЕ полный ChainSchema (Major-2, ревью цикл 1):
// isValidAddress()/normalizeAddress() не реализуют валидацию Dash-адресов (§4.1 — dash-platform
// работает через Snapshot, не Wallet/Balance), поэтому 'dash' здесь был бы принимаемым, но
// гарантированно проваливающим superRefine значением — вводящий в заблуждение контракт.
export const WalletBalancesInputSchema = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
    address: z.string().min(1).max(64), // .max() cap — adversarial cycle 2, finding 3
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

Ошибки — MCP tool-error (`isError: true`), не падение процесса (UC-2 alt, унаследовано от M0
§7.3-инварианта: невалидный вход/недоступная способность никогда не крашит сервер).

#### 5.1.1 `onchain_ping` (M0, сохранено без изменений)

```jsonc
// tools/call { name: "onchain_ping", arguments: {} }
// → { "ok": true, "service": "onchain-intel-mcp-server", "version": "0.1.0", "ts": 1784000000000 }
```

### 5.2. Внутренние интерфейсы

```ts
// packages/core — публичный API пакета (реэкспорт из src/index.ts)
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

// packages/mcp-server/src/server.ts — расширенная фабрика (transport-agnostic, D3, не меняется):
export function createServer(deps: {
  env: Env;
  version: string;
  registry?: CapabilityRegistry; // injectable для тестов (§3.2)
}): McpServer;
```

`registry` по умолчанию — единственная реальная сборка из `providers.config.ts` + `adapterRegistrations`
(строится один раз в `index.ts`, передаётся в `createServer`); тесты передают собственную реализацию
того же публичного контракта `resolve()`, собранную из фикстур (не мокая транспорт/сеть глобально).

### 5.3. Интеграции с внешними системами

| Провайдер (`adapter.id`) | Base host(s)                                                                     | Auth                     | Транспорт                   | Статус в M1                                           |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------ | --------------------------- | ----------------------------------------------------- |
| `coingecko`              | `api.coingecko.com`, `pro-api.coingecko.com`                                     | опц. `COINGECKO_API_KEY` | REST                        | live                                                  |
| `dexscreener`            | `api.dexscreener.com`                                                            | none                     | REST                        | live                                                  |
| `defillama`              | `api.llama.fi`                                                                   | none                     | REST                        | live                                                  |
| `dune`                   | `api.dune.com`                                                                   | `DUNE_API_KEY` (free)    | REST (Query API)            | **interface/stub, не вызывается** (F-2/minor)         |
| `rpc-evm`                | `ethereum-rpc.publicnode.com` (primary), `eth.drpc.org` (fallback)               | none                     | JSON-RPC over HTTP          | live                                                  |
| `rpc-solana`             | `api.mainnet-beta.solana.com`                                                    | none                     | JSON-RPC over HTTP          | live                                                  |
| `dash-platform`          | evonode host(s) — TBD, backlog §11                                               | none                     | gRPC                        | **interface + fixture-контракт, не вызывается** (F-3) |
| `platform-explorer`      | `platform-explorer.pshenmic.dev`                                                 | none                     | REST                        | live — единственный live Dash-источник M1             |
| `pg-history`             | из `ONCHAIN_PG_URL` (не hostname-allowlist — DSN сам является контролем доступа) | DSN (не логируется)      | Postgres wire (SELECT-only) | live, опционально (R-12)                              |

Каждая строка — источник `hosts`-allowlist SSRF-гейта для **своего** адаптера (§3.2, §7); `dune` и
`dash-platform` регистрируют `hosts`/DSN-конфигурацию, но не совершают исходящих вызовов в M1.
