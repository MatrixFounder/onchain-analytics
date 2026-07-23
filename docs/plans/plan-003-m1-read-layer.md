# PLAN — TASK-003 · M1: MVP read-слой, только free (`m1-read-layer`)

| Поле             | Значение                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| **Task**         | [TASK-003 `m1-read-layer`](TASK.md) — APPROVED, R-1…R-28                                               |
| **Architecture** | [ARCHITECTURE.md](ARCHITECTURE.md) — v2.1, APPROVED (THE design source)                                |
| **ADR**          | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — Accepted (D4–D7, D10–D12)           |
| **DB-схема**     | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 — применена к кеш-БД                 |
| **Статус плана** | Draft (готов к Development-фазе)                                                                       |
| **Дата**         | 2026-07-22                                                                                             |
| **Стратегия**    | Stub-First (dev-задачи: Phase 1 структура/стабы/red → Phase 2 логика/green), атомарная нарезка 8 задач |

---

## 0. Стратегия и границы

M1 — первый содержательный инженерный срез: движок отвечает на реальные ончейн-вопросы **без единого
платного ключа** ($0). План строго следует [ARCHITECTURE.md](ARCHITECTURE.md) v2.1 (§3.2 — раскладка
и компоненты, §5 — интерфейсы, §10.2 — CI, §11 — planner-facing items). Реализуется ровно то, что в
скоупе TASK.md §3; всё из §4 (платные провайдеры, budget-guard, snapshot-write, планировщик, HTTP-
транспорт, watchlists) **не трогается** (сквозной guard R-27).

**Ключевые инженерные решения (из APPROVED-ревью-заметок и ARCHITECTURE v2.1 — обязательны):**

1. **`packages/core` — новый библиотечный пакет** (OQ-3, ARCHITECTURE §3.1): канонические типы,
   chain/address, Adapter+Registry, 9 адаптеров, двухуровневый кеш, SSRF+rate-limit, read-only
   PG-клиент. Собирается **plain `tsc -p tsconfig.build.json`** (без tsup — обходит dts-баг M0 целиком).
   `mcp-server` получает `workspace:*`-зависимость на `@onchain-intel/core`.
2. **PG-клиент = `pg` (node-postgres) + `@types/pg`** — ровно как выбрала ARCHITECTURE §6.1/§3.2
   (`pg.Pool`, ленивый, SELECT-only). **НЕ** `postgres`/postgres.js. Dedup-guard закрыт.
3. **`CapabilityRegistry.resolve()` реализует `isAvailable() === false` → skip-to-next** (согласование
   §3.2 docstring ↔ §9.1): недоступный адаптер (нет ключа/DSN, или заведомо-`false` как `dash-platform`/
   `dune`) пропускается, маршрут идёт к следующему `adapterId`; при ошибке `fetch()`/`normalize()`
   текущего — тоже переход к следующему; если все недоступны — `CapabilityUnavailableError` со списком
   `(adapterId, reason)`, а не тихий пустой ответ (R-11, R-24).
4. **ВСЕ 4 tool-input-схемы сужают `chain` до `z.enum(['ethereum','solana'])`** там, где `chain`
   применим (не только `wallet_balances`); `dash` в 4 tools не принимается — dash-платформа покрыта
   только contract-тестами Capability Registry, а не MCP-tool'ами (ARCHITECTURE §5.1 Major-2).
5. **OQ-1 РЕШЁН архитектурой:** backend `onchain_wallet_balances` = keyless RPC-адаптеры `rpc-evm`
   (ethereum) + `rpc-solana` (solana), только `assetType:'native'`. Живой пробник подтвердил:
   `ethereum-rpc.publicnode.com` ✓, `eth.drpc.org` ✓ (fallback), `api.mainnet-beta.solana.com` ✓.
   `llamarpc`/`cloudflare-eth` — **DOWN, не использовать**. ERC-20/SPL — вне M1 (см. §5 ниже).
6. **R-8 (Dune) сужен до interface/config-stub** (ARCHITECTURE §3.2 «dune», §11): `capabilities()`
   объявляет `token.holders`, `fetch()`/`normalize()`/фикстуры/теста **нет** в M1, `isAvailable()`
   безусловно `false`. Planner **принимает** это как обновлённый scope R-8 для M1 (ýже буквальной
   acceptance-формулировки R-8 в TASK.md; резолюция одобрена ревью архитектуры явно, F-2/minor).
