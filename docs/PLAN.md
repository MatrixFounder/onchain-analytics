# PLAN — TASK-005 · M2: Alpha-слой, платный (`m2-alpha-paid`)

| Поле             | Значение                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task**         | [TASK-005 `m2-alpha-paid`](TASK.md) — R-29…R-47                                                                                                                                                                                                                                    |
| **Architecture** | [system-architecture.md](architectures/system-architecture.md) §3.2 (M2-блок), [data-model.md](architectures/data-model.md) §4, [interfaces.md](architectures/interfaces.md) §5 — THE design source                                                                                |
| **ADR**          | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — D3–D7, D10–D12                                                                                                                                                                                                  |
| **DB-схема**     | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 — применена к `usage` в кеш-БД                                                                                                                                                                                   |
| **Evidence**     | [raw/nansen-probe-2026-07-23.json](onchain-analytics/raw/nansen-probe-2026-07-23.json) (`credit_cost_table`, живой `/account`), [raw/nansen-openapi-2026-07-23.json](onchain-analytics/raw/nansen-openapi-2026-07-23.json) (75 путей) — **единственные** источники фактов о Nansen |
| **Статус плана** | Draft (готов к Development-фазе)                                                                                                                                                                                                                                                   |
| **Дата**         | 2026-07-23                                                                                                                                                                                                                                                                         |
| **Стратегия**    | Stub-First (Phase 1 структура/стабы/red → Phase 2 логика/green), атомарная нарезка **9 задач** (8 обязательных + 1 опциональная)                                                                                                                                                   |

---

## 0. Стратегия и границы

M2 — первый **платный** срез: десятый адаптер (`nansen`), три канонических типа, `usage`-леджер
с budget-guard, три новых MCP-tool. План строго следует архитектуре
([system-architecture.md](architectures/system-architecture.md) §3.2 M2-блок — раскладка, формулы и
инварианты; [data-model.md](architectures/data-model.md) §4 — DDL и типы; [interfaces.md](architectures/interfaces.md)
§5 — контракты tools). Реализуется ровно то, что в скоупе TASK.md §3; всё из §4 (Bitquery, MCP-сервер
Nansen как поверхность, `/agent/*`, живой Dune, M3-снапшоттер, HTTP-транспорт) **не трогается**.

### 0.1. ⚠️ Жёсткая дисциплина кредитов — ГЛАВНОЕ ограничение этого плана

Живые вызовы Nansen тратят **реальные деньги** с баланса **100 кредитов** (`free`-план, живой пробник
2026-07-23). Владелец ограничил всю сборку M2 потолком **≤ 30 кредитов** (TASK.md §1 п.4).

> **ЕДИНСТВЕННАЯ задача, которой разрешено делать живые платные вызовы, — [005-7](tasks/task-005-7-fixtures-live-verification.md).**
> Все остальные восемь задач работают **только** на записанных/spec-derived фикстурах и инжектированном
> `fetchImpl` — их стоимость строго **0 кредитов**. Ни одна из них не имеет права поставить
> `NANSEN_API_KEY` в окружение прогона тестов и ни одна не имеет права позвать `record-fixture.mjs`
> для `nansen`.

Конкретный план расхода 005-7 (по статической `credit_cost_table`, не по оценке) — стоимость
считается **per HTTP-под-вызов, сгруппированный в 3 платных логических `fetch()`-вызова**, потому что
продовый `fetch()` — **capability**-гранулярный и композитный (`smart-money.flows` = netflow +
holders, **всегда оба**; `token.risk` = indicators + token-information, **всегда оба**); запись через
ту же фабрику `createNansenAdapter` списывает ровно эти суммы, не по одному эндпоинту:

| Логический `fetch()`                    | HTTP-под-вызовы (фикстуры)                           | Кредитов |
| --------------------------------------- | ---------------------------------------------------- | -------- |
| `GET /api/v1/account` (resync, до)      | `account.free.json`                                  | **0**    |
| `entity.labels` (дефолт, `query`-only)  | `search-general.json`                                | **0**    |
| `smart-money.flows`                     | `smart-money-netflow.json` + `tgm-holders.json`      | **10**   |
| `token.risk`                            | `tgm-indicators.json` + `tgm-token-information.json` | **6**    |
| `GET /api/v1/account` (resync, после)   | (сверка расхода, файл не перезаписывается)           | **0**    |
| **Итого — 3 платных логических вызова** |                                                      | **16**   |

Запас **14cr** до потолка ≤30 — ровно на **один** повтор 10cr-вызова `smart-money.flows` при сбое
записи; второй повтор наш собственный gate откажет (см. машинный гейт в 005-7).

**Что живьём НЕ вызывается никогда:** `POST /api/v1/profiler/address/labels` (100cr — весь баланс) и
`POST /api/v1/profiler/address/premium-labels` (500cr). Их фикстуры не записываются; путь
`exhaustive: true` покрыт **только** тестом отказа гейта (арифметика, не сеть).

**Оба обязательных теста отказа бюджета (R-37) — чистая арифметика против статической cost-таблицы,
БЕЗ единого сетевого вызова:**

- (a) `premium_labels=true` на `POST /tgm/holders` → 150cr против остатка 100 → отказ;
- (b) `POST /profiler/address/labels` → 100cr против остатка 100 (после любого ненулевого расхода
  бакета) → отказ.

  В обоих случаях `spy(fetchImpl).mock.calls.length === 0` и `usage` не изменился. Это **acceptance
  этих тестов**, а не побочный эффект: тест, который сходил в сеть, считается проваленным.

После коммита фикстур `pnpm test` **навсегда** стоит 0 кредитов и проходит offline (D11, тот же
контракт, что M1).

