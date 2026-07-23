# TASK-003 — M1: MVP read-слой, только free (`m1-read-layer`)

## 0. Мета-информация

| Поле                | Значение                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **ID**              | TASK-003                                                                                                                    |
| **Slug**            | `m1-read-layer`                                                                                                             |
| **Дата создания**   | 2026-07-22                                                                                                                  |
| **Статус**          | Draft (готов к Architecture-фазе)                                                                                           |
| **Источник задачи** | Пользователь → «стартуем M1»                                                                                                |
| **Roadmap-ref**     | [ROADMAP.md](onchain-analytics/ROADMAP.md) §«M1 — MVP read-слой, только free»                                               |
| **ADR-ref**         | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md), решения D4–D7, D10–D12 (Accepted, 2026-07-20)             |
| **DB-схема-ref**    | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 (portable-конвенции — обязательны для кеш-БД)             |
| **Предыдущая фаза** | M0 ✅ выполнен 2026-07-22 ([task-001](tasks/task-001-m0-discovery-skeleton.md), [task-002](tasks/task-002-m0-docs-sync.md)) |

---

## 1. Контекст и цель

`onchain-intel` закрыл M0 (скелет MCP-сервера, `onchain_ping`, CI). M1 — первый содержательный
инженерный срез: агент должен отвечать на реальные ончейн-вопросы **без единого платного ключа**
(«лестница затрат» ROADMAP: M0–M1 = $0). Это **один сквозной прогон пайплайна** на весь M1-блок
ROADMAP — Planner нарезает его на атомарные задачи, но TASK/RTM здесь фиксируют весь срез целиком.

**Решения, зафиксированные пользователем на кикоффе (2026-07-22) — не пересматриваются в этой
задаче:**

1. **Снапшоттер/история остаются за n8n** (Supabase Postgres, схема `onchain`, dev VM) —
   движок их не поглощает в M1. Адаптер `dash-platform` в M1 — **строго READ-ONLY**: живые данные
   из DAPI/platform-explorer (keyless, primary⇄fallback), история — через **опциональное**
   read-only Postgres-подключение. Никакого кода записи снапшотов в M1.
2. **Кеш (D6) — двухуровневый, engine-local:** `lru-cache` (горячий, in-memory) +
   `better-sqlite3` (персистентный) в `DATA_DIR`; схема кеш-БД следует конвенциям
   DB-SCHEMA-CONCEPT §1 (переносимые типы, epoch-ms, app-generated ID, `PRAGMA foreign_keys=ON`).
   Кеш **не** живёт в Postgres.
3. Весь блок M1 — один пайплайн-прогон; атомарную нарезку задач делает Planner.

Это закрывает пункт из `MEMORY.md` («M1+ DB scope needs user clarification: Supabase Postgres
profile vs SQLite/DATA_DIR, D7») — для read-слоя движка выбор сделан явно (решение 2 выше):
состояние движка (кеш) — SQLite/`DATA_DIR`; Supabase Postgres остаётся доменом n8n-снапшоттера,
движок его только опционально читает (решение 1). Вопрос **закрыт** для скоупа M1, не переоткрывается.

**Выбор сетей для критерия «≥2 сетей» (см. §6):** **Ethereum (EVM) + Solana** — обе поддержаны
DexScreener (пары/TVL-релевантные данные) и CoinGecko (метаданные/цена токена); DeFiLlama покрывает
протоколы на обеих сетях. Выбор задокументирован здесь; Architect/Planner используют его как
конкретную пару для acceptance-проверок всех 4 tools.

**Открытая точка дизайна (не предписывается — решение Architect'а):** объём M1 (канонические типы +
registry + кеш) вероятно оправдывает выделение `packages/core` по D12 (целевая раскладка монорепо).
Analyst фиксирует это как кандидат, но не навязывает структуру пакетов — это предмет Architecture-фазы.

---

## 2. Use Cases

### UC-1: Разработчик поднимает read-слой с пустым `.env`

- **Main flow:** `pnpm install` → `pnpm build`/`pnpm test` зелёные без единого секрета → все
  keyless-адаптеры (DexScreener, DeFiLlama, dash-platform/DAPI, platform-explorer) работают из
  коробки; CoinGecko/Dune работают в demo/free-режиме без ключа (или с опциональным free-ключом).
