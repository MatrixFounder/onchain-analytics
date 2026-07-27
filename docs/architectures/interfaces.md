# 5. Интерфейсы

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 5.1. Внешние API — 5 MCP-tools (M1) + 3 MCP-tools (M2) + 2 MCP-tools (TASK-006)

`onchain_ping` (M0, не меняется, R-20) — см. v1.1 §5.1 (сохранено ниже в §5.1.1).

> **TASK-006 (R-50) — сквозное изменение контракта всех 7 chain-принимающих инструментов.**
> Литерал `chain: z.enum(['ethereum','solana'])`, повторённый в 7 файлах, заменяется на
> `ChainInputSchema` (§3.2): открытая строка + рантайм-резолв по реестру. Ниже по тексту
> сохранены исторические формулировки «сужен до 2 сетей» — они описывают **состояние M1/M2**;
> актуальная граница — реестр + матрица покрытия (§4.2.3), см. §5.1.3.

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

#### 5.1.2 Новые 3 (M2, TASK-005) — платные, Nansen-backed

```jsonc
// onchain_smart_money_flows — { chain: "ethereum"|"solana", tokenAddress: string (.max(64)) }
// → SmartMoneyFlow (§4.1) | isError: true при недоступности ключа/бюджета
// Capability: smart-money.flows (costOf() = 10cr фикс — netflow 5cr + tgm/holders 5cr, R-41)
// onchain_entity_label — {
//   chain: "ethereum"|"solana",
//   query?: string (.max(200)),        // по имени/символу/адресу, требуется если tokenAddress не задан
//   tokenAddress?: string (.max(64)),  // токен-scoped обогащение метками; обязателен при exhaustive
//   exhaustive?: boolean (default false), // opt-in эскалация — budget-gated, требует tokenAddress
// }
// → { chain, entities: EntityLabel[] (§4.1), source, fetchedAt } | isError: true
// Capability: entity.labels — costOf() трёхуровневый: 0cr (query-only) / 5cr (tokenAddress,
// !exhaustive) / 100cr (exhaustive:true — ТОЛЬКО /profiler/address/labels, не дублирует 5cr-путь)
// onchain_token_risk — { chain: "ethereum"|"solana", tokenAddress: string (.max(64)) }
// → TokenRiskScore (§4.1) | isError: true
// Capability: token.risk (costOf() = 6cr фикс — tgm/indicators 5cr + tgm/token-information 1cr, R-43)
```

`chain` — сужен до `z.enum(['ethereum','solana'])`, буквально та же пара, что 4 M1-tools (решение
по OQ-3, §3.2 — три релевантных Nansen-энумератора чейнов не идентичны друг другу, расширение —
задокументированный backlog, §11). `tokenAddress`/`query` — те же `.max()`-границы и
`superRefine`/`isValidAddress`-идиом, что `onchain_get_token` выше — переиспользуется, не
изобретается заново. `onchain_entity_label`'s input — единственный из 7 tools с `superRefine`,
требующим **хотя бы одно** из `query`/`tokenAddress` (иначе нет способа определить, что искать) и
`chain`+`tokenAddress` обязательны вместе, когда `exhaustive: true`.

**`_meta.budget` — видимость бюджета вызывающему (R-41 «аналог `_meta.cache`»):**

```ts
export interface BudgetMeta {
  provider: 'nansen';
  creditsUsedToday: number; // usage.credits_used текущего day-бакета ПОСЛЕ этого вызова
}
```

Присутствует **только** когда способность платная И реально исполнилась (`_meta.cache.status ===
'miss'` — на `'hit'` гейт/costOf()/сеть не исполняются вовсе, UC-5, поэтому `_meta.budget`
**отсутствует** целиком на кеш-хите, не коэрсится в `0`/`null` — тот же принцип, что
`_meta.cache.ageMs` на `'miss'`, §3.2). **Архитектурное решение (не через
`CapabilityRegistry.resolve()`'s возвращаемый тип — он общий для всех 10 адаптеров и не растёт ради
одного платного):** три новых tool-хендлера сами читают `budgetStore.getUsage('nansen',
dayBucketMs(Date.now()))` **отдельным** SQLite SELECT'ом ПОСЛЕ `registry.resolve()` вернул
результат — не часть gate-решения (которое уже случилось внутри `nansen.fetch()`, §3.2), чисто
для отображения. `BudgetStore` инжектируется в контекст этих 3 tool-хендлеров тем же способом,
что `registry` (task 003-7 паттерн, `GetTokenContext`-подобный интерфейс).

