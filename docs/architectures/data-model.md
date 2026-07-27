# 4. Data Model (Conceptual)

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 4.1. Entities Overview

**Канонические типы (M1, `packages/core/src/types/*`)** — см. полные zod-схемы в §3.2. Кратко:

#### Entity: `Token`

- **Описание:** метаданные + цена токена на конкретной сети/адресе.
- **Ключевые атрибуты:** `chain`, `address` (нормализован), `symbol`, `name`, `decimals?`,
  `priceUsd?`, `marketCapUsd?`, `source`, `fetchedAt`.
- **Business rule:** `address` всегда прошёл `normalizeAddress(chain, raw)` до попадания в тип —
  ни один адаптер не кладёт сырой ввод пользователя в канонический объект напрямую.

#### Entity: `Wallet` / `Balance`

- **Описание:** список балансов кошелька на сети. `Balance` — элемент массива, различает
  `assetType: 'native' | 'token'` — в M1 заполняется только `'native'` (§3.2 решение).
- **Relationships:** `Wallet 1:N Balance` (встроенный массив, не отдельная таблица — M1 не
  персистирует их вне кеша).
- **Business rule:** `amountRaw` — точное целое **строкой** (DB-SCHEMA §1.7 конвенция: wei/lamports
  превышают безопасные 2^53); `amountNum` — lossy-проекция, никогда не источник истины.

#### Entity: `Pool`

- **Описание:** торговая пара (DEX) — используется `onchain_new_pairs`.
- **Ключевые атрибуты:** `id`, `chain`, `dexId`, `baseTokenSymbol`/`quoteTokenSymbol`,
  `pairAddress`, `createdAt?`, `liquidityUsd?`, `volume24hUsd?`, `source`, `fetchedAt`.

#### Entity: `OHLCV` (зарезервирован, не потребляется в M1)

- Поля — см. §3.2 схема. Существует для R-1 (тип должен существовать), первый потребитель — M1.5+.

#### Entity: `Snapshot` (D5-дополнение, персистентная форма — DB-SCHEMA-CONCEPT §2)

- Движок его **не пишет** (n8n пишет, TASK.md §1) и, по решению владельца 2026-07-25, **не начнёт**:
  автономный контур остаётся на n8n + Postgres (ADR-001 D8-дополнение). Тип существует как
  каноническая форма ЧТЕНИЯ той же `snapshots`-таблицы — её читает адаптер `pg-history` (R-12).
  Ранее здесь стояло «для будущего M3 поглощения снапшоттера» — поглощение отменено.
- **Маппинг имён на persistence-границе (minor, ревью цикл 1):** `SnapshotSchema` — camelCase
  (`valueRaw`, `valueNum`); персистентная колонка DB-SCHEMA §2 — snake_case (`value_raw`,
  `value_num`). `metric`/`asset`/`ts`/`source`/`height` совпадают буквально и не переименовываются.
  Движок `snapshots` не пишет, поэтому маппинг нигде не реализован — но он понадобится на
  **читающей** стороне, когда правила M3 начнут разбирать историю: явный (де)сериализатор именно
  для `valueRaw↔value_raw`/`valueNum↔value_num`, не автоматический camelCase→snake_case по всем
  полям. Зафиксировано заранее, чтобы M3 не открывал вопрос заново. (Формулировка «когда M3
  поглощает снапшоттер» устарела — поглощение отменено 2026-07-25, направление маппинга сменилось
  с записи на чтение, сам маппинг остался нужен.)

#### Entity: `SmartMoneyFlow` (M2, TASK-005, D5-расширение, R-31)

- **Описание:** net-flow «умных денег» по токену (несколько скользящих окон) + верхние
  holder-адреса с метками — используется `onchain_smart_money_flows`. Композитный тип: строится
  из ДВУХ Nansen-эндпоинтов (`POST /smart-money/netflow` → `SmartMoneyNetflowResponse.data[]`,
  `POST /tgm/holders` → `TGMHoldersResponse.data[]`), объединённых в один `nansen.fetch()`-вызов
  (§3.2) — не два отдельных canonical-типа.