**⚠️ Изоляция от ambient-ключа (обязательна во ВСЕХ M2-тестах — экспозиция открывается ровно на
005-7):** после 005-7 в `.env` разработчика лежит **живой** `NANSEN_API_KEY`, а
`e2e.stdio.test.ts` спавнит сервер с `env: { ...process.env, DATA_DIR }` (полное наследование). Запрет
«не _ставить_ ключ» из этого блока недостаточен — нужно **снять** уже присутствующий. Правило: ни один
M2-тест не читает ambient-окружение — ключ либо `vi.stubEnv('NANSEN_API_KEY', 'test-key-not-real')`,
либо явная инъекция `env: {}` (паттерн `e2e.inprocess.test.ts:124`); спавн-сервер в M2-тестах
получает явный `env` **без** `NANSEN_API_KEY`. Особенно критично для TC-INT-02 (005-8), который
гоняется **с** ключом и полагается на предзаполненный `usage` до потолка — любой промах (потолок из
живого `/account` вместо фейкового, чужой бакет, реальный registry) превратил бы «0 сетевых вызовов» в
живой 10cr-вызов. Машинный гейт — в acceptance 005-8.

### 0.2. Ключевые инженерные решения (из архитектуры — обязательны, не пересматриваются)

1. **Гейт живёт ВНУТРИ `fetch()` адаптера `nansen`** (решение OQ-2, §3.2): не в
   `CapabilityRegistry.resolve()` и не в tool-хендлере. Из этого **бесплатно** следует правильный
   порядок «cache lookup → (miss) → gate → сеть» (UC-5: кеш-хит **никогда** не тратит бюджет) и то,
   что **`registry.ts`/`resolve-capability.ts`/4 M1-tool'а/9 M1-адаптеров не редактируются ВООБЩЕ**
   (проверяется грепом диффа в 005-8).
2. **`effectiveCeiling = min(usageAtObserve + creditsRemainingAtObserve, NANSEN_DAILY_CREDIT_CAP ?? Infinity)`
   — ЕДИНСТВЕННАЯ корректная свёртка** (§3.2 «Формула потолка бакета»). Наивный
   `min(creditsRemainingAtObserve, CAP)` **без** перебазирования на `usageAtObserve` при каждом
   mid-bucket resync повторно вычитает уже учтённый расход → phantom-lockout. Вся anchor-арифметика
   происходит **до** вызова `BudgetStore`; сам `BudgetStore` — provider-agnostic леджер, сравнивает
   `usage(bucket) + cost <= ceiling` и ничего не знает про якоря.
3. **Реконсиляция — РОВНО ОДИН раз на логический `fetch()`**, `actualTotal = Σ(X-Nansen-Credits-Used)`
   по **всем** под-ответам, `delta = actualTotal − reservedTotal`. Per-response реконсиляция для
   композитных способностей (`smart-money.flows` = 2 HTTP-вызова, `token.risk` = 2) даёт
   `usage += (5−10) + (5−10) = 0` — счётчик обнуляет сам себя на каждом платном вызове.
4. **`dayBucketMs` фиксируется ОДИН раз на входе в gate** и протаскивается параметром через всю
   цепочку (резервация → HTTP → `recordDelta`) — **никогда** не пересчитывается из `Date.now()` на
   момент ответа (иначе вызов на границе полуночи пишет отрицательную дельту в **чужой** бакет).
5. **`db.transaction(fn).immediate()` (НЕ `DEFERRED`) + `new Database(path, { timeout: 5000 })`** —
   `BEGIN IMMEDIATE` берёт write-lock сразу, поэтому busy-handler реально применяется; с `DEFERRED`
   конкурентная запись даёт `SQLITE_BUSY_SNAPSHOT` **мимо** busy-handler. Тело транзакции —
   строго синхронное (ни одного `await`), иначе atomicity-гарантия исчезает.
6. **Singleflight — САМЫЙ внешний слой `fetch()`, ДО check-and-reserve** (иначе два одновременных
   идентичных вызова оба зарезервируют кредиты). Ключ — существующий `deriveArgsHash(capability, args)`,
   не новый примитив. Per-process, не per-machine (два разных процесса — два законных запроса).
7. **`costOf()` для неизвестного `(method+path)` → `Number.POSITIVE_INFINITY`, НИКОГДА `0`**
   (fail-closed). Гейт проверяет `Number.isFinite(cost)` **до** любого обращения к
   `BudgetStore`/сети — `Infinity` никогда не доходит до SQLite-параметра.
8. **Cost-таблица — committed `.ts`-модуль**, сгенерированный ручным dev-скриптом из закоммиченного
   `nansen-openapi-2026-07-23.json` (`x-credit-cost`), **не** runtime-парсинг и **не** CI-codegen:
   дрейф вендорских цен виден обычным git-диффом. Только ~8 реально используемых эндпоинтов, не все 74.
9. **Chain-scope (OQ-3) — `ethereum` + `solana`**, буквально то же подмножество, что 4 M1-tool'а:
   три Nansen-энумератора чейнов не совпадают друг с другом, расширение — backlog, не M2.
10. **OQ-5 — решён «ДА»:** опциональный `NANSEN_DAILY_CREDIT_CAP` (может только **сузить** живой
    потолок, никогда не расширить) + `NANSEN_BUDGET_WARN_RATIO` (дефолт `0.8`, одна stderr-строка).
11. **R-35 принят ýже буквального текста** (архитектура §3.2, санкционировано явно): `BudgetStore`
    НЕ содержит метода «прочитать текущий выведенный потолок» — потолок Nansen-специфичен и живёт в
    `NansenAccountState`. Тот же паттерн честного сужения, что R-8/Dune в M1.
12. **Деградация M2 — явный `isError`, не registry-fallback** (TASK.md §4, реинтерпретация ROADMAP):
    у трёх M2-способностей нет бесплатного эквивалента, `adapterIds: ['nansen']` — единственный
    элемент, отказ гейта неотличим от сетевого сбоя → `CapabilityUnavailableError` → `isError: true`
    тем же R-24-путём, что «ключ не задан».