7. **`dash-platform` сужен до interface + fixture-контракта** (ARCHITECTURE §3.2, F-3): `fetch()` —
   stub, `isAvailable()` безусловно `false`, `@grpc/*` **НЕ** входят в M1-зависимости. Живой gRPC —
   backlog (§5 «Отложено»). `platform-explorer` — **единственный live Dash-источник M1**.

**Дисциплина коммитов:** dev-задачи **ничего не коммитят и не пушат**. Коммит/пуш и реальный прогон
CI — **только по явной команде оркестратора на гейтах** (как в M0).

**Окружение (проверено):** локально Node **v24.15.0** (ок — `engines.node >=22` декларирует минимум),
CI пиннит **Node 22**; **pnpm 11.15.1** через `corepack`. `packages/*` уже покрыт `pnpm-workspace.yaml`
(новый `packages/core` подхватывается автоматически). Root-скрипты `typecheck`/`test`/`build`
фан-аутят через `pnpm -r` → **топологический порядок `core` → `mcp-server` подлежит эмпирической
проверке** (§11, задачи 003-1 и 003-8). **`better-sqlite3` — нативный addon:** в `pnpm-workspace.yaml`
уже есть `allowBuilds.esbuild: true` → в задаче 003-3 добавляется `allowBuilds.better-sqlite3: true`
(иначе pnpm 11 блокирует build-скрипт).

**Acceptance-сниппеты — дисциплина RF-1 (R-28, обязательна во всех задачах):** на macOS zsh + pnpm 11
**запрещены** (а) bare `timeout` (нет бинаря на stock macOS) и (б) `pnpm test -- --flag` (pnpm 11
форвардит `--` буквально → vitest ест `--reporter` как позиционный фильтр). Разрешённые формы:
целый сьют — `pnpm --filter <pkg> test`; один файл/флаг — `pnpm --filter <pkg> exec vitest run <path>`
(бинарь вызывается напрямую, без `--`-форвардинга). Каждый сниппет прогоняется вручную на macOS перед
фиксацией в task-файле.

---

## 1. Граф задач (DAG)

```
003-1  core scaffold + canonical types + chain/address                          (dev)
  └─► 003-2  ProviderAdapter iface + Registry + providers.config + SSRF + rate-limit   (dev)
        ├─► 003-3  two-level cache (lru+sqlite DATA_DIR) + metrics counters            (dev)
        ├─► 003-4  live adapters A: coingecko+dexscreener+defillama + fixtures + golden (dev)
        │            └ создаёт скелет scripts/record-fixture.mjs
        └─► 003-5  live adapters B: rpc-evm+rpc-solana+platform-explorer(+history)
                     + dash-platform stub + dune config-stub + pg-history              (dev)
              └─► 003-6  env-расширение + graceful degradation                         (dev)
                    └─► 003-7  4 MCP-tools + e2e.inprocess + spawn-e2e→5               (dev)
                          └─► 003-8  integration verify + CI/smoke + exit              (verify)

Доп. (не-древесные) рёбра — над деревом:
  003-3 ─► 003-5   (реальный кеш для сквозного resolve() в registry.fallback.test.ts)
  003-4 ─► 003-5   (record-fixture.mjs skeleton, здесь расширяется живыми вызовами)
  003-2 ─► 003-6   (CapabilityUnavailableError)
  003-4 ─► 003-7   (фикстуры батча A для fixtureRegistry)
```

Зависимости (топология исполнения — авторитетный список; диаграмма выше — читаемое приближение):

- **003-1** — root (расширяет M0; зависимостей внутри M1 нет).
- **003-2** — зависит от **003-1** (`ChainSchema`, канонические типы; `CacheStore`-интерфейс
  объявляется здесь, реализация — 003-3).
- **003-3** — зависит от **003-2** (`adapterRegistrations` для bootstrap `providers`; `CacheStore`-контракт).
- **003-4** — зависит от **003-2** (`ProviderAdapter`, `providers.config.ts`, `safeFetch`);
  создаёт скелет `scripts/record-fixture.mjs`.