- **Ключевые атрибуты (поле-в-поле трассируется на `nansen-openapi-2026-07-23.json`'s
  `SmartMoneyNetflow`/`TGMHolder` схемы, разведка этой архитектуры):** `chain`, `tokenAddress`
  (нормализован через `normalizeAddress`), `tokenSymbol`, `netflow1hUsd`/`netflow24hUsd`/
  `netflow7dUsd`/`netflow30dUsd` (`SmartMoneyNetflow.net_flow_{1h,24h,7d,30d}_usd` — **четыре**
  скользящих окна, не одно генерическое `windowStart`/`windowEnd`: реальный ответ не даёт
  произвольного окна, он даёт фиксированный набор; уточнение TASK.md R-31's иллюстративной
  формулировки по живой эвиденции, не расхождение с ней — R-31 «netflowUsd» трактуется как
  минимальная планка, `netflow24hUsd` её покрывает, остальные три — дополнительная точность),
  `traderCount?`/`tokenAgeDays?`/`tokenSectors?[]` (`SmartMoneyNetflow.trader_count`/
  `token_age_days`/`token_sectors`), `topHolders[]` (из `TGMHolder[]`: `{address, addressLabel?,
tokenAmount?, valueUsd?, ownershipPercentage?}` — подмножество полей `TGMHolder`, не полный
  DTO), `source`, `fetchedAt`.
- **Business rule:** anti-corruption — Nansen DTO (`SmartMoneyNetflow`/`TGMHolder`, включая
  обёртку `{data, pagination}`) не протекает наружу, тот же паттерн, что `Token`/`Pool` (§3.2).
  Golden-тест на фикстуре (R-31 acceptance).

#### Entity: `EntityLabel` (M2, TASK-005, D5-расширение, R-32)

- **Описание:** метка адреса/сущности (кошелёк, фонд, биржа, известный трейдер) — используется
  `onchain_entity_label`. Источник зависит от tier'а вызова (§3.2 costOf()-таблица): дефолт —
  `POST /search/general` → `GeneralSearchResponse.{tokens[], entities[]}`
  (`TokenSearchResult`/`EntitySearchResult`); token-scoped обогащение — `TGMHolder.address_label`;
  exhaustive-эскалация — `POST /profiler/address/labels` (форма ответа не эксплорится этой
  архитектурой сверх известной по costOf()-таблице цены — Development-фаза фикстурирует её живым
  вызовом при первом реальном использовании, R-44).
- **Ключевые атрибуты:** `chain?` (опционален — `EntitySearchResult` НЕ несёт chain/address,
  сущность может быть кросс-чейн: имя/tags без привязки к конкретному адресу; `TokenSearchResult`/
  `TGMHolder`-производные результаты его несут), `address?` (по той же причине — опционален),
  `name?`, `tags[]` (default `[]`, из `EntitySearchResult.tags`), `labels[]` (default `[]`, из
  `TGMHolder.address_label`, обёрнутого в массив — **пустой массив — валидный результат**, «нет
  меток», не ошибка, R-32), `premiumRequested: boolean` (явный флаг — `true` только когда вызов
  прошёл через `exhaustive: true`-путь, R-42), `source`, `fetchedAt`.
- **Business rule:** ни `chain`, ни `address` не обязательны одновременно (в отличие от `Token`/
  `Wallet`) — единственный M2-тип, где это так, ввиду реальной формы `EntitySearchResult`. Golden-
  тесты на фикстуре с ≥1 меткой И на фикстуре с 0 меток (R-32 acceptance).

#### Entity: `TokenRiskScore` (M2, TASK-005, D5-расширение, R-33)

- **Описание:** risk/reward-индикаторы токена — используется `onchain_token_risk`. Композитный
  тип: `POST /tgm/indicators` (`TGMIndicatorsResponse`) + `POST /tgm/token-information` (метаданные
  токена), один `nansen.fetch()`-вызов.