### 0.3. Фикстуры: двухшаговая дисциплина (следствие §0.1)

Записать живые фикстуры **до** того, как `fetch()` существует, невозможно; сделать это в каждой
задаче — нарушить кредитный потолок. Поэтому:

- **005-4** создаёт **provisional, spec-derived** фикстуры `test/fixtures/nansen/*.json`, собранные
  строго по response-схемам закоммиченного `nansen-openapi-2026-07-23.json` (`SmartMoneyNetflow`,
  `TGMHolder`, `TGMIndicatorsResponse`, `TGMIndicatorTokenInfo`, `GeneralSearchResponse`, …). Тот же
  прецедент, что вручную собранная фикстура `dash-platform` в M1 (архитектура §3.2, F-3). Каждая
  несёт evidence-файл со строкой `provenance: spec-derived (openapi), NOT live`.
- **005-7** заменяет их **реально записанными** (один живой вызов на эндпоинт) и прогоняет **те же
  самые** golden-тесты без правок ассертов. Любое расхождение формы = находка вендор-дрейфа:
  чинится в 005-7 и фиксируется в evidence, не замалчивается.

> **Читать `nansen-openapi-2026-07-23.json` целиком запрещено (630KB — три агента сессии умерли на
> этом).** Только точечный `jq`/`grep` по конкретной схеме, пример — в task-файле 005-4.

### 0.4. Дисциплина коммитов и окружения

Dev-задачи **ничего не коммитят и не пушат** — коммит/пуш и прогон CI только по явной команде
оркестратора на гейтах (как в M0/M1). **Исключение по смыслу, не по правам:** фикстуры и evidence,
записанные в 005-7, — единственный артефакт, который обязан быть закоммичен до финального гейта
(иначе повторный прогон снова стоил бы кредитов); сам коммит по-прежнему делает оркестратор.

**Acceptance-сниппеты — дисциплина RF-1 (унаследована из M1, обязательна во всех задачах):** на
macOS zsh + pnpm 11 **запрещены** (а) bare `timeout` и (б) `pnpm test -- --flag`. Разрешено:
`pnpm --filter <pkg> test` (весь сьют) и `pnpm --filter <pkg> exec vitest run <path>` (один файл).

**Baseline тест-сьюта:** первым шагом 005-1 фиксируются два якоря — фактическое число зелёных тестов
**и** `BASE_SHA` (`git rev-parse HEAD`) до единой правки M2. Ожидаемое число — **287** (212 core +
75 mcp-server, измерено координатором; TASK.md синхронизирован); авторитетно то, что реально выведет
прогон — резко иное значение = сигнал, не молча принятая цифра. Именно это число «M1 не
регрессировал» проверяет 005-8; `BASE_SHA` — якорь immutability-грепов, устойчивый к mid-run коммиту
фикстур (§0.4).

---

## 1. Граф задач (DAG)

```
005-1  канонические типы + регистрация nansen + скелет адаптера (0 сети)        (dev)
  ├─► 005-2  usage-DDL + BudgetStore + SqliteBudgetStore                        (dev)
  │     └─► 005-3  cost-table codegen + costOf() + NansenAccountState + gate    (dev)
  │           └─► 005-5  singleflight + wiring гейта + reconciliation в fetch() (dev)
  └─► 005-4  HTTP-слой + normalize() → 3 типа + spec-фикстуры + секреты         (dev)
        └─► 005-5
              └─► 005-6  3 MCP-tools + _meta.budget + env/.env.example/§5.3     (dev)
                    └─► 005-7  ЖИВАЯ запись фикстур + live-verification (≈16cr) (dev/verify)
                          └─► 005-8  деградация + M1-регрессия + exit-критерии  (verify)

Вне критического пути (опционально, НЕ гейтит приёмку):
  005-9  carry-over M1-hardening (safeFetch byte-cap, solana lamports)          (dev, Should)
```

Зависимости (топология исполнения — авторитетный список; диаграмма выше — читаемое приближение):

- **005-1** — root (расширяет M1; зависимостей внутри M2 нет).
- **005-2** — зависит от **005-1** (регистрация `nansen` в `adapterRegistrations` нужна для
  bootstrap `providers`, иначе первый `INSERT INTO usage` падает по FK).
- **005-3** — зависит от **005-1** (скелет адаптера, куда встраиваются `costOf()`/account-state) и
  **005-2** (`BudgetStore.checkAndReserve` — то, что гейт вызывает).
- **005-4** — зависит от **005-1** (канонические типы для `normalize()`, hosts/rate-limit из
  регистрации). **Не** зависит от 005-2/005-3 — HTTP-слой и гейт разрабатываются параллельно.
- **005-5** — зависит от **005-3** (гейт + `dayBucketMs` + account-state) и **005-4** (реальные
  под-вызовы, чьи заголовки суммируются реконсиляцией).
- **005-6** — зависит от **005-4** (нормализованные выходы для zod-out) и **005-5** (полный
  budget-gated `fetch()`; `_meta.budget` читает `BudgetStore.getUsage`).
- **005-7** — зависит от **005-6** (весь путь собран; живой вызов идёт через продовый код, а не
  через отдельный хендроллед-пробник).
- **005-8** — зависит от **005-7** (транзитивно — всё).
- **005-9** — независима от всей цепочки (трогает `net/safe-fetch.ts` и `adapters/rpc-solana/`).

---

## 2. Шаги плана (по задачам) — RTM checklist

> RTM-линковка (обязательна): один пункт RTM (TASK.md §5) = один чек-бокс, префикс `[R-N]`. Все
> R-29…R-47 присутствуют как явные токены (19 owning-пунктов ниже + полная трасса §3). R-47 —
> **явно опциональный** (Should), не гейтит приёмку TASK-005.

### Шаг 1 — [R-30/R-31/R-32/R-33] Канонические типы + регистрация `nansen` + скелет адаптера [Задача 005-1]