- **Alt flow:** `COINGECKO_API_KEY`/`DUNE_API_KEY`/`ONCHAIN_PG_URL` не заданы → соответствующие
  усиленные возможности (выше rate-limit, история из PG) деградируют **явно и понятно**
  (сообщение с причиной), а не падают и не возвращают `undefined`.

### UC-2: Claude Code вызывает 4 MCP-tools на двух сетях

- **Main flow:** `onchain_get_token`, `onchain_new_pairs`, `onchain_protocol_tvl` вызываются с
  параметром сети `ethereum` и `solana` — оба возвращают валидный по zod-схеме canonical-ответ;
  провайдер-DTO не протекают наружу (anti-corruption layer, D4).
- **Alt flow:** `onchain_wallet_balances` — провайдер-бэкенд для free-tier уточняется в
  Architecture/Planning (см. Open Questions OQ-1); TASK фиксирует контракт tool (zod in/out), не
  конкретный провайдер.

### UC-3: Повторный вызов — кеш-хит виден в метриках

- **Main flow:** первый вызов `onchain_get_token(ethereum, X)` — cache miss, идёт сетевой fetch;
  повторный вызов с теми же нормализованными аргументами в пределах TTL — cache hit, сетевой вызов
  не происходит; счётчик hit/miss виден (лог/tool/debug-метрика) — exit-критерий ROADMAP.
- **Alt flow:** аргументы отличаются (другой токен/сеть) или TTL истёк → корректный cache miss,
  новый fetch, запись в оба уровня кеша.

### UC-4: Горячая замена адаптера — DAPI недоступен

- **Main flow:** `dash-platform` (DAPI) — primary для платформенных метрик; shielded-эндпоинты пока
  «not yet available on public nodes» (addendum 2026-07-20) → registry маршрутизирует на
  `platform-explorer` (fallback) без падения способности — первое доказательство принципа 4
  ROADMAP («адаптеры горячо заменяемы»).
- **Alt flow:** оба источника недоступны (сеть упала) → способность возвращает явную ошибку с
  указанием, что оба провайдера недоступны, а не тихий пустой ответ.

### UC-5: Контрактные тесты гоняются без сети

- **Main flow:** CI выполняет golden-нормализацию против записанных фикстур (D11) — 0 сетевых
  вызовов, 0 трат; тесты детерминированы.
- **Alt flow:** нужна новая/обновлённая фикстура → отдельный **ручной** dev-скрипт делает один
  живой вызов, записывает фикстуру + пробную evidence (реальный список полей/эндпоинтов на момент
  записи — vendor-drift дисциплина), в CI не участвует.

---

## 3. В рамках задачи (In Scope)

- Канонические zod-типы (D5): `Token`, `Wallet`, `Balance`, `OHLCV`, `Pool` + `Snapshot`
  (версионируемые; provider DTO не протекают наружу).
- Adapter + Capability Registry (D4): интерфейс `capabilities()/costOf()/fetch()/normalize()`,
  декларативный `providers.config.ts`, приоритет free→paid (в M1 все — free).
- Free-адаптеры: CoinGecko (free/demo tier, опц. ключ), DexScreener (keyless), DeFiLlama
  (free/keyless), Dune Query API (free tier 2 500 кредитов/мес, нужен free-ключ — всё ещё $0).
- Адаптеры `dash-platform` (DAPI, primary, keyless) + `platform-explorer` (fallback + history,
  keyless) — capability `privacy.shielded_pool` + Platform-метрики (identities/contracts/
  documents/credits); **строго READ-ONLY**; опциональное read-only PG-подключение
  (`ONCHAIN_PG_URL`) для истории.
- Двухуровневый кеш (D6): `lru-cache` + `better-sqlite3` в `DATA_DIR`; ключ =
  `(provider, capability, normalizedArgs)`; TTL по типу данных; схема — по DB-SCHEMA-CONCEPT §1,
  спроектирована так, чтобы `usage`-таблица (M2, budget guard) добавилась без миграционной боли.
- MCP-tools: `onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`,
  `onchain_protocol_tvl` — zod in/out схемы как единственный источник правды (D3); существующий
  `onchain_ping` не трогается.
- Контрактные тесты (D11): записанные фикстуры на провайдер, golden-нормализация; без живой сети
  в CI; ручной dev-скрипт для (пере)записи фикстур.