- **Ключевые атрибуты (трассируются на `TGMIndicatorsResponse`/`TGMIndicatorTokenInfo`/
  `TGMIndicator` схемы):** `chain`, `address`, `marketCapUsd?`/`marketCapGroup?`/`isStablecoin?`
  (`TGMIndicatorTokenInfo`), `riskIndicators[]`/`rewardIndicators[]` — **раздельные** массивы
  (R-33 «не сплющено в один список»), каждый элемент `{indicatorType, score?, signal?,
signalPercentile?, lastTriggerOn?}` (`TGMIndicator` — `score` качественный: risk →
  low/medium/high, reward → bearish/neutral/bullish, по спеке; `signal`/`signalPercentile` —
  `number`, НЕ строки, R-33 — это не wei-подобные ончейн-целые, безопасно для JS-`number`/`REAL`),
  `source`, `fetchedAt`.
- **Business rule:** anti-corruption, golden-тест на фикстуре (R-33 acceptance).

#### Entity: `ChainInfo` (TASK-006, R-48) — **реестр сетей**

- **Описание:** описание одной сети целиком. Это **не** canonical-тип домена в смысле D5 (не
  наблюдение, полученное от провайдера) — это **справочник**, по которому canonical-типы
  интерпретируются. Отсюда и место хранения: **вендоренный артефакт сборки**, а не таблица БД
  и не сетевой запрос (обоснование — §4.2.1 ниже).
- **Ключевые атрибуты:**