#### 5.1.3 Новые 2 (TASK-006) — бесплатные, реестр-backed

```jsonc
// onchain_list_chains — discovery, НОЛЬ сетевых вызовов (R-52b)
// {
//   query?: string (.max(64)),      // подстрока по slug / name / aliases
//   family?: "evm"|"svm"|"move"|"cosmos"|"utxo"|"other",
//   capability?: string (.max(64)), // вернуть только сети, где эта capability реально покрыта
//   minTvlUsd?: number,             // фильтр по tvlUsdAtRegistrySync — заведомо устаревшему
//   limit?: number (default 50, .max(200)),
// }
// → {
//     chains: Array<{ slug, caip2, name, family, nativeSymbol,
//                     capabilities: string[],           // покрытые на ЭТОЙ сети
//                     tvlUsdAtRegistrySync: number|null, // НЕ ответ на вопрос «какой TVL»
//                     deprecated: boolean }>,
//     total: number,        // сколько подошло под фильтр ДО применения limit
//     registrySyncedAt: number, // epoch-ms UTC — когда реестр синхронизировали
//   }
// onchain_chain_tvl — TVL СЕТИ (не протокола), DeFiLlama-backed, keyless
// { chain: ChainInput }
// → { chain, name, tvlUsd, source: "defillama", fetchedAt }
// Capability: chain.tvl
```

**Почему `onchain_chain_tvl` — отдельный инструмент, а не параметр `onchain_protocol_tvl`
(R-53b).** Сеть и протокол — разные сущности с разными источниками (`/v2/chains` против
`/protocol/{slug}`) и разными выходными контрактами: у протокола есть `totalTvlUsd` поверх всех
сетей, у сети такого понятия нет. Склейка их в один инструмент дала бы параметр, меняющий смысл
всех остальных полей, — это худшая форма перегрузки контракта. Форма результата следует прецеденту
`ProtocolTvlResult`: `tvlUsd: number` + отказ на non-finite/отрицательном значении **до** записи в
кеш (R-53c) — та же защита, что `defillama.normalize()` уже реализует.

**Почему `total` и дефолтный `limit` обязательны (R-52c).** Без них `onchain_list_chains({})`
вывалил бы в контекст модели 458 строк — то есть инструмент, созданный чтобы **сэкономить**
8.7k токенов схемы, тратил бы больше при первом же вызове. `total` сохраняет честность: агент
видит, что список урезан, и может сузить фильтр вместо того, чтобы решить, что сетей всего 50.

**Контракт параметра `chain` (R-50, все 9 chain-принимающих инструментов):**

```ts
// БЫЛО (в 7 файлах): chain: z.enum(['ethereum', 'solana'])
// СТАЛО (единый импорт, ноль литералов сетей в mcp-server):
chain: ChainInputSchema, // §3.2 — принимает slug | alias | caip2, отдаёт canonical caip2
```

- **Стоимость схемы:** ~5 токенов на параметр вместо ~1249. При 458 сетях закрытый енум стоил бы
  **≈8.7k токенов в каждом запросе к модели** (измерено, TASK §0) — это и есть причина решения
  владельца §1.3.1, а не эстетика.
- **Ошибка неизвестной сети (R-50c)** — tool-error, ноль сетевых вызовов, ноль кредитов:

  ```
  unknown chain 'beara'. Did you mean: berachain?
  Call onchain_list_chains to browse 458 chains.
  ```

- **Ошибка непокрытой пары (R-51c)** — отдельный тип, не сливается с «провайдер недоступен»:

  ```
  capability 'smart-money.flows' is not available on chain 'berachain'.
    Provider 'nansen' covers: ethereum, solana, base, …
    Available on berachain instead: chain.tvl, token.price, token.metadata, pairs.new
  ```

  Оба списка вычисляются из матрицы покрытия (§4.2.3), поэтому не могут разойтись с поведением.

**Обратная совместимость (R-59).** `"ethereum"` и `"solana"` остаются валидными **бессрочно** —
как алиасы, а не как переходный режим. Форма ответов не меняется. Единственное наблюдаемое
следствие — разовая холодная инвалидация кеша (§4.2.2), объявленная в changelog.

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