- **003-5** — зависит от **003-2**, **003-3** (реальный кеш нужен `registry.fallback.test.ts` для
  сквозного `resolve()`) и **003-4** (скелет `scripts/record-fixture.mjs` — 003-5 расширяет его живыми
  вызовами для rpc-evm/rpc-solana/platform-explorer).
- **003-6** — зависит от **003-2** (`CapabilityUnavailableError`) и **003-5** (`isAvailable()`-reasons
  адаптеров для доказательства деградации).
- **003-7** — зависит от **003-4** и **003-5** (fixtureRegistry строится из фикстур обоих батчей) и
  **003-6** (env).
- **003-8** — зависит от **003-7** (транзитивно — всё).

---

## 2. Шаги плана (по задачам) — RTM checklist

> RTM-линковка (обязательна): один пункт RTM (TASK.md §5) = один чек-бокс, префикс `[R-N]`. Все
> R-1…R-28 присутствуют как явные токены (28 owning-пунктов ниже + перекрёстные ссылки на R-11/R-15 в
> задаче 003-8 + полная трасса §3). Сквозные R-27 (scope-guard) и R-28 (RF-1-сниппеты) — owning-пункты
> в 003-8, но фактически применяются в **каждой** задаче.

### Шаг 1 — [Задача 003-1] core scaffold + canonical types + chain/address (R-1, R-2)

Файл: [task-003-1-core-scaffold-canonical-types.md](tasks/task-003-1-core-scaffold-canonical-types.md)
Stub-First: **Phase 1** — `packages/core` scaffold (package.json plain-`tsc` build, tsconfig(+build),
`.prettierignore`, `types:["node"]`), пустые zod-схемы + сигнатуры `normalizeAddress`/`isValidAddress`,
`workspace:*`-wiring в mcp-server, `tsc --noEmit` зелёный; **Phase 2** — полные zod-схемы + EIP-55/
base58-логика + unit-тесты.

- [ ] **[R-1]** Канонические zod-типы `Token`, `Wallet`, `Balance`, `OHLCV`, `Pool` (D5) в
      `packages/core/src/types/*`, единый источник правды, реэкспорт из `src/index.ts`; provider-DTO не
      протекают (ни один `tools/*.ts` не импортирует provider-специфичный тип); unit-тест валидирует
      каждый тип на примере данных.
- [ ] **[R-2]** Канонический тип `Snapshot` (D5, версионируемый) — `metric, asset, ts, valueRaw
(string), valueNum?, source, height?`; согласован с DB-SCHEMA-CONCEPT §1 (camelCase↔snake_case
      маппинг зафиксирован примечанием, не реализуется в M1 — движок не пишет `snapshots`); unit-тест на
      сериализацию/валидацию.

### Шаг 2 — [Задача 003-2] ProviderAdapter + CapabilityRegistry + providers.config + SSRF + rate-limit (R-3, R-4, R-25, R-26)

Файл: [task-003-2-adapter-registry-net-gate.md](tasks/task-003-2-adapter-registry-net-gate.md)
Stub-First: **Phase 1** — интерфейсы (`ProviderAdapter`, `CapabilityDescriptor`, `CapabilityRoute`,
`CacheStore`), `providers.config.ts` (9 регистраций + routes), `registry.resolve()` стаб, `safeFetch`/
`assertAllowedHost`/`throttle` сигнатуры + тесты red; **Phase 2** — маршрутизация `(capability,chain)`,
skip-to-next по `isAvailable()===false`/ошибке fetch, SSRF-allowlist + редирект-проверка, token-bucket.

- [ ] **[R-3]** `ProviderAdapter` интерфейс (`id/capabilities()/costOf()/fetch()/normalize()/
isAvailable?()`) в `src/adapters/types.ts`; типизирован без `any`-протечек (минимум 2 адаптера в
      003-4/003-5 реализуют его).
- [ ] **[R-4]** Декларативный `src/providers.config.ts` (`routes` + `adapterRegistrations`, 9
      адаптеров) + `CapabilityRegistry.resolve(capability, chain, args)` — маршрутизация по capability+сети,
      приоритет free→paid, выбор по доступности; смена приоритета/хоста = правка конфига, без правки
      вызывающей стороны.