| Поле           | Тип                                                         | Назначение                                                                                                                                                                |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caip2`        | `string` **PK**                                             | Канонический id в форме CAIP-2: `eip155:80094`, `solana:5eykt4Xhм…`. Единственное, что попадает в ключ кеша и в маршруты.                                                 |
| `slug`         | `string` UNIQUE                                             | Человекочитаемый канонический slug (`berachain`) — то, что агент пишет в `chain` и что возвращает `onchain_list_chains`.                                                  |
| `name`         | `string`                                                    | Отображаемое имя (`Berachain`).                                                                                                                                           |
| `family`       | `'evm' \| 'svm' \| 'move' \| 'cosmos' \| 'utxo' \| 'other'` | Определяет **валидацию адреса** (R-55) и способность `rpc-evm` обслужить сеть.                                                                                            |
| `aliases`      | `string[]`                                                  | Все прочие принимаемые написания, включая **legacy `ethereum`/`solana`** (R-59a) и вендорские id. Уникальны глобально.                                                    |
| `nativeSymbol` | `string \| null`                                            | Нативный символ (`BERA`) — потребляется `pairs.new` (R-57a) вместо хардкода.                                                                                              |
| `vendors`      | `Record<vendorId, string \| null>`                          | **Только именование:** как эта сеть называется у вендора. `defillama`→`"Berachain"`, `coingecko`→`"berachain"`, `dexscreener`→`"berachain"`. `null` = у вендора сети нет. |
| `rpcHosts`     | `string[] \| null`                                          | Курируемый SSRF-allowlist для этой сети (R-56a). `null` = `wallet.balances.native` честно непокрыт, см. §7.2.                                                             |
| `tvlUsdAtSync` | `number \| null`                                            | TVL **на момент синхронизации реестра**, заведомо устаревший. Существует **исключительно** для фильтра/ранжирования в `onchain_list_chains` без сети.                     |
| `deprecated`   | `boolean`                                                   | Сеть исчезла у вендоров, но строка сохранена (R-49f) — ссылки и ключи кеша не ломаются.                                                                                   |

- **Relationships:** `ChainInfo 1:N` алиасы (встроенный массив). Ссылок на другие сущности нет —
  наоборот, `Token`/`Wallet`/`Pool`/`SmartMoneyFlow` ссылаются на `ChainInfo.caip2` через своё
  поле `chain`.

- **Business rules (каждое — тест, R-60c):**
  1. `caip2` уникален; `slug` уникален; **множество всех `aliases` не пересекается ни с одним
     `slug` и ни с одним другим `aliases`** — иначе резолв неоднозначен. Проверяется на старте.
  2. **Алиас резолвится в `caip2` ДО построения ключа кеша.** Иначе `"ethereum"` и `"eip155:1"`
     дадут две разные записи кеша для одного и того же запроса. Это не оптимизация, а
     корректность (§4.2.2).
  3. `tvlUsdAtSync` **никогда** не возвращается как ответ на вопрос «какой TVL» — для этого есть
     `chain.tvl` (R-53). В выдаче `onchain_list_chains` поле называется
     `tvlUsdAtRegistrySync`, чтобы спутать было нельзя.
  4. `vendors` описывает **именование, а не покрытие.** Покрытие — производная величина
     (§4.2.3), и смешивать их запрещено: иначе «Nansen не знает эту сеть» и «мы не проверяли
     Nansen на этой сети» становятся неразличимы (R-58d).

#### Entity: `CoverageProbe` (TASK-006, R-58) — зафиксированный факт проверки вендора

- **Описание:** результат живой пробы chain-покрытия вендора, чьё покрытие нельзя вывести из
  публичного каталога. В MVP — ровно один потребитель: `nansen`.
- **Ключевые атрибуты:** `vendorId`, `probedAt` (epoch-ms UTC), `chains: string[]` (caip2,
  подтверждённые живой пробой), `creditsSpent`, `evidencePath` (файл в `raw/`).
- **Business rule:** отсутствие пробы означает **`unverified`, а не `unsupported`** (R-58d).
  Деградированный путь описан в §4.2.3.

### 4.2. Логическая модель — кеш-БД (`DATA_DIR/cache.sqlite3`)

Полный DDL — §3.2 «Модуль `src/cache/*`». Кратко: `providers(id PK)` ← `cache_entries(provider
FK, capability, args_hash, value_json, created_at, expires_at, UNIQUE(provider,capability,
args_hash))`. Портируемые типы (`TEXT`/`INTEGER`), epoch-ms `INTEGER`, app-generated `TEXT` ULID
id, `PRAGMA foreign_keys=ON` — DB-SCHEMA-CONCEPT §1 применены буквально к новому контексту (кеш,
не аналитический снапшот — см. апсерт-семантику §3.2, отличную от append-only `snapshots`). **Все
девять `adapterRegistrations` (включая `pg-history` — F-2, ревью цикл 1) upsert-ятся в
`providers` при старте** — ни один кеш-хит/промах не может сослаться на несуществующий
`provider`, FK не нарушается ни для одного адаптера, зарегистрированного в `providers.config.ts`.

**M2-дополнение (TASK-005, R-34): `usage(provider FK, day, credits_used)`** — та же кеш-БД, тот же
`providers`-реестр как FK, **без миграции** `providers`/`cache_entries` (форвард-компат комментарий
в `cache/ddl.ts` был подготовлен уже в M1). Портируемые типы буквально (DB-SCHEMA-CONCEPT §1):

```sql
CREATE TABLE IF NOT EXISTS usage (
  provider     TEXT NOT NULL REFERENCES providers(id),
  day          INTEGER NOT NULL,           -- epoch-ms UTC bucket start: floor(ts/86400000)*86400000
  credits_used INTEGER NOT NULL DEFAULT 0, -- АДДИТИВНЫЙ счётчик — см. семантику upsert ниже
  updated_at   INTEGER NOT NULL,           -- epoch-ms UTC последней записи (только для наблюдаемости)
  PRIMARY KEY (provider, day)
);
```

**SEC-1 (2026-07-27): `usage_window(provider FK, window_start, credits_used)`** — тот же аддитивный
счётчик, но с бакетом в 60 секунд вместо суток. Отдельная таблица, а не колонка `bucket_width` в
`usage`: дневной счётчик обязан продолжать суммировать сутки, и совмещение двух ширин в одной
колонке сделало бы каждый существующий SELECT неоднозначным и потребовало миграции. Добавлена как
обычный `CREATE TABLE IF NOT EXISTS` к тому же реестру `providers` — не мигрирует ничего.

```sql
CREATE TABLE IF NOT EXISTS usage_window (
  provider     TEXT NOT NULL REFERENCES providers(id),
  window_start INTEGER NOT NULL,           -- epoch-ms UTC: floor(ts/60000)*60000
  credits_used INTEGER NOT NULL DEFAULT 0, -- тот же знаковый аддитивный upsert, тот же MAX(0, …)
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, window_start),
  CHECK (credits_used >= 0)
);
```

Читается и пишется **внутри той же транзакции**, что и дневная бронь (`checkAndReserve`): иначе два
процесса, делящих один `cache.sqlite3` — поддерживаемая топология, несколько stdio-сессий на машину,
— каждый прошёл бы свою проверку окна по устаревшему чтению. Строки старше часа удаляются
оппортунистически в той же транзакции: читается всегда только ТЕКУЩЕЕ окно, остальное — хранение
для разбора постфактум, а строка в минуту на провайдера навсегда — медленная утечка в `DATA_DIR`.

- `day` — **`INTEGER` epoch-ms** (day-bucket start), не строковая дата — DB-SCHEMA §1.2/CLAUDE.md
  канон буквально; несмотря на то что ADR-001 D6 называет колонку «day», буквальная строка-дата
  противоречила бы канону — бакетируется тем же паттерном, что `ts_bucket` у n8n-снапшоттера.
- `credits_used` — `INTEGER` (не `value_raw TEXT`-паттерн: это малый внутренний счётчик кредитов
  движка в пределах безопасного JS-`number`, не canonical-наблюдение произвольной точности — не
  `Snapshot`, поэтому `INTEGER` не противоречит канону, R-34).
- **`PRIMARY KEY (provider, day)` — natural dedup key, ДВЕ фазы записи через ОДИН и тот же
  аддитивный upsert** (не overwrite-upsert, каким `cache_entries.set()` пишет свою строку):

  ```sql
  INSERT INTO usage (provider, day, credits_used, updated_at)
  VALUES (@provider, @day, @delta, @now)
  ON CONFLICT (provider, day) DO UPDATE SET
    -- MAX(0, …) — belt-and-braces (C-2 review): @delta ЗНАКОВАЯ (post-call reconciliation, §3.2,
    -- пишет actual-reserved, может быть отрицательной) — но credits_used обязан оставаться
    -- неотрицательным счётчиком по построению; без этого зажима любой пограничный/дефектный путь
    -- (напр. bucket, ошибочно НЕ зафиксированный на момент резервации, §3.2 «dayBucketMs
    -- фиксируется один раз») мог бы протолкнуть отрицательное число в новый день-бакет и нарушить
    -- задокументированный «never-overwritten, только растёт или остаётся» инвариант этой колонки.
    credits_used = MAX(0, credits_used + excluded.credits_used),
    updated_at = excluded.updated_at;
  ```

  (a) pre-call **резервирование** — `@delta = costOf()` (точная цена, R-37); (b) post-call
  **реконсиляция** — `@delta = actual − reserved` (подписанная дельта, может быть отрицательной,
  R-38). Тот же самый SQL-паттерн для обеих фаз — не «замещающая» запись, иначе задвоился бы или
  потерялся расход (§3.2 разбирает это подробно). **`day` в обеих фазах одного вызова — буквально
  одно и то же значение** (`dayBucketMs`, зафиксированный на резервации, §3.2 «Атомарный
  check+reserve») — реконсиляция никогда не пересчитывает бакет из текущего времени ответа, поэтому
  ответ, пришедший после полуночи для вызова, зарезервированного до неё, всё равно попадает в
  ИСХОДНЫЙ day-бакет, не в новый (C-2 review).

- `SqliteBudgetStore` (`cache/budget-store.ts`, реализует интерфейс `BudgetStore` — тот же паттерн
  инъекции, что `CacheStore`/`SqliteCacheStore`, §3.2/§5.2 M1) открывает **собственное**
  `better-sqlite3`-соединение на тот же файл (`cacheDbPath()`, переиспользует существующий
  `cache/data-dir.ts`), выполняет `db.exec(CACHE_DDL)` идемпотентно (та же строка, включающая
  теперь и `usage`) и **обязательно** переиздаёт `PRAGMA foreign_keys=ON` на ЭТОМ соединении —
  прагма connection-scoped, не персистится в файле (DB-SCHEMA §1.6, R-34 явно требует «каждое»
  соединение, не глобально) — тест `pragma_foreign_keys`/`sqlite_master`-запросом подтверждает это
  (R-34/R-35 acceptance).

#### 4.2.1. Реестр сетей — артефакт сборки, а не таблица БД (TASK-006, R-48/R-60)

Реестр **не** попадает ни в кеш-БД, ни в Postgres, ни в сетевой запрос на старте. Он лежит в
репозитории как один детерминированный файл, вендорится в сборку и грузится в память при старте.
Три причины, каждая — жёсткое требование, а не вкус:

1. **Оффлайн-гейт (R-60a).** M1/M2 установили гейт «оффлайн-прогон = 0 сетевых вызовов». Реестр,
   подтягиваемый по сети при старте, ломает его в тот же день.
2. **Детерминизм CI.** Тест, чей результат зависит от того, что вендор отдал сегодня, — не тест.
3. **Ревьюируемость.** Изменение множества сетей — это дифф в git с человеческим ревью (TASK-006 UC-4),
   а не молчаливый сдвиг поведения продакшена. Особенно это касается `rpcHosts`: это
   security-поверхность (§7.2), и она обязана меняться через коммит.

Следствие, зафиксированное явно: **свежесть реестра — обязанность оператора, а не рантайма.**
Новая сеть, появившаяся у вендора, становится доступной после прогона генератора и коммита
(TASK-006 UC-4), а не автоматически. Это осознанный размен: детерминизм и контроль security-поверхности
против автоматической свежести.

**Загрузка (R-60c/d):** валидация схемы + инвариантов §4.1 выполняется **на старте**, не при
первом запросе. Отсутствующий или невалидный реестр — громкое падение процесса. Деградация в
пустой реестр **запрещена**: пустой реестр превратил бы каждый запрос в «unknown chain», то есть
тихо сломал бы весь движок, выглядя при этом как корректная работа.

#### 4.2.2. Влияние на ключ кеша — разовая холодная инвалидация (OQ-3)

Ключ кеша — `(provider, capability, sha256(normalizedArgs))` (M1, §3.2). `normalizedArgs`
содержит `chain`. После этой задачи туда попадает **`caip2`**, а не строка, которую написал агент.

- **Требование корректности:** канонизация алиаса (`ethereum` → `eip155:1`) происходит **до**
  хеширования. Без этого один и тот же запрос, написанный двумя способами, даёт два платных
  вызова и две записи кеша — на платных маршрутах это прямой денежный дефект.
- **Разовое следствие — ПРОГНОЗ, НЕ СБЫВШИЙСЯ (уточнено по факту реализации, задача 006-6):**
  здесь ожидалась одна холодная сессия из-за смены содержимого ключа. Её **не произошло**.
  Каноническим значением стал **слаг** (обоснование и отклонение по R-59d — `types/chain.ts`), а до
  TASK-006 инструменты принимали ровно `ethereum`/`solana`, которые и есть их слаги. `args_hash`
  существующих записей не изменился, кеш пережил выкат целиком. Требование §4.2.2 при этом
  соблюдено полностью — алиас не достигает ключа, канонизация происходит в хендлере до
  `deriveArgsHash`, что доказано сквозным тестом: `chain:'eth'` после `chain:'ethereum'` даёт
  cache HIT без повторного запроса.

#### 4.2.3. Матрица покрытия — производная величина, не второй справочник (R-51a)

Покрытие пары (capability, chain) **нигде не хранится списком.** Оно вычисляется как композиция
двух вещей, которые уже существуют:

```
covered(capability, chain) :=
    ∃ adapterId ∈ route(capability).adapterIds :
        adapter(adapterId).chainSupport(chainInfo) === true
```

Каждый адаптер отвечает на вопрос про сеть сам — предикатом над `ChainInfo`, а не списком:

| Адаптер                                              | `chainSupport(c)`                                              |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `defillama`                                          | `c.vendors.defillama !== null`                                 |
| `coingecko`                                          | `c.vendors.coingecko !== null`                                 |
| `dexscreener`                                        | `c.vendors.dexscreener !== null`                               |
| `rpc-evm`                                            | `c.family === 'evm' && c.rpcHosts !== null`                    |
| `rpc-solana`                                         | `c.caip2 === <solana mainnet caip2>`                           |
| `nansen`                                             | `c.caip2 ∈ CoverageProbe('nansen').chains`                     |
| `dash-platform` / `platform-explorer` / `pg-history` | `c.caip2 === <dash caip2>` (без изменений)                     |
| `dune`                                               | без изменений — `isAvailable()` по-прежнему безусловно `false` |

**Почему предикат, а не колонка-список:** колонка потребовала бы поддерживать покрытие в двух
местах (реестр + `capabilities()` адаптера) и рассинхронизировалась бы при первом же изменении.
Предикат делает реестр единственным источником **фактов о сети**, а адаптер — единственным
источником **фактов о себе**. Это тот же принцип, по которому §3.2 уже держит `providers.config.ts`
декларативным, а решение о доступности — за `isAvailable()`.

**Деградированный путь `nansen` (R-58d):** если артефакт `CoverageProbe('nansen')` отсутствует,
предикат откатывается на M2-множество (`ethereum`/`solana`), а `onchain_list_chains` помечает
покрытие этой capability как `unverified` за пределами этого множества. Так мы не заявляем
ложное покрытие и не отказываем ложно на паре, которая доказанно работала в M2.

**Два разных отказа, которые нельзя сливать (R-51b):**

| Ситуация                                                        | Тип ошибки                                            | Смысл для агента                                      |
| --------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Пара (capability, chain) не покрыта                             | `CapabilityNotCoveredOnChainError` (**новый**)        | «Здесь этого нет и не будет — посмотри альтернативы»  |
| Пара покрыта, но провайдер недоступен (нет ключа, вендор лежит) | `CapabilityUnavailableError` (**существующий**, R-24) | «Могло бы работать — почини конфиг или повтори позже» |

Слияние этих двух ошибок увело бы агента в бесконечный retry там, где повторять бессмысленно, и
наоборот — заставило бы сдаться там, где достаточно добавить ключ.

### 4.3. Диаграмма данных

```mermaid
erDiagram
  providers ||--o{ cache_entries : "cache_entries.provider"
  providers ||--o{ usage : "usage.provider"

  providers {
    TEXT id PK "adapter.id"
    TEXT kind "free / paid"
    TEXT notes
  }

  cache_entries {
    TEXT id PK "ULID app-generated"
    TEXT provider FK
    TEXT capability "часть UNIQUE-ключа"
    TEXT args_hash "часть UNIQUE-ключа, sha256(normalizedArgs), без секретов"
    TEXT value_json "канонический результат"
    INTEGER created_at "epoch-ms UTC"
    INTEGER expires_at "epoch-ms UTC = created_at + TTL(capability)"
  }

  usage {
    TEXT provider FK "часть PK"
    INTEGER day PK "epoch-ms day-bucket start, часть PK"
    INTEGER credits_used "АДДИТИВНЫЙ — never overwritten"
    INTEGER updated_at "epoch-ms UTC, только наблюдаемость"
  }
```

**TASK-006 не добавляет таблиц в эту ER-диаграмму.** Реестр сетей (`ChainInfo`) и `CoverageProbe`
— артефакты сборки, живущие в памяти процесса и в git, а не строки БД (§4.2.1). Единственное их
касание этой диаграммы косвенное: `cache_entries.args_hash` теперь считается от `caip2`, а не от
строки, которую написал агент (§4.2.2). Схема таблиц не меняется — **миграции нет**.

### 4.4. Миграции и версионирование

**TASK-006 (эта задача):** изменений DDL **нет** — ни новой таблицы, ни изменённой колонки.
Единственное миграционное событие — **разовая холодная инвалидация кеша** из-за смены содержимого
`args_hash` (§4.2.2): существующие строки не удаляются и не переписываются, они просто перестают
совпадать и истекают по штатному TTL. Отдельный migration-скрипт не пишется; событие объявляется в
changelog. Версионирование реестра — сам файл под git, его «версия» — коммит; отдельного поля
schema-version в v1 нет (YAGNI: единственный потребитель — этот же процесс той же сборки), но
загрузчик обязан валидировать структуру на старте (R-60c), так что несовместимый файл падает
громко, а не молча.

**M2 (реализовано этой архитектурой, TASK-005):** `usage(provider FK, day, credits_used,
updated_at)` добавлена в ту же кеш-БД, `providers`/`cache_entries` не изменены (R-14/R-34
acceptance) — механическая `CREATE TABLE IF NOT EXISTS`, не миграция существующих строк. Канонические
типы версионируются по D5 (тип-версия — поле зарезервировано, но M1/M2 не вводят breaking-change
механику — первая ревизия схем для всех шести canonical-типов, включая три новых M2).