Файл: [task-005-1-canonical-types-nansen-scaffold.md](tasks/task-005-1-canonical-types-nansen-scaffold.md)
Stub-First: **Phase 1** — baseline-прогон сьюта, три пустых zod-схемы + `adapters/nansen/index.ts`
со стаб-`fetch()`/`normalize()` (`NotImplementedError`), 10-я запись `adapterRegistrations` + 3
`routes`, `PAID_PROVIDER_IDS += 'nansen'`, реэкспорты в `src/index.ts`, `tsc --noEmit` зелёный;
**Phase 2** — полные zod-схемы по [data-model.md](architectures/data-model.md) §4.1 + `capabilities()`/
`isAvailable()` + unit-тесты (валидные/невалидные примеры, отсутствие ключа → структурированный reason).

- [ ] **[R-30]** Capability-декларации + маршрутизация: `providers.config.ts` получает 10-ю запись
      `adapterRegistrations` (`id:'nansen'`, `hosts:['api.nansen.ai']`,
      `rateLimit:{capacity:5,refillPerSec:1}`, `requiresEnv:['NANSEN_API_KEY']`) и 3 маршрута
      (`smart-money.flows`/`entity.labels`/`token.risk`, `chains:['ethereum','solana']`,
      `adapterIds:['nansen']` — без fallback-адаптера); реестр стартует без падения; `registry.ts`
      **не редактируется**.
- [ ] **[R-31]** Канонический тип `SmartMoneyFlow` (`src/types/smart-money-flow.ts`): `chain`,
      `tokenAddress` (через `normalizeAddress`), `tokenSymbol`, `netflow{1h,24h,7d,30d}Usd`,
      `traderCount?`/`tokenAgeDays?`/`tokenSectors?[]`, `topHolders[]`
      (`{address,addressLabel?,tokenAmount?,valueUsd?,ownershipPercentage?}`), `source`, `fetchedAt`;
      Nansen-DTO (включая обёртку `{data,pagination}`) наружу не протекает; unit-тест на валидацию.
- [ ] **[R-32]** Канонический тип `EntityLabel` (`src/types/entity-label.ts`): `chain?`/`address?`
      (оба **опциональны** — `EntitySearchResult` кросс-чейновый, единственный M2-тип с таким
      послаблением), `name?`, `tags[]` (default `[]`), `labels[]` (default `[]`),
      `premiumRequested: boolean`, `source`, `fetchedAt`; **пустой `labels[]` — валидный результат**,
      не ошибка; unit-тест на обе формы.
- [ ] **[R-33]** Канонический тип `TokenRiskScore` (`src/types/token-risk-score.ts`): `chain`,
      `address`, `marketCapUsd?`/`marketCapGroup?`/`isStablecoin?`, **раздельные**
      `riskIndicators[]`/`rewardIndicators[]` (`{indicatorType,score?,signal?,signalPercentile?,lastTriggerOn?}`),
      `source`, `fetchedAt`; `signal`/`signalPercentile` — `number`, не строки; unit-тест.

### Шаг 2 — [R-34/R-35] `usage`-таблица + `BudgetStore` + `SqliteBudgetStore` [Задача 005-2]

Файл: [task-005-2-usage-ddl-budget-store.md](tasks/task-005-2-usage-ddl-budget-store.md)
Stub-First: **Phase 1** — `usage`-DDL дописан в `CACHE_DDL`, `budget-store.ts` с интерфейсом
`BudgetStore` + стаб-реализацией (`checkAndReserve` всегда `{ok:true}`, `getUsage` → `0`), тесты red;
**Phase 2** — `SqliteBudgetStore` (собственное соединение, `timeout:5000`, `PRAGMA foreign_keys=ON`,
self-bootstrap `providers`, `db.transaction(fn).immediate()`), аддитивный upsert с `MAX(0,…)`,
`createBudgetStore` фабрика, тесты green.

- [ ] **[R-34]** Таблица `usage(provider TEXT FK → providers(id), day INTEGER, credits_used INTEGER,
updated_at INTEGER, PRIMARY KEY(provider,day))` дописана в тот же `CACHE_DDL` (без миграции
      `providers`/`cache_entries`): только `TEXT`/`INTEGER`/`REAL`; `day` — epoch-ms UTC bucket
      (`floor(ts/86400000)*86400000`), **не строковая дата**; `credits_used` — `INTEGER`; запись —
      **аддитивный** upsert `ON CONFLICT (provider,day) DO UPDATE SET credits_used =
MAX(0, credits_used + excluded.credits_used)` (не overwrite, как у `cache_entries`); обе фазы
      (pre-call резервация и post-call подписанная дельта) идут **одним и тем же** SQL.
- [ ] **[R-35]** `BudgetStore`-репозиторий (`src/cache/budget-store.ts`) — три метода
      `checkAndReserve(provider, dayBucketMs, cost, ceiling)` / `recordDelta(provider, dayBucketMs,
signedDelta)` / `getUsage(provider, dayBucketMs)`, engine-swap-safe, инжектируемый тем же способом,
      что `CacheStore`; `SqliteBudgetStore` открывает **собственное** соединение
      (`new Database(path,{timeout:5000})`), сам себе bootstrap-ит `providers` (иначе первый INSERT
      падает по FK), переиздаёт `PRAGMA foreign_keys=ON` на **этом** соединении;
      `checkAndReserve` — `db.transaction(fn).immediate()` с полностью **синхронным** телом; отказ
      **ничего не пишет** (не «откат», а «нет записи»). Метода «прочитать потолок» нет — принятое
      сужение R-35 (§0.2 п.11).

### Шаг 3 — [R-36/R-37] Cost-table codegen + `costOf()` + `NansenAccountState` + pre-call gate [Задача 005-3]