- [ ] **[R-25]** SSRF-гейт `src/net/safe-fetch.ts`: `assertAllowedHost(hostname, allowlist)` +
      `safeFetch(url, opts, allowlist)` (per-adapter allowlist, `redirect:'manual'` + проверка Location на
      каждом хопе, макс. 3); fetch на хост вне allowlist отклоняется **до** сетевого вызова; unit-тест
      подтверждает.
- [ ] **[R-26]** Per-provider rate-limit `src/net/rate-limit.ts`: token-bucket `throttle(providerId,
cfg)` из `providers.config.ts`; превышение лимита задерживает/отклоняет вызов до сети; тест на
      throttle-логике.

### Шаг 3 — [Задача 003-3] two-level cache + DATA_DIR SQLite + metrics counters (R-13, R-14, R-15)

Файл: [task-003-3-two-level-cache-sqlite-metrics.md](tasks/task-003-3-two-level-cache-sqlite-metrics.md)
Stub-First: **Phase 1** — `pnpm-workspace.yaml` `allowBuilds.better-sqlite3:true`, DDL + `CacheStore`-
реализации (lru+sqlite) сигнатуры + `stats.ts` стаб, тесты red; **Phase 2** — двухуровневая логика
hit/miss/TTL, `deriveArgsHash` (canonical key-order), upsert-семантика, hit/miss-счётчики.

- [ ] **[R-13]** Двухуровневый кеш `src/cache/*`: `lru-cache` (hot) → `better-sqlite3` (persistent) в
      `DATA_DIR`; ключ = `(provider, capability, argsHash)`; TTL параметризован по типу данных (таблица
      ARCHITECTURE §3.2); unit-тест на hit/miss обоих уровней.
- [ ] **[R-14]** Схема кеш-БД по DB-SCHEMA-CONCEPT §1: `providers(id PK)` ← `cache_entries` только
      `TEXT/INTEGER/REAL`; время epoch-ms `INTEGER`; id — ULID `TEXT`; `PRAGMA foreign_keys=ON` при
      открытии + `journal_mode=WAL`; все 9 `adapterRegistrations` upsert-ятся в `providers` до первой
      записи; спроектирована под будущую `usage`-таблицу (FK на тот же `providers`) без миграции.
- [ ] **[R-15]** Cache-hit/miss счётчики `src/cache/stats.ts` (`getCacheStats()`): повторный вызов той
      же способности с теми же нормализованными аргументами в пределах TTL → `cache=hit`, первый →
      `cache=miss`; видимо в (a) stderr-строке и (b) `_meta.cache` ответа tool; проверяемо в тесте.

### Шаг 4 — [Задача 003-4] live adapters batch A: coingecko + dexscreener + defillama + fixtures + golden (R-5, R-6, R-7, R-21, R-22)

Файл: [task-003-4-live-adapters-a-cg-ds-dl.md](tasks/task-003-4-live-adapters-a-cg-ds-dl.md)
Stub-First: **Phase 1** — три адаптера (`fetch`/`normalize` стабы), пустые `*.contract.test.ts`, скелет
`scripts/record-fixture.mjs`; **Phase 2** — `record-fixture.mjs` (**ручной, живой вызов ОДИН раз на
адаптер**, evidence-capture) → фикстуры → `normalize()` → golden-тесты зелёные без сети.

- [ ] **[R-5]** Адаптер `coingecko` (`src/adapters/coingecko/`): `capabilities()` = `token.price`+
      `token.metadata`; REST `/coins/{platform}/contract/{address}`; работает без ключа (demo/free), опц.
      `COINGECKO_API_KEY`; contract-тест на записанной фикстуре зелёный.
- [ ] **[R-6]** Адаптер `dexscreener` (keyless): `capabilities()` = `pairs.new`+`pool.info` (оба
      объявлены; `pool.info` пока без tool-потребителя); точный endpoint подтверждается при записи фикстуры
      (§11); contract-тест зелёный без ключа.