- Расширение `EnvSchema` (D10): новые **опциональные** ключи (`COINGECKO_API_KEY`, `DUNE_API_KEY`,
  `ONCHAIN_PG_URL`, `DATA_DIR`); пустой env остаётся валидным; секреты не логируются и не попадают
  в ключ кеша.
- Риск-гейты ROADMAP: SSRF-гейт на исходящий fetch (host allowlist из `providers.config.ts`);
  per-provider rate-limit/throttle.

## 4. Вне рамок (Out of Scope) — явно

- **Платные провайдеры / Nansen** — M2.
- **Credit-budget guard** (таблица `usage`, дневной потолок, деградация на превышении) — M2; в M1
  только проектируем схему кеш-БД так, чтобы `usage` легла без миграции, саму логику не пишем.
- **Запись снапшотов** (snapshot-writing) — остаётся за n8n/Supabase; движок в M1 только читает.
- **ZecHub-ингест** — отдельный скрипт вне движка до M3 (нужен только калибровке порогов).
- **Планировщик** (`croner`/durable job-log) — M3.
- **Watchlists** — M3.
- **Streamable HTTP MCP-транспорт** — M6; M1 остаётся stdio-only.
- **Скилл `onchain-analytics` в Universal-skills** — M4.
- Любые дополнительные MCP-tools сверх названных 4 + существующего `onchain_ping`.

---

## 5. Requirements (RTM)