Файл: [task-005-3-cost-table-account-state-gate.md](tasks/task-005-3-cost-table-account-state-gate.md)
Stub-First: **Phase 1** — `scripts/generate-nansen-cost-table.mjs` + сгенерированный
`adapters/nansen/cost-table.ts`, сигнатуры `account-state.ts`/`budget-gate.ts` со стабами, тесты red;
**Phase 2** — `costOf()` (capability → фикс. список `(method,path)` → сумма цен под живым `plan`,
неизвестный ключ → `Infinity`), `refreshAccount()` (`GET /account` + чтение `usage` **одним
логическим шагом**), `effectiveCeiling`, `ensureBudget()`, оба отказ-теста + atomicity-тест.

- [ ] **[R-36]** Дневной потолок выводится **только** из живых данных: `GET /api/v1/account` (0cr) +
      заголовки последнего ответа, никогда из cost-таблицы и никогда из захардкоженного плана;
      `NansenAccountSnapshot{plan, creditsRemainingAtObserve, usageAtObserve, observedAtMs, dayBucketMs}`;
      дефолт до первого резолва — консервативный `plan:'free'`; resync **только** на (1) cold start /
      смена day-бакета и (2) `isUnreconciled()`, **не** на каждый вызов; провал самого resync'а →
      `fetch()` бросает **до** `checkAndReserve` (fail-closed, не fail-open со stale-потолком);
      тест: фикстура `plan:'pro', credits_remaining:100000` пропускает ранее отказанный 150cr-вызов
      **без единой правки кода** (UC-9).
- [ ] **[R-37]** Pre-call budget gate — отказ **до** сети, атомарно: `costOf()` читает точную цену из
      сгенерированной из закоммиченной спеки таблицы (не тратит кредиты, чтобы узнать цену),
      неизвестный `(method,path)` → **`Infinity`, никогда `0`** (`Number.isFinite`-проверка **до**
      обращения к `BudgetStore`/сети); **`effectiveCeiling = min(usageAtObserve +
creditsRemainingAtObserve, NANSEN_DAILY_CREDIT_CAP ?? Infinity)`** — единственная допустимая свёртка
      (§0.2 п.2); `dayBucketMs` фиксируется **один раз** на входе в gate и передаётся дальше
      параметром; read+reserve атомарны (`immediate()`-транзакция); отказ называет **какой именно**
      предел сработал (vendor vs self-imposed cap), без утечки ключа; при
      `spentSinceAnchor/creditsRemainingAtObserve >= NANSEN_BUDGET_WARN_RATIO` — одна stderr-строка,
      не чаще раза на пересечение порога за бакет. **Обязательные тесты (все — БЕЗ сети):** (a)
      150cr `premium_labels=true` на `/tgm/holders` против остатка 100 → `isError`, spy на
      `fetchImpl` не вызван, `usage` не изменился; (b) 100cr `/profiler/address/labels` против
      остатка → отказ, независимо от (a); (c) atomicity: два **разных** одновременных вызова,
      суммарно превышающих остаток → ровно один `{ok:true}`.

### Шаг 4 — [R-29/R-45] HTTP-слой адаптера + `normalize()` → 3 типа + spec-фикстуры + секретная дисциплина [Задача 005-4]

Файл: [task-005-4-nansen-http-normalize-secrets.md](tasks/task-005-4-nansen-http-normalize-secrets.md)
Stub-First: **Phase 1** — модули `endpoints.ts`/`normalize.ts` с сигнатурами + spec-derived фикстуры

- golden-тесты red; **Phase 2** — реальные POST-вызовы через `safeFetch` (`apiKey`-заголовок,
  JSON-тело), 429/402-пути, `normalize()` для трёх способностей, golden + секретные тесты green.

* [ ] **[R-29]** Адаптер `nansen` как полноценный `ProviderAdapter` (десятый в реестре): host
      **только** `api.nansen.ai` в **своём** `hosts`-allowlist (per-adapter SSRF, не общий список);
      заголовок **`apiKey: <NANSEN_API_KEY>`**, НЕ `Authorization: Bearer`; все эндпоинты, кроме
      `GET /api/v1/account`, — **POST с JSON-телом** (`{method:'POST',
headers:{'content-type':'application/json', apiKey}, body: JSON.stringify(...)}`);
      `isAvailable()` → `{ok:false, reason:'needs NANSEN_API_KEY'}` **до** сети при отсутствии ключа;
      rate-limit `{capacity:5, refillPerSec:1}` — заведомо ниже **всех четырёх** документированных
      порогов (`-second:150`, `-minute:3000`, `-credit-fails-minute:10`, `x-ratelimit-limit:15`);
      `429` → **явная немедленная ошибка** с `retry-after` в тексте (решение архитектуры: без retry
      внутри адаптера), `402` → авторитетный «бюджета нет сейчас», `fetch()` бросает целиком;
      unit-тесты на все четыре пути.
* [ ] **[R-45]** Секретная дисциплина `NANSEN_API_KEY`: читается **внутри** `fetch()` (никогда на
      module-load), не логируется (stderr-санитизация), **не входит в `args_hash`** — тест: два
      вызова с **разными** ключами и одинаковыми args дают идентичный `deriveArgsHash`; cross-host
      редирект снимает заголовок существующим `SENSITIVE_HEADER_RE` (`net/safe-fetch.ts` —
      `/authorization|api-?key/i` уже покрывает `apiKey` регистронезависимо, **правок regex не
      требуется**) — regression-тест доказывает это конкретно для `nansen`; grep-гейт: ни одного
      `console.log`/stdout со значением ключа.

### Шаг 5 — [R-38/R-39] Singleflight + wiring гейта + post-call reconciliation внутри `fetch()` [Задача 005-5]

Файл: [task-005-5-singleflight-reconciliation.md](tasks/task-005-5-singleflight-reconciliation.md)
Stub-First: **Phase 1** — `singleflight.ts` + `reconcile.ts` сигнатуры, композиция слоёв внутри
`fetch()` (стабы), тесты red; **Phase 2** — коалессинг, суммирование заголовков, `markUnreconciled`/
`clearUnreconciled`, частичный отказ композитных способностей, тесты green.