- [ ] **[R-7]** Адаптер `defillama` (free/keyless): `capabilities()` = `protocol.tvl`; REST
      `/protocol/{slug}`, срез `chainTvls[chain]`; contract-тест зелёный без ключа.
- [ ] **[R-21]** Контрактные тесты (D11): записанные фикстуры `test/fixtures/<adapter>/*.json` в repo,
      golden-нормализация; `pnpm test` не делает исходящих сетевых вызовов (фикстуры/моки); детерминизм.
- [ ] **[R-22]** Ручной dev-скрипт `packages/core/scripts/record-fixture.mjs` (пере)записи фикстур с
      **probe-evidence** (`<name>.evidence.md`: фактический список полей/endpoint/дата записи, не
      предположение); **не входит в CI**.

### Шаг 5 — [Задача 003-5] live adapters batch B: rpc-evm + rpc-solana + platform-explorer(+history) + dash-platform stub + dune config-stub + pg-history (R-8, R-9, R-10, R-11, R-12)

Файл: [task-003-5-live-adapters-b-rpc-dash-pg.md](tasks/task-003-5-live-adapters-b-rpc-dash-pg.md)
Stub-First: **Phase 1** — все адаптеры-скелеты + `pg/read-client.ts` сигнатура + `registry.fallback.test.ts`
red; **Phase 2** — RPC live (`eth_getBalance`/`getBalance`), platform-explorer live+history, dash-platform
fixture+`isAvailable()===false`, dune config-stub, pg-history поверх `pg`, fallback-тест green.

- [ ] **[R-8]** Адаптер `dune` — **interface/config-stub** (принято как обновлённый scope R-8, §0 п.6):
      `capabilities()` = `token.holders`; `fetch()`/`normalize()` не реализованы; `isAvailable()` безусловно
      `{ ok:false, reason:'dune query authoring deferred to M2' }`; **нет** живого вызова/фикстуры/теста в M1.
- [ ] **[R-9]** Адаптер `dash-platform` (DAPI, primary, keyless) — **interface + fixture-контракт**
      (F-3): `capabilities()` = `privacy.shielded_pool`+`platform.identities/contracts/documents/credits`;
      `normalize()` golden-тестируется на вручную собранной фикстуре; `fetch()` — stub; `isAvailable()`
      безусловно `false`; `@grpc/*` не в зависимостях; никакого write-кода.
- [ ] **[R-10]** Адаптер `platform-explorer` (fallback + history, keyless, **единственный live
      Dash-источник M1**): те же capability, что `dash-platform`, + собственный history-метод
      (`privacy.shielded_pool.history`/`platform.metrics.history`), первым в history-маршрутах.
- [ ] **[R-11]** Горячая замена: `dash-platform.isAvailable()` детерминированно `false` → Registry
      маршрутизирует `privacy.shielded_pool`/`platform.*` на `platform-explorer`; `registry.fallback.test.ts`
      прогоняет **реальный** (не симулированный) fallback-путь, без падения способности.
- [ ] **[R-12]** Опциональный READ-ONLY PG-адаптер `pg-history` поверх `src/pg/read-client.ts`
      (клиент **`pg`**, ленивый `pg.Pool`, `search_path=onchain`, только `SELECT`): при отсутствии
      `ONCHAIN_PG_URL` — `isAvailable()` = `{ ok:false, reason:'needs ONCHAIN_PG_URL' }` (явно, не крэш);
      при наличии — только `SELECT`, ни одного `INSERT/UPDATE`; зарегистрирован в `providers` (FK, F-2).

### Шаг 6 — [Задача 003-6] env-расширение + graceful degradation (R-23, R-24)

Файл: [task-003-6-env-graceful-degradation.md](tasks/task-003-6-env-graceful-degradation.md)
Stub-First: **Phase 1** — 4 новых optional-ключа в `EnvSchema` (стаб) + тест red; **Phase 2** —
финализация схемы, `ONCHAIN_PG_URL` `z.string().url()`-проверка (§11 dev-time чек), сквозная проверка
структурированной деградации.

- [ ] **[R-23]** `EnvSchema` (`mcp-server/src/env.ts`) расширен 4 **опциональными** ключами
      (`COINGECKO_API_KEY`, `DUNE_API_KEY`, `ONCHAIN_PG_URL` как `z.string().url().optional()`, `DATA_DIR`);
      `EnvSchema.parse({})` не бросает; секреты не логируются, не входят в cache-key.