| ID   | Requirement                                                                                                                                                                    | Priority | Acceptance Criteria                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | Канонические zod-типы `Token`, `Wallet`, `Balance`, `OHLCV`, `Pool` (D5), единый источник правды, provider DTO не протекают наружу                                             | Must     | Типы экспортированы из общего модуля; ни один `tools/*.ts` не импортирует provider-специфичный тип наружу; unit-тест валидирует каждый тип на примере данных                                                                                                                        |
| R-2  | Канонический тип `Snapshot` (D5, версионируемый) — персистентная форма согласована с DB-SCHEMA-CONCEPT §1                                                                      | Must     | `Snapshot` содержит `metric, asset, ts, value_raw (string), value_num?, source, height?`; unit-тест на сериализацию/валидацию                                                                                                                                                       |
| R-3  | `ProviderAdapter` интерфейс: `capabilities()/costOf()/fetch()/normalize()` (D4)                                                                                                | Must     | Интерфейс типизирован в общем модуле; минимум 2 адаптера реализуют его без `any`-протечек                                                                                                                                                                                           |
| R-4  | Декларативный `providers.config.ts` — маршрутизация по capability, приоритет free→paid                                                                                         | Must     | Регистр читает конфиг, выбирает провайдера по приоритету и доступности ключа; смена приоритета — правка конфига, без изменения кода вызывающей стороны                                                                                                                              |
| R-5  | Адаптер CoinGecko (free/demo tier, опц. `COINGECKO_API_KEY`)                                                                                                                   | Must     | `capabilities()` включает `token.price`/`token.metadata`; contract-тест на записанной фикстуре зелёный; работает и без ключа (demo/free-режим)                                                                                                                                      |
| R-6  | Адаптер DexScreener (keyless)                                                                                                                                                  | Must     | `capabilities()` включает `pairs.new`/`pool.info`; contract-тест зелёный без ключа                                                                                                                                                                                                  |
| R-7  | Адаптер DeFiLlama (free/keyless)                                                                                                                                               | Must     | `capabilities()` включает `protocol.tvl`; contract-тест зелёный без ключа                                                                                                                                                                                                           |
| R-8  | Адаптер Dune Query API — **config-stub** в Capability Registry (M1); live `token.holders`-запрос — M2 (сужено по ARCHITECTURE v2.1, 2026-07-22)                                | Should   | id `dune` зарегистрирован как config-stub (capabilities объявлены, `fetch()` — заглушка, `isAvailable() === false` без `DUNE_API_KEY`); никакого живого вызова и фикстуры в M1; live-запрос + contract-тест на фикстуре переезжают в M2 (первый потребитель — `onchain_token_risk`) |
| R-9  | Адаптер `dash-platform` (DAPI, primary, keyless) — capability `privacy.shielded_pool` + Platform-метрики                                                                       | Must     | `capabilities()` включает `privacy.shielded_pool`, `platform.identities/contracts/documents/credits`; contract-тест на фикстуре; никакого кода записи                                                                                                                               |
| R-10 | Адаптер `platform-explorer` (fallback + history, keyless)                                                                                                                      | Must     | Реализует те же capability, что и DAPI, для fallback; при доступности — отдаёт history через отдельный метод                                                                                                                                                                        |
| R-11 | Горячая замена: DAPI недоступен/эндпоинт «not yet available» → registry маршрутизирует на platform-explorer                                                                    | Must     | Интеграционный тест (на фикстурах) симулирует недоступность DAPI-эндпоинта → способность отвечает через fallback, без падения                                                                                                                                                       |
| R-12 | Опциональное READ-ONLY Postgres-подключение (`ONCHAIN_PG_URL`) для истории dash-platform; никакого write-пути                                                                  | Should   | При отсутствии `ONCHAIN_PG_URL` — capability истории явно недоступна (понятная причина, не крэш); при наличии — только `SELECT`-запросы, ни одного `INSERT/UPDATE` в коде движка                                                                                                    |
| R-13 | Двухуровневый кеш: `lru-cache` (hot) + `better-sqlite3` (persistent) в `DATA_DIR` (D6)                                                                                         | Must     | Ключ = `(provider, capability, normalizedArgs)`; TTL параметризован по типу данных; unit-тест на hit/miss обоих уровней                                                                                                                                                             |
| R-14 | Схема кеш-БД следует DB-SCHEMA-CONCEPT §1 (переносимые типы, epoch-ms, app-generated ULID, `PRAGMA foreign_keys=ON`) и спроектирована под будущую `usage`-таблицу без миграции | Must     | DDL кеш-таблицы использует только `TEXT/INTEGER/REAL`; время — epoch-ms `INTEGER`; id — ULID; `PRAGMA foreign_keys=ON` включена при открытии соединения; ревью подтверждает совместимость с будущим добавлением `usage`                                                             |
| R-15 | Cache-hit/miss метрики видимы (exit-критерий ROADMAP)                                                                                                                          | Must     | Повторный вызов той же способности с теми же аргументами логирует/считает `cache=hit`; первый вызов — `cache=miss`; проверяемо в тесте или debug-выводе                                                                                                                             |
| R-16 | MCP-tool `onchain_get_token` — zod in/out, работает на ≥2 сетях (ethereum, solana)                                                                                             | Must     | E2E/contract-тест вызывает tool для токена на ethereum и на solana — оба ответа валидны по `PingOutputSchema`-аналогу для этого tool                                                                                                                                                |
| R-17 | MCP-tool `onchain_wallet_balances` — zod in/out, контракт зафиксирован; провайдер-бэкенд для ≥2 сетей — по итогам OQ-1                                                         | Must     | Input/output-схема существует и покрыта unit-тестом на форму; интеграция с конкретным free-провайдером — предмет Architecture/Planning (не блокирует TASK)                                                                                                                          |
| R-18 | MCP-tool `onchain_new_pairs` — zod in/out, работает на ≥2 сетях (ethereum, solana)                                                                                             | Must     | Contract-тест на фикстурах DexScreener для обеих сетей зелёный                                                                                                                                                                                                                      |
| R-19 | MCP-tool `onchain_protocol_tvl` — zod in/out, работает на ≥2 сетях (ethereum, solana)                                                                                          | Must     | Contract-тест на фикстурах DeFiLlama для обеих сетей зелёный                                                                                                                                                                                                                        |
| R-20 | Существующий `onchain_ping` не меняется по контракту                                                                                                                           | Must     | `PingInputSchema`/`PingOutputSchema` и regression-тесты из M0 остаются зелёными без правок                                                                                                                                                                                          |
| R-21 | Контрактные тесты (D11): записанные фикстуры на провайдер, golden-нормализация, без сети в CI                                                                                  | Must     | `pnpm test` не делает исходящих сетевых вызовов (проверяемо: тест в offline/no-network окружении проходит); фикстуры лежат в repo                                                                                                                                                   |
| R-22 | Ручной dev-скрипт (пере)записи фикстур с probe-evidence (vendor-drift дисциплина)                                                                                              | Should   | Скрипт не входит в CI; при записи фикстуры фиксирует фактический список полей/эндпоинтов на дату записи (не предположение)                                                                                                                                                          |
| R-23 | `EnvSchema` расширен новыми опциональными ключами; пустой env остаётся валидным (D10)                                                                                          | Must     | `EnvSchema.parse({})` не бросает; каждый новый ключ optional; секреты не логируются, не входят в cache-key                                                                                                                                                                          |
| R-24 | Явная деградация при отсутствующем опциональном ключе/DSN — с понятной причиной, не молча                                                                                      | Should   | Вызов способности без нужного ключа/DSN возвращает структурированную ошибку/предупреждение с указанием какого ключа не хватает (без утечки значения)                                                                                                                                |
| R-25 | SSRF-гейт: host allowlist для исходящего fetch, производный из `providers.config.ts`                                                                                           | Must     | Попытка fetch на хост вне allowlist отклоняется до сетевого вызова; unit-тест подтверждает                                                                                                                                                                                          |
| R-26 | Per-provider rate-limit / client-side throttle                                                                                                                                 | Should   | Превышение локального лимита задерживает/отклоняет вызов до похода в сеть; тест на throttle-логике                                                                                                                                                                                  |
| R-27 | Scope guard: diff не содержит платных провайдеров, write-путей, планировщика, HTTP-транспорта, watchlists                                                                      | Must     | Ревью PR подтверждает отсутствие кода вне §3 In Scope                                                                                                                                                                                                                               |
| R-28 | Acceptance-сниппеты в PLAN/task-файлах исполнимы на macOS + pnpm 11 (без bare `timeout`, без ошибочного `--`-форвардинга)                                                      | Should   | Каждый acceptance-сниппет вручную прогнан на macOS zsh перед фиксацией в файле задачи (RF-1 lesson, `docs/issues/rf-1-...md`)                                                                                                                                                       |