- [ ] **[R-38]** Post-call reconciliation — **ровно один раз** на логический `fetch()`, ПОСЛЕ того как
      **все** под-вызовы завершились: `actualTotal = Σ(X-Nansen-Credits-Used)` по всем под-ответам,
      `delta = actualTotal − reservedTotal`, один вызов `recordDelta('nansen', bucket, delta)` тем же
      аддитивным upsert (**не** замещающая запись); `bucket` — тот самый `dayBucketMs`, что был
      зафиксирован до `checkAndReserve`; отсутствующий/непарсящийся заголовок **хотя бы на одном**
      под-ответе → **вся** реконсиляция деградирует к `delta = 0` (никогда частичная сумма) +
      `markUnreconciled()`; транспортная ошибка/таймаут/`402` → реконсиляция не запускается вовсе,
      резервация остаётся как консервативный факт (никогда не обнуляется молча) + `markUnreconciled()`
      → следующий вход в gate обязательно резолвит `/account`; `clearUnreconciled()` снимается
      **только** успешным resync'ом, не успешным платным вызовом; retry не резервирует повторно.
- [ ] **[R-39]** Singleflight-коалессинг — **самый внешний** слой `fetch()`, **ДО** check-and-reserve:
      `Map<string, Promise<unknown>>`, ключ = `deriveArgsHash(capability, args)` (существующий
      экспорт `net/args-hash.js`, не новый примитив), запись стирается в `finally`; вызов, пришедший
      после разрешения первого, стартует заново (это новый запрос — ему нужна своя проверка бюджета);
      per-process, не per-machine. Тест: два **параллельных идентичных** вызова → ровно **один**
      сетевой запрос (spy count === 1) и **одна** пара записей `usage` (резервация + дельта) —
      отличается от atomicity-теста R-37(c), где вызовы **разные**.

### Шаг 6 — [R-41/R-42/R-43/R-46] Три MCP-tool + `_meta.budget` + env/`.env.example`/§5.3 [Задача 005-6]

Файл: [task-005-6-mcp-tools-budget-meta-env.md](tasks/task-005-6-mcp-tools-budget-meta-env.md)
Stub-First: **Phase 1** — три `src/tools/*.ts` (zod in/out + хендлер-стаб), регистрация в
`createServer`, `budgetStore` в `CreateServerDeps`, 3 новых ключа в `EnvSchema`, e2e red; **Phase 2** —
хендлеры через `resolveCapability` + `_meta.budget` + `isError`-путь, e2e green, spawn-e2e →
`tools/list === 8`.

- [ ] **[R-41]** MCP-tool `onchain_smart_money_flows` — zod in `{chain: z.enum(['ethereum','solana']),
tokenAddress: string.max(64)}` `.strict()` + тот же `superRefine`/`isValidAddress`-идиом, что
      M1-tools; out — `SmartMoneyFlow`; capability `smart-money.flows` (costOf = **10cr**:
      `/smart-money/netflow` 5 + `/tgm/holders` 5, всегда оба); `_meta.budget` присутствует на miss;
      contract/E2E на фикстуре зелёный, `isError`-путь (нет ключа / отказ бюджета) покрыт отдельно.
- [ ] **[R-42]** MCP-tool `onchain_entity_label` — zod in `{chain, query?: string.max(200),
tokenAddress?: string.max(64), exhaustive?: boolean = false}` + `superRefine`: требуется **хотя бы
      одно** из `query`/`tokenAddress`, а `exhaustive:true` обязывает `tokenAddress`; трёхуровневая
      цена: **0cr** (`/search/general` [+ `/search/entity-name`]) / **5cr** (`+ /tgm/holders`) /
      **100cr** (`exhaustive:true` — **только** `/profiler/address/labels`, не дублирует дешёвый
      путь); нулевой результат (адрес без меток) — валидный ответ, не ошибка; на `free`-плане
      100cr-путь **реально отказывает** (второй реальный отказ-кейс R-37).
- [ ] **[R-43]** MCP-tool `onchain_token_risk` — zod in/out (`TokenRiskScore`); источник —
      `/tgm/indicators` (5cr) + `/tgm/token-information` (1cr), **НЕ Dune** (явное решение TASK.md §4;
      `dune.isAvailable()` остаётся безусловно `false`, адаптер не оживляется); ответ несёт risk- и
      reward-группы **раздельно**; contract-тест на фикстуре.
- [ ] **[R-46]** Синхронизация env/доков: `EnvSchema` (`mcp-server/src/env.ts`) получает
      `NANSEN_API_KEY` + `NANSEN_DAILY_CREDIT_CAP` + `NANSEN_BUDGET_WARN_RATIO` (все опциональные,
      `emptyAsUndefined`-паттерн; `EnvSchema.parse({})` по-прежнему не бросает); `.env.example` —
      `NANSEN_API_KEY` переезжает из «M2+ зарезервировано» в «код читает сейчас» с комментарием про
      `apiKey`-схему (не Bearer) и budget-guard, рядом добавляются два новых опциональных ключа;
      `docs/architectures/interfaces.md` §5.3 — строка `nansen` уже присутствует, задача **сверяет**
      её с фактическим кодом (host/auth/транспорт) и правит только при расхождении.

### Шаг 7 — [R-44] Живая запись фикстур + live-verification [Задача 005-7] — **ЕДИНСТВЕННАЯ платная задача, ≈16cr**

Файл: [task-005-7-fixtures-live-verification.md](tasks/task-005-7-fixtures-live-verification.md)