- [ ] **[R-24]** Явная деградация при отсутствующем опц. ключе/DSN: вызов способности без нужного
      ключа/DSN возвращает структурированную ошибку/предупреждение с указанием **какого** ключа не хватает
      (без утечки значения) — через `isAvailable()`-reason и `CapabilityUnavailableError`, не молча/не крэш.

### Шаг 7 — [Задача 003-7] 4 MCP-tools + e2e.inprocess + spawn-e2e → tools/list===5 (R-16, R-17, R-18, R-19, R-20)

Файл: [task-003-7-mcp-tools-e2e.md](tasks/task-003-7-mcp-tools-e2e.md)
Stub-First: **Phase 1** — 4 `tools/*.ts` (input/output zod + handler-стаб), регистрация в `createServer`,
`e2e.inprocess.test.ts` (InMemoryTransport + fixtureRegistry) red; **Phase 2** — handler → `registry.
resolve()` + `isError`-путь + `_meta.cache`, e2e green, spawn-e2e расширен до `tools/list===5`.

- [ ] **[R-16]** MCP-tool `onchain_get_token` — zod in (`chain: z.enum(['ethereum','solana'])`,
      `address` + `superRefine` через `isValidAddress`) / out (`Token`); e2e/contract-тест на ethereum и
      solana — оба ответа валидны по схеме.
- [ ] **[R-17]** MCP-tool `onchain_wallet_balances` — zod in/out (`Wallet`, `balances` только
      `assetType:'native'`); backend = `rpc-evm`/`rpc-solana` (OQ-1 решён, §0 п.5); input-схема покрыта
      unit-тестом на форму, e2e на 2 сетях.
- [ ] **[R-18]** MCP-tool `onchain_new_pairs` — zod in (`chain` enum, `limit?`) / out (`{chain, pairs:
Pool[], source, fetchedAt}`); contract/e2e-тест на фикстурах DexScreener для обеих сетей зелёный.
- [ ] **[R-19]** MCP-tool `onchain_protocol_tvl` — zod in (`chain` enum, `protocolSlug`) / out;
      contract/e2e-тест на фикстурах DeFiLlama для обеих сетей зелёный.
- [ ] **[R-20]** Существующий `onchain_ping` не меняется по контракту: `PingInputSchema`/
      `PingOutputSchema` и M0-regression-тесты остаются зелёными без правок; `tools/list` теперь = 5 tools.

### Шаг 8 — [Задача 003-8] integration verify + CI/smoke + exit-критерии (R-27, R-28) + перепроверка R-11/R-15

Файл: [task-003-8-integration-verify-ci-exit.md](tasks/task-003-8-integration-verify-ci-exit.md)

- [ ] **[R-27]** Scope guard: ревью diff'а подтверждает отсутствие кода вне §3 In Scope — нет платных
      провайдеров/Nansen, write-путей (`INSERT/UPDATE/DELETE`), планировщика (`croner`/BullMQ), HTTP/SSE/
      Streamable-транспорта, watchlists, `@grpc/*`, live Dune-запроса, ERC-20/SPL; grep-гейты зелёные.
- [ ] **[R-28]** Все acceptance-сниппеты во всех task-файлах исполнимы на macOS zsh + pnpm 11 (без bare
      `timeout`, без `pnpm test -- --flag`-форвардинга) — вручную прогнаны перед фиксацией (RF-1 lesson,
      `docs/issues/rf-1-...md`); финальный DoD-прогон зелёный.
- **Перепроверка (exit-mapping, не новые owning-пункты):** **R-15** cache-hit виден в метриках при
  повторном вызове (интеграционный прогон через tool → `_meta.cache.status: miss→hit`); **R-11**
  hot-swap DAPI→platform-explorer доказан на реальной M1-конфигурации; топологический порядок
  `pnpm -r build` (core → mcp-server) проверен эмпирически (§11); CI/`smoke:dist` (ping-only)
  расширены охватом второго пакета через `pnpm -r`.

---