---

## 6. Трассировка Exit-критериев (ROADMAP §M1 + уточнение пользователя)

| Exit-критерий                                                                       | R-IDs                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| Все 4 tools отвечают на **≥2 сетях** (выбор: **ethereum + solana**, см. §1)         | R-16, R-17, R-18, R-19, R-5, R-6, R-7, R-8     |
| Cache-hit виден в метриках при повторном вызове                                     | R-13, R-14, R-15                               |
| **$0 трат** (без платных ключей)                                                    | R-4, R-5, R-6, R-7, R-8, R-9, R-10, R-23, R-24 |
| Golden-тесты нормализации зелёные                                                   | R-1, R-2, R-3, R-21, R-22                      |
| Scope guard: нет платных провайдеров / write-путей / планировщика / HTTP-транспорта | R-12, R-27                                     |

---

## 7. Open Questions

Блокирующих вопросов для старта Architecture-фазы нет (ключевые развилки уже закрыты кикоффом
пользователя, §1). Зафиксированы как **неблокирующие**, но требующие решения до соответствующей
атомарной задачи в Planning/Architecture:

- **OQ-1 — чем backend'ить `onchain_wallet_balances` на $0 для ethereum + solana?** Ни один из
  явно перечисленных free-адаптеров (CoinGecko, DexScreener, DeFiLlama) нативно не отдаёт баланс
  произвольного кошелька. Кандидат — Dune Query API через собственноручно написанный
  parameterized-запрос (ERC-20 + SPL balances по адресу), но это требует **живого пробника** перед
  фиксацией в архитектуре (дисциплина «vendor counters drift» — не хардкодить предположение).
  Альтернатива — keyless EVM/Solana RPC-нода напрямую (`eth_getBalance`/`getBalance` +
  токен-листинг) как отдельная не-провайдерная capability. Решение — за Architect/Planner до
  начала соответствующей атомарной задачи.
- **OQ-2 — нужен ли в M1 отдельный MCP-tool для Platform-метрик dash-platform** (identities/
  contracts/documents/credits/shielded_pool), или в этой фазе адаптер регистрируется в Capability
  Registry и покрывается contract-тестами **без** отдельного tool (tool — уже M1.5/M3, когда
  появятся privacy-правила)? ROADMAP называет ровно 4 tool на M1, ни один явно не про
  Platform-метрики. Решение — за Architect.
- **OQ-3 (не блокирует, зафиксировано как предложение, не решение)** — стоит ли уже в M1 выделять
  `packages/core` (канонические типы + registry + кеш) отдельным pnpm-пакетом по D12, или оставить
  всё в `packages/mcp-server` ещё один срез (режем по швам позже). Явно оставлено на усмотрение
  Architect'а — Analyst не предписывает.