- [ ] **[R-44]** Контрактные тесты на записанных **один раз** фикстурах + бюджет-дисциплина сборки:
      `packages/core/scripts/record-fixture.mjs` расширен на `nansen` (обязан сериализовать **JSON-тело
      POST-запроса**, не только query-string; проходит через ту же фабрику `createNansenAdapter`, не
      через хендроллед-пробник), **вне CI**; шесть живых вызовов по плану §0.1 (`/account` 0 +
      `/search/general` 0 + `/smart-money/netflow` 5 + `/tgm/holders` 5 + `/tgm/indicators` 5 +
      `/tgm/token-information` 1 = **16cr ≤ 30**); spec-derived фикстуры 005-4 **заменяются**
      реальными, те же golden-тесты прогоняются без правок ассертов; evidence-файл на каждый
      эндпоинт фиксирует реально наблюдённые поля **и реально наблюдённый `X-Nansen-Credits-Used`**
      — как **sanity-check** против статической `credit_cost_table`, НЕ как источник цены
      (расхождение = задокументированная находка вендор-дрейфа, не тихое принятие); после коммита
      фикстур `pnpm test` в offline-окружении зелёный и стоит **0** кредитов; фактический расход
      задачи записан в evidence.
      **Live-verification (M-6):** один живой вызов `onchain_smart_money_flows` из Claude Code
      закрывает пару «метки+потоки» (`/smart-money/netflow` + `/tgm/holders`, ≈10cr — те же вызовы,
      что запись фикстур, не дополнительные) — прямое доказательство exit-критерия #1.

### Шаг 8 — [R-40] Явная деградация + регрессия M1 + exit-критерии [Задача 005-8]

Файл: [task-005-8-degradation-regression-exit.md](tasks/task-005-8-degradation-regression-exit.md)

- [ ] **[R-40]** Явная деградация + отсутствие регрессии M1: (тест 1) пустой `.env` → все три
      M2-tool'а возвращают `isError: true` с понятной причиной (без утечки значения ключа), а
      `onchain_ping` + 4 M1-tool'а в **той же** сессии отвечают нормально; (тест 2, M-1b) бюджет
      **исчерпан** (не только отсутствует ключ) → тот же результат; полный M1-сьют остаётся зелёным
      **без правок ассертов M1-раздела** (baseline из 005-1); `_meta.cache`-контракт побитово тот же;
      grep-гейт диффа подтверждает: `registry.ts`, `resolve-capability.ts`, 4 M1-tool-файла и 9
      M1-адаптеров **не редактировались**.
- **Перепроверка (exit-mapping, не новые owning-пункты):** **R-37** — оба отказ-теста и
  atomicity-тест зелёные в полном прогоне; **R-39** — singleflight-тест зелёный; **R-44** —
  `pnpm test` в offline-окружении (сеть отключена) зелёный; scope-guard: нет Bitquery, нет
  `mcp.nansen.ai`, нет `/agent/fast`/`/agent/expert`, нет живого Dune-запроса, нет write-путей в
  Supabase, нет `croner`/BullMQ, нет HTTP/SSE-транспорта; DoD §6 прогнан целиком.

### Шаг 9 — [R-47] Carry-over M1-hardening [Задача 005-9] — **ОПЦИОНАЛЬНО, НЕ гейтит приёмку**

Файл: [task-005-9-optional-carryover-hardening.md](tasks/task-005-9-optional-carryover-hardening.md)

- [ ] **[R-47]** _(Should, не MVP — приёмка TASK-005 не зависит от этого пункта; берётся только если
      после 005-8 остался запас)_ `safeFetch` streaming byte-counter для chunked/no-`Content-Length`
      ответов (`net/safe-fetch.ts` — сейчас `maxResponseBytes` проверяется только по
      `Content-Length`); `rpc-solana` точный парсинг lamports для кошельков >~9.007M SOL (обрыв
      `MAX_SAFE_INTEGER`) через raw-text JSON parse. Если не реализовано — остаётся **явно
      отложенным** этим пунктом плана (и переносится в `docs/BACKLOG.md`), не пропущенным молча.

---

## 3. Полная трассировка RTM (R-29 … R-47)

| R-ID     | Требование (кратко)                                          | Задача | Фаза      | Тип          | Живые кредиты |
| -------- | ------------------------------------------------------------ | ------ | --------- | ------------ | ------------- |
| R-29     | Адаптер `nansen` (REST, POST JSON, `apiKey`, 429/402)        | 005-4  | Phase 1+2 | dev          | 0             |
| R-30     | Capability-декларации + маршруты + 10-я регистрация          | 005-1  | Phase 1   | dev          | 0             |
| R-31     | Канонический `SmartMoneyFlow`                                | 005-1  | Phase 1+2 | dev          | 0             |
| R-32     | Канонический `EntityLabel` (пустые метки — валидны)          | 005-1  | Phase 1+2 | dev          | 0             |
| R-33     | Канонический `TokenRiskScore` (risk/reward раздельно)        | 005-1  | Phase 1+2 | dev          | 0             |
| R-34     | Таблица `usage` (portable, epoch-ms, аддитивный upsert)      | 005-2  | Phase 1+2 | dev          | 0             |
| R-35     | `BudgetStore` + `SqliteBudgetStore` (immediate-транзакция)   | 005-2  | Phase 1+2 | dev          | 0             |
| R-36     | Потолок из живых данных (`/account`), `plan`-агностичный код | 005-3  | Phase 2   | dev          | 0             |
| R-37     | Pre-call gate: `costOf()` + `effectiveCeiling` + атомарность | 005-3  | Phase 2   | dev/test     | 0             |
| R-38     | Reconciliation ровно один раз на `fetch()`, Σ по под-ответам | 005-5  | Phase 2   | dev          | 0             |
| R-39     | Singleflight ДО check-and-reserve                            | 005-5  | Phase 2   | dev/test     | 0             |
| R-40     | Явная деградация + M1-регрессия                              | 005-8  | cross-cut | verify       | 0             |
| R-41     | Tool `onchain_smart_money_flows` (10cr)                      | 005-6  | Phase 1+2 | dev          | 0             |
| R-42     | Tool `onchain_entity_label` (0/5/100cr, opt-in эскалация)    | 005-6  | Phase 1+2 | dev          | 0             |
| R-43     | Tool `onchain_token_risk` (6cr, не Dune)                     | 005-6  | Phase 1+2 | dev          | 0             |
| R-44     | Фикстуры (запись один раз) + бюджет-дисциплина сборки        | 005-7  | Phase 2   | dev/verify   | **≈16**       |
| R-45     | Секретная дисциплина `NANSEN_API_KEY`                        | 005-4  | Phase 2   | dev/test     | 0             |
| R-46     | `EnvSchema` + `.env.example` + `interfaces.md` §5.3          | 005-6  | Phase 2   | dev/docs     | 0             |
| **R-47** | **Carry-over hardening — ОПЦИОНАЛЬНО (Should)**              | 005-9  | Phase 2   | dev (не MVP) | 0             |