## 3. Полная трассировка RTM (R-1 … R-28)

| R-ID | Требование (кратко)                                       | Задача | Фаза      | Тип         |
| ---- | --------------------------------------------------------- | ------ | --------- | ----------- |
| R-1  | Канонические zod-типы Token/Wallet/Balance/OHLCV/Pool     | 003-1  | Phase 1+2 | dev         |
| R-2  | Канонический `Snapshot` (D5, версионируемый)              | 003-1  | Phase 2   | dev         |
| R-3  | `ProviderAdapter` интерфейс                               | 003-2  | Phase 1   | dev         |
| R-4  | `providers.config.ts` + `CapabilityRegistry.resolve()`    | 003-2  | Phase 1+2 | dev         |
| R-5  | Адаптер CoinGecko (free/demo)                             | 003-4  | Phase 2   | dev         |
| R-6  | Адаптер DexScreener (keyless)                             | 003-4  | Phase 2   | dev         |
| R-7  | Адаптер DeFiLlama (keyless)                               | 003-4  | Phase 2   | dev         |
| R-8  | Адаптер Dune — interface/config-stub (принят §0 п.6)      | 003-5  | Phase 2   | dev         |
| R-9  | Адаптер `dash-platform` — interface+fixture (F-3)         | 003-5  | Phase 2   | dev         |
| R-10 | Адаптер `platform-explorer` (fallback+history, live)      | 003-5  | Phase 2   | dev         |
| R-11 | Горячая замена DAPI→platform-explorer (fallback-тест)     | 003-5  | Phase 2   | dev/test    |
| R-12 | Опц. READ-ONLY `pg-history` (`pg`, SELECT-only)           | 003-5  | Phase 2   | dev         |
| R-13 | Двухуровневый кеш lru+sqlite DATA_DIR                     | 003-3  | Phase 1+2 | dev         |
| R-14 | Схема кеш-БД по DB-SCHEMA §1 (portable, ULID, FK)         | 003-3  | Phase 2   | dev         |
| R-15 | Cache-hit/miss метрики видимы                             | 003-3  | Phase 2   | dev/test    |
| R-16 | Tool `onchain_get_token` (2 сети)                         | 003-7  | Phase 1+2 | dev         |
| R-17 | Tool `onchain_wallet_balances` (rpc-evm/rpc-solana, OQ-1) | 003-7  | Phase 1+2 | dev         |
| R-18 | Tool `onchain_new_pairs` (2 сети)                         | 003-7  | Phase 2   | dev         |
| R-19 | Tool `onchain_protocol_tvl` (2 сети)                      | 003-7  | Phase 2   | dev         |
| R-20 | `onchain_ping` без изменений; tools/list===5              | 003-7  | Phase 2   | dev/regress |
| R-21 | Контрактные тесты на фикстурах, без сети в CI             | 003-4  | Phase 2   | dev/test    |
| R-22 | Ручной `record-fixture.mjs` + probe-evidence              | 003-4  | Phase 2   | dev/tooling |
| R-23 | `EnvSchema` + 4 optional-ключа; `parse({})` не бросает    | 003-6  | Phase 1+2 | dev         |
| R-24 | Явная деградация при отсутствии ключа/DSN                 | 003-6  | Phase 2   | dev         |
| R-25 | SSRF-гейт `safeFetch`/`assertAllowedHost` (per-adapter)   | 003-2  | Phase 2   | dev         |
| R-26 | Per-provider rate-limit (token-bucket)                    | 003-2  | Phase 2   | dev         |
| R-27 | Scope guard (нет out-of-scope кода)                       | 003-8  | cross-cut | verify      |
| R-28 | Acceptance-сниппеты RF-1-исполнимы на macOS+pnpm 11       | 003-8  | cross-cut | verify      |

**Exit-критерии ROADMAP §M1 (TASK.md §6) → задачи:**

- **Все 4 tools на ≥2 сетях (ethereum+solana)** → R-16/R-17/R-18/R-19 (003-7) поверх R-5/R-6/R-7 (003-4)
  - R-8 config-stub (003-5); проверка в 003-8.