// M2 (TASK-005, minor M-1 review — этот блок раньше не обновлялся): три новых canonical-типа +
// единственная публично экспортируемая фабрика nansen (уже budget-gated внутри, §3.2 OQ-2 —
// НЕТ отдельного "сырого" экспорта) + BudgetStore-интерфейс/фабрика (тот же паттерн, что
// createCacheStore/CacheStore).
export { SmartMoneyFlowSchema, type SmartMoneyFlow };
export { EntityLabelSchema, type EntityLabel };
export { TokenRiskScoreSchema, type TokenRiskScore };
export { createNansenAdapter, type NansenAdapterDeps } from './adapters/nansen/index.js';
export { type BudgetStore } from './cache/budget-store.js';
export { createBudgetStore } from './cache/budget-store.js'; // фабрика, тот же принцип, что createCacheStore (§8)

// packages/mcp-server/src/server.ts — расширенная фабрика (transport-agnostic, D3, не меняется):
export function createServer(deps: {
  env: Env;
  version: string;
  registry?: CapabilityRegistry; // injectable для тестов (§3.2)
  budgetStore?: BudgetStore; // M2 — injectable тем же способом, что registry; используется 3 новыми
  // tool-хендлерами ТОЛЬКО для read-only `_meta.budget` (§5.1.2) — сам gate уже внутри nansen-адаптера
}): McpServer;
```

`registry` по умолчанию — единственная реальная сборка из `providers.config.ts` + `adapterRegistrations`
(строится один раз в `index.ts`, передаётся в `createServer`); тесты передают собственную реализацию
того же публичного контракта `resolve()`, собранную из фикстур (не мокая транспорт/сеть глобально).
`budgetStore` следует тому же правилу — по умолчанию реальный `SqliteBudgetStore` (M-2, §3.2),
тесты инжектируют in-memory/fixture-реализацию того же интерфейса.

### 5.3. Интеграции с внешними системами

| Провайдер (`adapter.id`) | Base host(s)                                                                     | Auth                                                                                             | Транспорт                              | Статус в M1                                           |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| `coingecko`              | `api.coingecko.com`, `pro-api.coingecko.com`                                     | опц. `COINGECKO_API_KEY` (demo-контур) / `COINGECKO_PRO_API_KEY` (Pro-контур → pro-хост, v2.2.1) | REST                                   | live                                                  |
| `dexscreener`            | `api.dexscreener.com`                                                            | none                                                                                             | REST                                   | live                                                  |
| `defillama`              | `api.llama.fi`                                                                   | none                                                                                             | REST                                   | live                                                  |
| `dune`                   | `api.dune.com`                                                                   | `DUNE_API_KEY` (free)                                                                            | REST (Query API)                       | **interface/stub, не вызывается** (F-2/minor)         |
| `rpc-evm`                | `ethereum-rpc.publicnode.com` (primary), `eth.drpc.org` (fallback)               | none                                                                                             | JSON-RPC over HTTP                     | live                                                  |
| `rpc-solana`             | `api.mainnet-beta.solana.com`                                                    | none                                                                                             | JSON-RPC over HTTP                     | live                                                  |
| `dash-platform`          | evonode host(s) — TBD, backlog §11                                               | none                                                                                             | gRPC                                   | **interface + fixture-контракт, не вызывается** (F-3) |
| `platform-explorer`      | `platform-explorer.pshenmic.dev`                                                 | none                                                                                             | REST                                   | live — единственный live Dash-источник M1             |
| `pg-history`             | из `ONCHAIN_PG_URL` (не hostname-allowlist — DSN сам является контролем доступа) | DSN (не логируется)                                                                              | Postgres wire (SELECT-only)            | live, опционально (R-12)                              |
| `nansen` (M2)            | `api.nansen.ai`                                                                  | `NANSEN_API_KEY` через заголовок `apiKey` (НЕ `Authorization: Bearer`)                           | REST (POST JSON, кроме `GET /account`) | live, платный — первый M2-адаптер (R-29)              |

Каждая строка — источник `hosts`-allowlist SSRF-гейта для **своего** адаптера (§3.2, §7); `dune` и
`dash-platform` регистрируют `hosts`/DSN-конфигурацию, но не совершают исходящих вызовов в M1.
`nansen` — десятая строка (M2, TASK-005) — единственный платный, бюджет-гейтуемый адаптер реестра;
`NANSEN_API_KEY` подчиняется тому же секретному контракту, что 5 ключей M1 (§7.2 ниже).