**Exit-критерии ROADMAP §M2 (TASK.md §6) → задачи:**

- **«smart-money-запрос отдаёт метки+потоки»** → R-29 (005-4), R-30/R-31/R-32 (005-1), R-41/R-42
  (005-6), R-44 + live-verification (005-7).
- **«budget-guard реально режет при достижении лимита (тест)»** → R-34/R-35 (005-2), R-36/R-37
  (005-3) — два реальных отказ-кейса (150cr и 100cr) + atomicity-тест, R-38/R-39 (005-5),
  перепроверка в 005-8.
- **«деградация на free работает»** (реинтерпретировано, TASK.md §4) → R-40 (005-8) + регрессия
  R-16…R-20 из M1.
- **Риск-гейт «ключи только из `.env`, не в логах/кеш-ключах»** → R-45 (005-4), R-46 (005-6).
- **Риск-гейт «бюджет-алерт»** → sub-feature R-37 (005-3): stderr-предупреждение по
  `NANSEN_BUDGET_WARN_RATIO`, тот же канал, что M1 cache-метрики.

---

## 4. Разрешённые Open Questions TASK.md §7 — куда вплетены

| OQ       | Решение (архитектура)                                                                     | Задача       |
| -------- | ----------------------------------------------------------------------------------------- | ------------ |
| **OQ-1** | Day-бакет — собственный pacing; формула — anchor-relative `effectiveCeiling` (§0.2 п.2)   | 005-3        |
| **OQ-2** | Гейт — внутренний слой `fetch()` адаптера `nansen`, не Registry и не tool-хендлер         | 005-3, 005-5 |
| **OQ-3** | Chain-scope = `ethereum`+`solana` (как M1); расширение — backlog                          | 005-1, 005-6 |
| **OQ-4** | Эскалация `entity.labels` остаётся explicit opt-in **независимо от плана** (`exhaustive`) | 005-6        |
| **OQ-5** | **ДА** — опциональный `NANSEN_DAILY_CREDIT_CAP` (может только сузить) + `..._WARN_RATIO`  | 005-3, 005-6 |

---

## 5. Явно ОТЛОЖЕНО (NOT-in-M2) — сквозной scope-guard задачи 005-8

- **Bitquery-адаптер** — YAGNI, ключа нет, живого пробника не было (TASK.md §1 п.3/§4).
- **Официальный MCP-сервер Nansen** (`mcp.nansen.ai/ra/mcp`) как интеграционная поверхность —
  остаётся ручным/exploratory инструментом.
- **`/api/v1/agent/fast` (200cr) и `/api/v1/agent/expert` (750cr)** — потоковый natural-language
  ответ, нечего нормализовать в canonical zod.
- **`POST /profiler/address/premium-labels` (500cr)** — вне досягаемости текущего плана, не активная
  фича M2 (в cost-таблицу не попадает — её нет среди ~8 используемых эндпоинтов).
- **Живой Dune-запрос** (`token.holders`) — `onchain_token_risk` строится на Nansen, **не** на Dune
  (явное решение TASK.md §4); `dune.isAvailable()` остаётся безусловно `false`.
- **Расширение на все ~24–32 Nansen-сети** — задокументированный backlog, требует отдельного пробника
  **на способность**.
- **M3 целиком:** watchlists, `croner`, правила/алерты, Telegram; поглощение снапшоттера.
  Бюджет-алерт M2 = одна stderr-строка, не новый notification-канал.
- **Streamable HTTP MCP-транспорт** — M6; M2 остаётся stdio-only.
- **ERC-20/SPL enrichment `onchain_wallet_balances`** — M1-backlog, не относится к платному слою.
- **R-47** (carry-over hardening) — Should, задача 005-9, приёмку не гейтит.

---

## 6. Итоговая проверка плана (Definition of Done для M2)

Локально (без сети/секретов, порядок как в CI; **RF-1-safe**, задача 005-8):

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck                                # pnpm -r: core → mcp-server
pnpm test                                     # весь сьют: M1-baseline + M2 (budget/gate/singleflight/normalize/3 tools)
pnpm build
pnpm --filter @onchain-intel/mcp-server run smoke:dist
```

**Offline-гейт (R-44):** тот же `pnpm test` при отключённой сети — зелёный, 0 исходящих вызовов,
**0 кредитов**.

**Ручная проверка exit-критериев:** подключить `packages/mcp-server` в Claude Code как локальный
stdio MCP-сервер → **8 tools** видны → (a) без `NANSEN_API_KEY`: три M2-tool'а отдают `isError`,
4 M1-tool'а + `onchain_ping` работают; (b) с ключом: `onchain_smart_money_flows` отдаёт потоки +
метки холдеров, `_meta.budget.creditsUsedToday` растёт (**это и есть 10cr из плана 005-7, не
дополнительный расход**); повторный вызов в TTL → `_meta.cache.status === 'hit'` и `_meta.budget`
**отсутствует** (кеш-хит бюджет не тратит).

Финальный гейт (только по команде оркестратора): commit + push → GitHub Actions зелёный (Node 22).