- **Cache-hit виден в метриках** → R-13/R-14/R-15 (003-3); интеграционный прогон в 003-8.
- **$0 трат** → R-4 (003-2), R-5/R-6/R-7 (003-4), R-8/R-9/R-10 (003-5), R-23/R-24 (003-6) — все free/keyless.
- **Golden-тесты зелёные** → R-1/R-2 (003-1), R-3 (003-2), R-21/R-22 (003-4).
- **Scope guard (нет платных/write/scheduler/HTTP)** → R-12 (003-5), R-27 (003-8).

---

## 4. Архитектурные planner-items §11 — явная привязка

| §11-пункт                                                                | Куда вплетён                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Probes при записи фикстур (live-вызов ОДИН раз/адаптер, evidence)        | 003-4 (coingecko/dexscreener/defillama), 003-5 (rpc-evm/rpc-solana/platform-explorer) |
| DexScreener точный endpoint `pairs.new`/`pool.info`                      | 003-4 (подтверждается при записи фикстуры)                                            |
| `pnpm -r build`/`test` топология (core→mcp-server) — проверить           | 003-1 (первичная), 003-8 (финальная эмпирическая проверка)                            |
| `ONCHAIN_PG_URL` `z.string().url()` принимает реальный DSN               | 003-6 (dev-time чек WHATWG URL-парсинга postgres://)                                  |
| Второй keyless Solana RPC fallback — **не в M1** (одиночная точка+retry) | 003-5 (зафиксировано как ограничение, не добавляется)                                 |
| `dashpay/platform` license (для `.proto`) — только с backlog-gRPC        | вне M1 (§5 «Отложено»)                                                                |

## 5. Явно ОТЛОЖЕНО (NOT-in-M1) — под guard R-27

- **Живой gRPC DAPI-транспорт** для `dash-platform` (`@grpc/grpc-js`+`@grpc/proto-loader`, вендоринг
  `.proto`, evonode-host live-пробник, канал-level `assertAllowedHost`) — отдельная backlog-задача,
  не на критическом пути M1 (ARCHITECTURE §3.2/§11, F-3). `platform-explorer` несёт 100% Dash-трафика.
- **Живой Dune-запрос** (`token.holders`: query id/SQL, параметризация, фикстура, contract-тест) —
  M2, первый потребитель `onchain_token_risk` (ARCHITECTURE §11). В M1 — только config-stub.
- **ERC-20/SPL токен-балансы** — M1.5/M2; `BalanceSchema` уже несёт `assetType`/`contractAddress`,
  добавление без миграции схемы (ARCHITECTURE §3.2).
- **Budget-guard (`usage`-таблица), snapshot-write, планировщик, HTTP-транспорт, watchlists, Nansen/
  платные** — M2/M3/M6 (TASK.md §4).

---

## 6. Итоговая проверка плана (Definition of Done для M1)

Локально (без сети/секретов, порядок как в CI; **RF-1-safe**, задача 003-8):

```bash
corepack enable pnpm                          # pnpm 11 через corepack (Node несёт corepack)
pnpm install --frozen-lockfile                # lockfile закоммичен; better-sqlite3 нативно собран
pnpm lint                                     # repo-wide, покрывает packages/core
pnpm format:check                             # repo-wide
pnpm typecheck                                # pnpm -r: core → mcp-server (топология)
pnpm test                                     # pnpm -r: core (contract/cache/SSRF/rate-limit) → mcp-server (env/ping/e2e.stdio[spawn,5-tool]/e2e.inprocess[4 tools])
pnpm build                                    # pnpm -r: core (plain tsc) → mcp-server (tsup+tsc)
pnpm --filter @onchain-intel/mcp-server run smoke:dist   # ping-only, требует dist/ (после build)
```

Ручная проверка exit-критерия: подключить `packages/mcp-server` в Claude Code как локальный stdio
MCP-сервер → 5 tools видны → `onchain_get_token`/`onchain_new_pairs`/`onchain_protocol_tvl`/
`onchain_wallet_balances` на `ethereum` и `solana` → канонический ответ; повторный вызов в пределах
TTL → `_meta.cache.status === 'hit'` (UC-3, exit-критерий ROADMAP).

Финальный гейт (только по команде оркестратора): commit + push → GitHub Actions зелёный (Node 22).
