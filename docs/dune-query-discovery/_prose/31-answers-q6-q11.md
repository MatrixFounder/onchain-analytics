# Q6 — Мотивирующий пример «сколько BTC добыто» + один сложный in-chain пример

**Ответ:**

Bitcoin-данные в Dune **есть**, но для этого вопроса Dune — заведомо неправильный инструмент, и правильный ответ звучит как «не жечь кредиты вообще».

1. **Наличие данных.** Выкачанное дерево Spellbook содержит 14 805 путей, из них 34 bitcoin-модели. Конкретные имена таблиц (сырые `bitcoin.*` против spellbook-моделей `metrics_bitcoin_transactions_daily` / `prices_bitcoin_tokens`), их колонки и точный SQL суммы coinbase-выходов в этом прогоне **не верифицированы** — это зафиксированный пробел, а не вывод.
2. **Семантическая ловушка, которая важнее источника.** «Сколько BTC добыто» (эмиссия = сумма coinbase) и «сколько BTC в обращении» (circulation) — **разные величины**. Живой замер: `circulation` = 20 062 011.67 BTC против расчётной эмиссии на блоке 959853 = 20 062 043.75 BTC, дельта 32.08 BTC = 0.00016% (недобранные coinbase-награды). Любой ответ без этой оговорки некорректен независимо от провайдера.
3. **Самый дешёвый корректный путь — не Dune.** Он бесплатный и проверен живьём: keyless DuckDB по AWS Public Blockchain Data (btc/blocks за 2026-07-26 = 146 блоков / 758 094 tx за 3.3 с). Резервный — закрытая формула халвингов от высоты блока. Третий — `GET /bitcoin/stats` у Blockchair стоимостью 1 request point, но он практически мёртв: keyless-режим отдаёт HTTP 430 после 2 запросов, а точная эмиссия через `?a=sum(generation)` стоит 2 points и живьём не получена вовсе.
4. **Если всё-таки через Dune** — дешевле всего не исполнять запрос: `GET /v1/query/{id}/results` работает для любого публичного запроса, **не триггерит исполнение** и тарифицируется по размеру результата (Free — 20 credits per MB Exported). Исполнение (`execute`) стоит непредсказуемо: Dune дословно отказывается публиковать формулу («we don't share a single, per-query formula because credit usage depends on real-time factors»). Минимальный заряд за чтение результата в первоисточнике не найден — unverified.
5. **Сложный in-chain пример — «дневной объём DEX по сетям».** Здесь картина зеркальная: бесплатной замены Dune в этом прогоне **не нашлось ни одной**. Blockchair: во всех 447 723 байтах доки `\bdex\b`=0, swap=0, uniswap=0, liquidity=0, amm=0. Blockscout: в каталоге `/stats-service/api/v1/lines` 37 метрик, DEX/swap/volume среди них ноль, плюс покрытие чисто EVM (не-EVM = 0). То есть именно этот класс — единственное честное основание платить Dune. Целевая таблица класса `dex.trades` фигурирует в первоисточнике только как пример UI-фильтра (`code:"from dex.trades"`); её схема и стоимость агрегата — unverified.

**Доказательство:**
Spellbook 14 805 путей / 34 bitcoin-модели, `verification_log.txt` (146 блоков / 758 094 tx / 3.3 с; h=959763 tx_count 4590 совпал с mempool.space точно) — фактбаза прогона. Circulation 20 062 011.67 BTC vs расчётные 20 062 043.75 BTC, Δ 32.08 BTC = 0.00016% — живой замер Blockchair `/bitcoin/stats` (`circulation` = 2006201166655096 сат, блок 959853; независимый второй замер 2006198979155096 сат при blocks = 959846). HTTP 430 после 2 keyless-запросов — воспроизведено дважды, с разных IP и в обратном порядке; корроборация janoside/btc-rpc-explorer #597, Blockchair issues #782, #934, #1147, #1602, #1642, #1652. «This endpoint does NOT trigger an execution but does consume credits based on the result size» и «To access Query endpoints…» — docs.dune.com/api-reference. «we don't share a single, per-query formula» — pricing-faqs.md. 20 credits per MB Exported (Free), 10 (Analyst), 2 (Plus) — api-reference/overview/billing. 447 723 байта доки Blockchair с нулём DEX-терминов и 37 метрик Blockscout — грепы по первоисточникам 2026-07-27.

**Confidence:** high — по бесплатному пути для BTC (живая проба + точное совпадение с mempool.space + арифметическая сверка), по непригодности Blockchair/Blockscout для DEX-агрегатов (нулевые грепы), по механике тарификации Dune. medium — что Spellbook-модели покрывают нужную гранулярность. low/unverified — имена bitcoin-таблиц Dune, точный SQL, стоимость исполнения в кредитах, схема `dex.trades`.

**Что делаем мы:**
Никогда не маршрутизируем «эмиссию/циркуляцию» на Dune — это класс `chain.supply`, закрываемый бесплатно. BTC-пример превращаем в калибровочный тест движка: у него есть эталон с известной дельтой (32.08 BTC), поэтому он годится как канарейка для проверки корректности любого нового провайдера. Кредиты Dune резервируем строго под класс «произвольный агрегат по протоколам и времени» (DEX-объёмы, когорты) — единственный, где бесплатной альтернативы не найдено. Перед первым платным исполнением обязателен шаг предварительной оценки объёма (`getTableSize` / `POST /v1/datasets/search`), иначе стоимость непредсказуема по признанию самого вендора.

---

# Q7 — Интеграционный дизайн для onchain-intel

**Ответ:**

Движок к этому классу готов на **две трети**: сеть, кэш, троттлинг и бюджетный леджер переиспользуются как есть; ломается ровно то, что специфично для «дорогого асинхронного SQL».

**1. Capability и маршруты.**
`packages/core/src/adapters/types.ts:9-12` — `CapabilityDescriptor.id` это обычная строка, enum менять не нужно. Вводим новый маршрут `analytics.sql → ['dune']` в таблице `packages/core/src/providers.config.ts:23-76`. Одновременно освобождаем мёртвый слот: `providers.config.ts:69` сейчас маршрутизирует `token.holders` на `dune`, чей адаптер безусловно самоотключается (`packages/core/src/adapters/dune/index.ts:39`, `isAvailable: () => ({ ok: false, reason: 'dune query authoring deferred to M2' })`), а `chainSupport` возвращает `false` (`dune/index.ts:25`). Ставим первым бесплатный Blockscout — registry перебирает `adapterIds` по порядку со self-skip на `packages/core/src/adapters/registry.ts:244-247`.

**2. Тулы.** `packages/mcp-server/src/server.ts:67-79` — сейчас ровно 10 вызовов `registerXTool`. Новый тул пишется по шаблону `packages/mcp-server/src/tools/chain-tvl.ts` (:18 вход `.strict()`, :27-35 выход `.strict()`, :45-66 handler + safeParse, :69-90 `registerTool` + `_meta.cache`), резолв — `packages/mcp-server/src/tools/resolve-capability.ts:55-76`.

**3. Адаптер.** Контракт `types.ts:21-59`; регистрация по шаблону `providers.config.ts:113-118` (id :114, hosts :115, rateLimit :116, requiresEnv :117). `requiresEnv: ['DUNE_API_KEY']` — в `.env` его сегодня нет, в `.env.example:57` он закомментирован. Исполнение обязано быть асинхронным (execute → poll → results): это уже зафиксировано как ограничение архитектуры в `ARCHITECTURE.md:139-144`.

**4. Кэш и TTL.** `packages/core/src/cache/ttl.ts:6-53` — таблица классов; дефолт 300 (`ttl.ts:61`) для платного SQL занижен, нужен собственный длинный класс по образцу `ttl.ts:21` (`'token.holders': 3600`). **Две реальные дыры:**
- `packages/core/src/net/args-hash.ts:44-47` — `deriveArgsHash` = sha256(capability + канонизированные args). Если args содержат сырой SQL, то модель-сгенерированный запрос, отличающийся пробелом или алиасом, даёт другой хеш ⇒ промах кэша ⇒ повторное **платное** исполнение. Ключ обязан строиться на `query_id` + параметрах из каталога (Q10), а не на свободном тексте.
- `packages/core/src/cache/lru.ts:8` — `DEFAULT_MAX_ENTRIES = 500`, а `:28` считает только записи, без байтового учёта. Результат SQL неограничен по строкам (внутренний потолок Dune — 32GB), поэтому в кэш кладём только нормализованную проекцию (`types.ts:28`), не сырой payload; sqlite хранит значения как TEXT (`packages/core/src/cache/ddl.ts:55-66`, `sqlite-store.ts:198`).
- Негативный кэш `ttl.ts:83` = 60 с. Для 402 «кредиты кончились» это неверно: перерасход возвращается 402 и не рассасывается за минуту — нужен отдельный, длинный негативный TTL для класса «квота исчерпана».

**5. Кредиты в budget-guard.** Хорошая новость: тяжёлая часть уже провайдер-агностична. `packages/core/src/cache/budget-store.ts:46-93` — интерфейс на ключе `provider: string`, докстринг :10-14 прямо декларирует независимость от вендора; `checkAndReserve`, окно скорости (`budget-store.ts:30-44`) и транзакция уже есть. `packages/core/src/cache/sqlite-store.ts:48` — `PAID_PROVIDER_IDS` **уже содержит `dune`**. Что чинить:
- `packages/core/src/adapters/dune/index.ts:28` — `costOf: () => ({ credits: 0 })` объявляет кредитного вендора бесплатным. Это латентная ловушка, её надо снести первой.
- Точную цену исполнения предсказать нельзя в принципе (вендор не публикует формулу), поэтому паттерн fail-closed из `packages/core/src/adapters/nansen/cost-of.ts:64-102` (+Infinity при неизвестности) здесь заблокирует всё. Рабочая схема — reserve-then-reconcile, которая в репозитории уже реализована: `packages/core/src/adapters/nansen/index.ts:576-581` (singleflight → gate → subcalls → reconcile), `singleflight.ts:22-40`, `budget-gate.ts:532`. Резервируем конфигурируемый потолок, **обязательно передаём вендорский `max_credits_per_request`** (вендор сам обрубит перерасход), затем сверяем факт по `execution_cost_credits` из `/v1/execution/{id}/status` и дельте `/v1/usage` — по аналогии с живой ресинхронизацией Nansen (`budget-gate.ts:469-472`, потолок `:289-296`).
- `packages/mcp-server/src/tools/budget-meta.ts:9` и `:38` зашиты на литерал `'nansen'` — без параметризации расход Dune не появится в `_meta` вообще.

**6. SSRF и сеть.** `packages/core/src/net/safe-fetch.ts:19-23` (`assertAllowedHost`), `:209` (per-hop allowlist), `:196-201` (https-only), `:226-228` (MAX_REDIRECTS=3) — добавить `api.dune.com` в `hosts` (`providers.config.ts:115`). Два несоответствия под Dune:
- `safe-fetch.ts:32` `DEFAULT_TIMEOUT_MS = 15_000` — меньше времени исполнения запроса. Блокирующий вызов запрещён, только poll (у Dune polling статуса бесплатен).
- `safe-fetch.ts:39` `DEFAULT_MAX_RESPONSE_BYTES` = 10MB и `:147-154` — проверка размера **делает ранний выход, если нет `Content-Length`**. Для чанкованной выгрузки результата (которая тарифицируется за мегабайт) это значит, что кап молча не применяется. Обязателен явный per-call кап через `SafeFetchOptions` (`safe-fetch.ts:43-46`) и закрытие дыры :147-154 до первого платного вызова.
- Rate-limit: `packages/core/src/net/rate-limit.ts:57-95`, `MAX_WAIT_MS = 30_000` (`:32`). У Dune два класса лимита (low 15 rpm + high 40 rpm, комбинированно 55), а наша регистрация держит один бакет на адаптер (`types.ts:68-73`) — либо берём нижний, либо разносим на две регистрации.

**7. Риск модель-сгенерированного SQL — новый класс, которого движок не моделирует.** `.strict()`-схемы на границе тула (`chain-tvl.ts:18`, `:27-35`) валидируют форму, но не семантику SQL. Нужен отдельный валидатор до `adapter.fetch` (`registry.ts:280`): запрет DDL/DML и записи, обязательный LIMIT, allowlist таблиц из каталога, обязательный `max_credits_per_request`, параметризация вместо конкатенации. Отдельно — prompt-injection: SQL, порождённый моделью, которая прочитала недоверенный ончейн-текст (имя токена, тег), — это исполняемый payload за наши деньги.

**8. MPP отдельно: не берём в рантайм.** budget-guard спроектирован в кредитах (`budget-store.ts:46-93`), MPP не отдаёт `credits_used` вообще — единица учёта доллар/USDC.e, факт-списание приходит воучером. Плюс резерв за выгрузку результата $1024.00 при `suggestedDeposit` $10.00 и `maxDeposit` "10" ⇒ упор в депозит. Плюс требуется горячий приватный ключ с живыми деньгами — при том что прецедент секретов у нас закрывается только `.gitignore:53` (plaintext-JWT в `.mcp.json`).

**Доказательство:**
Все якоря — из живого аудита `/Users/sergey/dev-projects/onchain-analytics` 2026-07-27: `adapters/dune/index.ts` (41 строка; :25 chainSupport=false, :27 capabilities token.holders, :28 costOf credits 0, :31-33 fetch throws, :34-36 normalize throws, :39 isAvailable ok:false), `providers.config.ts:69/:23-76/:113-118`, `registry.ts:198/:213-225/:228/:244-247/:250-262/:280/:300/:306/:337`, `types.ts:9-12/:21-59/:68-73/:79-83`, `ttl.ts:6-53/:21/:61/:83`, `args-hash.ts:44-47`, `lru.ts:8/:28`, `sqlite-store.ts:48/:198`, `ddl.ts:55-66`, `safe-fetch.ts:19-23/:32/:39/:43-46/:147-154/:196-201/:209/:226-228`, `rate-limit.ts:32/:102-140`, `budget-store.ts:10-14/:30-44/:46-93`, `nansen/budget-gate.ts:289-296/:469/:471/:472/:532`, `nansen/cost-of.ts:64-102`, `nansen/index.ts:576-581`, `singleflight.ts:22-40`, `coverage.ts:70-89`, `chain/errors.ts:87-137`, `server.ts:67-79`, `chain-tvl.ts:18/:27-35/:45-66/:69-90`, `resolve-capability.ts:55-76`, `budget-meta.ts:9/:38`, `.env.example:57`, `ARCHITECTURE.md:69-74`, `.gitignore:53`. Ограничения вендора (15/40/55 rpm, 32GB, `max_credits_per_request`, бесплатный polling статуса, 402 при исчерпании) — docs.dune.com/api-reference и живой прайс-лист `x-payment-info` из `https://api.dune.com/openapi.json`.

**Confidence:** high — по всем file:line репозитория (перепроверены чтением файлов, ни одна ссылка не разошлась) и по факту, что бюджетный леджер уже провайдер-агностичен. high — по дыре `safe-fetch.ts:147-154` и по несовместимости `costOf: credits 0`. medium — по выбору «reserve-then-reconcile» как оптимальной схемы (это проектное решение, а не измеренный факт). unverified — фактическая величина резерва в кредитах на один запрос.

**Что делаем мы:**
Порядок работ строго такой: (1) снести `costOf: () => ({ credits: 0 })` в `dune/index.ts:28` — это ложь в бюджете и она сработает при первом же обобщённом бюджетном пути; (2) закрыть `safe-fetch.ts:147-154` (ранний выход без `Content-Length`) — до этого платные выгрузки не трогать; (3) параметризовать `budget-meta.ts:9/:38`, иначе трат Dune не видно; (4) перевесить `providers.config.ts:69` на бесплатный Blockscout и завести отдельный маршрут `analytics.sql`; (5) SQL-валидатор перед `registry.ts:280` + обязательный `max_credits_per_request`; (6) ключ кэша строить на `query_id` + параметры, не на тексте SQL. MPP в рантайм не берём: он требует второй единицы учёта в budget-guard и горячего кошелька.

---

# Q8 — Бесплатные не-Dune источники и правило «когда не жечь кредиты»

**Ответ:**

Бесплатные источники закрывают **построчный explorer-слой и нативную эмиссию**, но не закрывают произвольные агрегаты. Профилированы и проверены живьём три:

| Источник | Что закрывает бесплатно | Чем ограничен |
|---|---|---|
| **Blockscout MCP / REST** (`mcp.blockscout.com`, `/v1/*`) | `entity.labels` (живо: теги Binance-хот-кошелька), `token.holders` (живо: `/api/v2/tokens/<addr>/holders` с курсорной пагинацией), адрес/токен/NFT/ABI/логи/`read_contract`, `/api/v2/stats` | 100 сетей, из них 47 тестнетов, мейннетов 53, не-EVM = 0 (нет Bitcoin, нет Solana). Free: 100K credits/day, 5 RPS, без карты. Нулевая агрегация. Дефолтная цена вызова 20 кредитов, тяжёлые 50; один MCP-тул фанится в несколько upstream (get_address_info ≈160 кредитов ⇒ ≈625 вызовов/сутки) |
| **AWS Public Blockchain Data через keyless DuckDB** | Сырые bitcoin-блоки и агрегаты по ним (живо: 146 блоков / 758 094 tx за 3.3 с) | Профиль не строился; покрытие сетей за пределами BTC — unverified |
| **Blockchair API v2 keyless** | Номинально `chain.supply` (`/{chain}/stats` → `circulation`, cost 1) и rich list по нативной монете | **Практически мёртв**: вендор дословно «Last week we had to enforce blocking all API requests that didn't use an API key»; живьём ровно 2 успешных запроса, дальше HTTP 430 на весь IP >10 минут. Продукт заморожен (последняя запись changelog v.2.0.95 от 2021-12-23), преемник 3xpl тоже уже отдаёт 403 |

**Правило маршрутизации «когда не жечь кредиты»** — реализуется порядком `adapterIds` в маршруте, а не прозой:

1. **Точечный факт по адресу/транзакции/токену на EVM-сети** → Blockscout, стоимость Dune = 0. Дороже Dune быть не может по определению: точечные факты у Dune всё равно требуют исполнения.
2. **Нативная эмиссия/циркуляция, UTXO-сети** → AWS/DuckDB или своя нода. Blockchair — только как кэшируемый фоновый источник с долгим TTL, обязательным fallback и негативным кэшем на 430, никогда не в горячем пути.
3. **Распределение холдеров** → Blockscout. Отдельно: у Blockchair «распределение холдеров» = rich list **нативной** монеты; документированного «топ-холдеры ERC-20» у него нет вообще — подменять одно другим нельзя.
4. **Произвольный JOIN/GROUP BY по протоколам и времени** (дневной объём DEX по сетям, когорты) → **только Dune**. Бесплатной замены в этом прогоне не найдено: 0 DEX-терминов у Blockchair, 37 метрик без DEX у Blockscout.
5. **Гейты перед любым платным вызовом (порядок уже реализован в движке):** coverage-gate `registry.ts:213-225` срабатывает **до** кэша, `isAvailable`, бюджета и HTTP; затем кэш `registry.ts:250-262`; только потом `adapter.fetch` `registry.ts:280`. То есть «не жечь» — это в первую очередь корректный `chainSupport`, а не рантайм-проверка.
6. **Никогда не маршрутизировать capability на Dune, если её покрывает адаптер с нулевой стоимостью и целевая сеть входит в его `chainSupport`** (`coverage.ts:70-89`).

**Честная потеря покрытия (логируется, не молчим):** из сидов брифа §4 — Flipside SQL API, BigQuery public crypto datasets, Coin Metrics community, mempool.space (использован только как сверочная точка, не профилирован), blockchain.com charts, growthepie, Artemis, Token Terminal, Bitquery free, The Graph — **не профилирован ни один**. Семейство alt-free было зажато квотой в 6 строк, и как минимум две из них съел near-дубликат Blockscout, ещё одну — Blockchair со статусом REFUTED. Утверждение «бесплатной замены Dune для агрегатов нет» верно **для проверенного множества**, а не вообще.

**Доказательство:**
Blockscout: живой `GET /v1/get_address_info` без ключа → HTTP 200 с `ens_domain_name":"vitalik.eth"`, `coin_balance":"6632273951167510873"`; теги `["Binance: Hot Wallet","Binance 14","HOT WALLET","Exchange","Binance"]`; `direct_api_call` на `/api/v2/tokens/0xA0b86991…eB48/holders` вернул items[] с курсором `pagination.next_call`; тарифы дословно с docs.blockscout.com/devs/pro-api («Free 100K credits/day · 5 RPS · All chains», «No credit card required for the free tier»); `endpoint_pricing` из живого `https://api.blockscout.com/api/json/config` — 44 записи, значения {20,25,30,40,50,100,120,150,1000}, `default`=20; сплит 100 сетей (47 тестнетов / 53 мейннета / не-EVM = 0) — разбор живого `get_chains_list`. Blockchair: issue #1652 (2025-07-15, сотрудник вендора), issue #1147 (2023-04-20, «1,000 calls/day» на несколько дней триала против 1440/сутки в доке), воспроизведённый HTTP 430. AWS/DuckDB — `verification_log.txt`. Гейты движка — `registry.ts:213-225/:250-262/:280`, `coverage.ts:70-89`.

**Confidence:** high — по тому, что Blockscout бесплатно закрывает `entity.labels` и `token.holders` (живые пробы с данными), по непригодности Blockchair keyless (воспроизведено дважды + заявление вендора), по отсутствию DEX-агрегатов у обоих (нулевые грепы). medium — по устойчивости бесплатного окна Blockscout (см. Q9). low — по полноте картины бесплатных источников: 10 сидов не профилировано.

**Что делаем мы:**
Кодируем правило как порядок в `adapterIds`: бесплатный первым, платный последним — движок уже перебирает по порядку со self-skip (`registry.ts:244-247`). Blockscout заводим сразу с бесплатным `proapi_`-ключом и `requiresEnv: ['BLOCKSCOUT_PRO_API_KEY']` (`providers.config.ts:117`), а не на бесключевом окне. `chainSupport` для Blockscout строим из живого `get_chains_list`, иначе матрица покрытия (`coverage.ts:70-89`) начнёт рекламировать Bitcoin, которого там нет. Десять непрофилированных сидов выносим в явный follow-up: до их проверки формулировка «альтернатив Dune нет» в отчёте должна звучать как «в проверенном множестве не найдено».

---

# Q9 — Lifecycle-риски и что именно у нас ломается

**Ответ:** Шесть сценариев, каждый с точкой отказа в нашем коде и fallback.

**1. Статус официального Dune MCP формально не объявлен.**
Grep по странице документации на `beta|preview|general availability|GA|experimental|deprecat|unstable|breaking` — **0 попаданий**; `changelog.md` отдаёт 404. При этом анонсирующий блог заявляет «The Dune MCP Server exposes 12 tools», а документация — 26. То есть поверхность менялась минимум один раз без changelog.
*Что ломается у нас:* если мы проксируем MCP, набор и арность тулов может измениться молча — сломается слой тулов `server.ts:67-79` и `.strict()`-схемы (`chain-tvl.ts:18/:27-35`), причём с ошибкой валидации, а не с внятным «tool removed».
*Fallback:* привязка к машиночитаемому `https://api.dune.com/openapi.json` (200 145 B, 47 операций) — контракт диффится в CI; MCP оставляем только в дев-петле.

**2. Плановый гейт Query-эндпоинтов: первоисточник противоречит сам себе.**
Дословно «To access Query endpoints, an Analyst plan or higher is required» (queries/endpoint/read.md:17, create.md:15, list.md:14, update.md:16) против «Queries Endpoint — Available on Plus and Enterprise plans» (billing.md:65-67). Analyst и Plus — разные тарифы (overage $1.875/100 против $1.596/100).
*Что ломается:* шаг «прочитать SQL чужого запроса» (`getDuneQuery` / `GET /v1/query/{id}`) недоступен на Free при любом прочтении, и может стать недоступен на Analyst, если победит вторая формулировка.
*Fallback:* каталог с нашим собственным SQL (Q10) + `POST /v1/sql/execute` — у него в доке планового гейта нет, scope `Read`.

**3. Ещё одно противоречие первоисточника, самое опасное для нас: доступ к API на Free.**
`pricing-faqs.md:254` — «the API is included in all Dune plans… including those in the Free plan». Та же `pricing-faqs.md:135` заканчивается «…paid plans offer significantly lower per-credit rates and additional features like **API access**».
*Что ломается:* вся посылка «Free 2 500 кредитов/мес хватит». Если верна вторая формулировка — capability `analytics.sql` не поднимется вообще.
*Fallback:* `requiresEnv` + `isAvailable` заставляют registry чисто самоскипнуть (`registry.ts:244-247`) и вернуть `CapabilityUnavailableError` (`registry.ts:337`) вместо 401-шторма; маршрут деградирует на бесплатные адаптеры для того подмножества, что они покрывают.

**4. Sunset Dune Sim 2026-08-01.**
Регистрации отключены с 2026-05-18, существующие клиенты сохраняют полный доступ до 2026-08-01, прораченный возврат предоплаты, миграционные партнёры Zerion/Codex/Mobula. Первоисточник краулеру отдаёт HTTP 403 (антибот), содержимое доставлено через поисковый индекс.
*Что ломается у нас:* **напрямую — ничего.** В `.env` только `NANSEN_API_KEY`, `DUNE_API_KEY` закомментирован (`.env.example:57`), Sim в репозитории не используется. Ломается посылка: вендор гасит продуктовые линии и режет бесплатные окна — значит план «жить на Free» имеет ненулевую вероятность отмены.
*Fallback:* закладывать платный тариф в модель стоимости с первого дня, а не после отказа.

**5. Blockscout: гашение бесключевого доступа + смена лицензии.**
Issue #425 дословно: «Starting July 20, 2026, all requests to the official public Blockscout MCP server will require a PRO API key for authorization». Дата **уже прошла**, принуждение на 2026-07-27 не включено; механизм анонса вмёржен PR #431 (merged 2026-07-24), переменная `BLOCKSCOUT_PRO_API_KEY_REQUIRED_NOTICE`. Отдельно: с v0.16.0 (релиз 2026-06-16, PR #347) репозиторий переведён на проприетарную `LicenseRef-Blockscout` (Effective 2026-05-15), грант отзывной, §4(a) запрещает SaaS/монетизацию без Commercial Licence, §2(c) требует видимой атрибуции, §10(b) допускает прекращение по усмотрению лицензиара; `gh api` отдаёт `NOASSERTION`.
*Что ломается:* в день включения принуждения все бесключевые вызовы падают — и падают жёстко: живой тест с `proapi_bogus_test` дал 401 **без отката** на серверный ключ. То есть ошибка в конфиге ключа = полный отказ capability, а не деградация. Плюс сегодня бесключевой трафик делит один серверный ключ: 3×HTTP 429 в burst-пробе (источники расходятся, 10 или 12 параллельных вызовов — расхождение логируем).
*Fallback:* бесплатный `proapi_`-ключ заводим **сейчас**, `requiresEnv: ['BLOCKSCOUT_PRO_API_KEY']`, health-probe ключа в `isAvailable()` с fail-fast. Лицензия нас не связывает, пока мы потребляем хостируемый сервис, а не распространяем софт; self-host внутри платного продукта — запрещён до Commercial Licence.

**6. Blockchair: замороженный legacy с назначенным преемником.**
Changelog остановился на v.2.0.95 (2021-12-23), дока не менялась с 2021-07-08, `next_major_update` = 2023-11-12 просрочен, в каждом ответе `notice: "Try out our new API v.3: https://3xpl.com/data"`, а сам 3xpl уже отдаёт 403 «Access token is required». Формального sunset нет.
*Что ломается:* ничего, если мы не сделали его единственным источником `chain.supply`.
*Fallback:* AWS/DuckDB или своя нода как первичный путь, Blockchair — только кэшируемый вторичный с негативным кэшем на 430.

**Доказательство:**
Нулевые грепы по статус-маркерам и 404 на changelog — проверка первоисточника документации MCP (14228 байт, `mcp.md`); «12 tools» — анонсирующий блог; 26 — таблица `mcp.md:173-198`, детерминированный пересчёт `grep -cE '^\| \*\*'` = 26. Гейт-противоречие — queries/endpoint/read.md:17, create.md:15, list.md:14, update.md:16 против billing.md:65-67; ставки $1.875/100 и $1.596/100 — pricing-faqs.md:118-119. API-на-Free противоречие — pricing-faqs.md:135 против :254. Sim — официальный пост dune.com/blog/sunsetting-sim (краулеру HTTP 403, содержимое через индекс). Blockscout — issue #425, PR #431 (merged_at 2026-07-24), PR #347, LICENSE `SPDX-License-Identifier: LicenseRef-Blockscout`, `gh api` license NOASSERTION, живой 401 на `proapi_bogus_test`. Blockchair — `API.md` (96 версий, последняя v.2.0.95 - December 23rd, 2021), живые поля `last_major_update`/`next_major_update`/`notice`, `api.3xpl.com` → 403.

**Confidence:** high — по всем шести фактам жизненного цикла (дословные цитаты первоисточников + живые пробы + gh api). medium — по вероятности и срокам включения принуждения ключа Blockscout (объявленная дата прошла, новая не опубликована). unverified — фактическая дата принуждения, дата гашения Blockchair v2, разрешение обоих противоречий доки Dune.

**Что делаем мы:**
Три страховки, все дешёвые. Первая: каждый платный/квотируемый адаптер поднимается **только** через `requiresEnv` + `isAvailable` (`providers.config.ts:117`, `registry.ts:244-247`) — тогда любое ужесточение гейта превращается в чистый self-skip и понятную ошибку `registry.ts:337`, а не в шторм 401/402. Вторая: negative-cache для класса «квота/доступ закрыт» с TTL заметно длиннее нынешних 60 с (`ttl.ts:83`). Третья: контрактный диф `openapi.json` в CI — единственный способ поймать дрейф поверхности вендора, у которого changelog отдаёт 404.

---

# Q10 — Каталог проверенных query id против живого поиска

**Ответ: каталог, без вариантов. Живого поиска чужих запросов легального не существует.**

**Почему «живой поиск» невозможен, а не «дорог»:**
- В официальном MCP **нет тула поиска по чужим запросам как класса**. Вся категория Discovery — `searchDocs` (документация), `searchTables` / `searchTablesByContractAddress` / `getTableSize` (таблицы), `listBlockchains`. Ни один не ищет чужие queries/дашборды.
- В REST единственный search — `POST /v1/datasets/search`, и он ищет **таблицы**. `GET /v1/queries` возвращает только своё («queries owned by the account tied to the API key») и вдобавок гейтится планом.
- UI-фильтры (`code:"from dex.trades"`, `author:`, `tags:`) существуют **только в веб-приложении** — для headless-агента это скрапинг, запрещённый фильтром брифа §5. Внутренний search веб-приложения (`core-api.dune.com`) в этом прогоне не зондировался вовсе.
- Единственный документированный мост «человеческий URL → query_id» — `GET /v1/dashboards/by-slug/{owner_handle}/{slug}` — в этом прогоне не профилирован (unverified).

**Четыре измерения сравнения:**

| Измерение | Каталог query id | Живой поиск |
|---|---|---|
| Цена | Разовая ручная валидация; в рантайме — `GET /v1/query/{id}/results`, который **не триггерит исполнение** и стоит только по размеру результата (Free — 20 credits per MB Exported) | Не имеет цены, потому что не имеет легального API-пути |
| Задержка | Один GET за готовым результатом; исполнение не ждём | Исполнение чужого запроса: Small engine — «2-minute timeout limit», «Maximum of three (3) concurrent executions», «No performance guarantees»; Medium — дефолт для API/MCP |
| Хрупкость | Владелец может отредактировать, удалить или сделать запрос приватным (`is_private`); на Free мы **не можем прочитать SQL**, чтобы заметить дрейф; `POST /v1/query/{id}/execute` для чужого запроса документированно отдаёт 403 «Not allowed to execute query… not enough permissions» | Абсолютная: любой парсинг UI ломается при первом редизайне и нарушает фильтр брифа |
| Проверяемость | Высокая: фиксируем ожидаемые колонки и независимую точку сверки | Нулевая: неизвестно, что именно исполнилось |

**Рекомендация:** каталог, версионируемый в репозитории, где каждая запись содержит `query_id`, владельца, назначение, **ожидаемую схему колонок**, дату последней сверки и независимый источник кросс-чека. Плюс два правила: (1) в рантайме предпочитать `GET /v1/query/{id}/results` (без исполнения) исполнению; (2) для всего, чего нет в каталоге, использовать **свой** SQL через `POST /v1/sql/execute`, а не чужой — свой мы можем отревьюить, чужой на Free не можем прочитать в принципе.

**Доказательство:**
Отсутствие тула поиска чужих запросов — полный инвентарь Discovery (`searchDocs`, `searchTables`, `listBlockchains`, `searchTablesByContractAddress`, `getTableSize`) в `mcp.md:173-198`; в OpenAPI 39 путей и единственный search — `POST /v1/datasets/search`; `GET /v1/queries` — «Retrieve a paginated list of queries owned by the account tied to the API key» (queries/endpoint/list.md). Чтение результата чужого публичного запроса — «must either be public or a query you have ownership of» (api-reference/executions/endpoint/get-query-result:17) + «This endpoint does NOT trigger an execution but does consume credits based on the result size». 403 на execute чужого запроса — та же секция api-reference. Движки — pricing-faqs.md:154-181. Класс rate-limit для `/query/{id}/results` в таблицах low/high **не перечислен** (api-reference/overview/rate-limits) — unverified.

**Confidence:** high — по отсутствию поискового пути и по тому, что чтение результата не триггерит исполнение (дословные цитаты первоисточника). medium — по практической стабильности чужих публичных запросов (мы не смогли это измерить). unverified — минимальный заряд за чтение результата, класс rate-limit этого эндпоинта, работоспособность `GET /v1/dashboards/by-slug/{owner_handle}/{slug}`.

**Что делаем мы:**
Заводим `catalog.json` рядом с конфигурацией провайдеров и ключ кэша строим на `query_id` + параметры (не на тексте SQL — см. `args-hash.ts:44-47`, иначе каждый переформатированный SQL оплачивается заново). Каждая запись каталога получает канарейку: ожидаемый набор колонок; расхождение схемы = запрос переехал, capability уходит в negative-cache, а не отдаёт мусор. Чужой SQL в рантайме не исполняем никогда — только читаем готовый результат или исполняем свой.

---

# Q11 — Официальный Dune MCP: инвентарь, авторизация, разрывы, развилка, карта коннектора

## (а) Инвентарь тулов

Подтверждено ровно **26 тулов** (таблица `mcp.md:173-198`, детерминированный пересчёт: 26 строк, 26 уникальных имён; `sort -u` = 26). Разбивка по категориям: Discovery 5 / Query Lifecycle 5 / Materialized Views 6 / Visualization 5 / Dashboard 4 / Account 1. Числа 27 (арифметическая ошибка суммаризатора) и 12 (устаревший анонс в блоге) — отброшены.

**Критично:** первоисточник MCP **не публикует** ни per-tool входные JSON-схемы, ни per-tool стоимость в кредитах, ни per-tool плановый гейт. Всё в колонках «вход / гейт / кредиты» ниже — вывод из REST-эквивалентов, а не заявление вендора.

| Имя | Категория | Вход (из REST-эквивалента) | Плановый гейт | Кредиты | Зачем агенту |
|---|---|---|---|---|---|
| `searchDocs` | Discovery | поисковый запрос по документации | не заявлен | unverified | понять синтаксис/семантику перед SQL |
| `searchTables` | Discovery | поисковый запрос по датасетам | не заявлен | unverified | найти **таблицу** (не чужой запрос) |
| `searchTablesByContractAddress` | Discovery | адрес контракта | не заявлен | unverified | от адреса к таблице — самый прямой путь к нужной модели |
| `getTableSize` | Discovery | идентификатор таблицы | не заявлен | unverified | **единственный документированный способ оценить стоимость до исполнения** |
| `listBlockchains` | Discovery | — | не заявлен | unverified | сверить покрытие сетей |
| `createDuneQuery` | Query Lifecycle | SQL + метаданные | Query endpoints: Analyst **или** Plus (противоречие первоисточника) | unverified | сохранить свой запрос |
| `getDuneQuery` | Query Lifecycle | `query_id` | Analyst **или** Plus | unverified | **прочитать SQL** — на Free недоступно |
| `updateDuneQuery` | Query Lifecycle | `query_id` + SQL | Analyst **или** Plus | unverified | править свой запрос |
| `executeQueryById` | Query Lifecycle | `query_id` (+ параметры) | Data API доступен на всех планах | по compute, фиксированной ставки нет; Small engine — 0 кредитов на запуск, но 2-minute timeout и максимум 3 параллельных исполнения; Large ≈ 2x compute от Medium | исполнить запрос |
| `getExecutionResults` | Query Lifecycle | `execution_id` | Data API | экспорт: Free 20 credits per MB, Analyst 10, Plus 2 | забрать результат |
| `listQueryVisualizations` | Visualization | `query_id` | не заявлен | unverified | инвентарь визуализаций своего запроса |
| `archiveDashboard` | Dashboard | идентификатор дашборда | не заявлен | unverified | уборка своих артефактов |
| `getUsage` | Account | — | не заявлен | unverified | **сверка факта расхода** — критично для budget-guard |

**Честная пометка:** остальные имена — вся категория Materialized Views (6), а также оставшиеся позиции Visualization (5) и Dashboard (4) — в переданные данные **не попали**. Они существуют (все 26 имён физически присутствуют в `mcp.md:173-198`), но воспроизводить их по памяти я не буду: это ровно тот класс имён, который модель достраивает по аналогии. Статус — **unverified, требует чтения `mcp.md:173-198`**.

## Авторизация

Два режима, дословно: «Dune MCP supports two authentication modes today: 1. OAuth 2.0 (recommended for Browser agents…) 2. Dune API key (recommended for environments with no access to a browser)».
- **OAuth 2.0:** issuer `https://dune.com/oauth/mcp`; discovery `https://dune.com/.well-known/oauth-authorization-server/oauth/mcp`; authorize/token/register/jwks — `https://dune.com/oauth/mcp/{authorize,token,register,jwks.json}`; grant types `authorization_code`, `refresh_token`; client auth at token endpoint — `none` (public clients); PKCE **required** (`S256`); scope `mcp:dune:full`; resource `https://api.dune.com`.
- **API-ключ:** заголовок `x-dune-api-key: <dune-api-key>` либо query `?api_key=<dune_api_key>` («Generally using the Header is preferred but some agents do now allow you to configure the Headers…»).
- Подключение: `claude mcp add --scope user --transport http dune https://api.dune.com/mcp/v1 --header "x-dune-api-key: <dune-api-key>"`.

## Чего в MCP нет против REST

1. **`POST /v1/.../execute-sql` — исполнение произвольного SQL без сохранения запроса.** Тула нет. Это отсекает единственный путь, у которого в доке **нет** планового гейта на Query-эндпоинты.
2. **Дешёвое чтение готового результата.** В REST есть `GET /v1/query/{id}/results`, который «does NOT trigger an execution». В MCP аналога нет: `getExecutionResults` работает по `execution_id`, то есть требует предварительного `executeQueryById`. **Через MCP нельзя получить готовый ответ, не оплатив исполнение** — прямой удар по бюджету Free.
3. Смещение области: 15 из 26 тулов (Materialized Views 6 + Visualization 5 + Dashboard 4) обслуживают создание и оформление **своих** артефактов. На цепочку «найти → прочитать → исполнить → проверить» реально работают 8: `searchDocs`, `searchTables`, `searchTablesByContractAddress`, `getTableSize`, `getDuneQuery`, `executeQueryById`, `getExecutionResults`, `getUsage` — и из них `getDuneQuery` платный.
4. Клиентское ограничение, задокументированное в самой доке: «Codex's MCP client has a default tool timeout of 60 seconds… the MCP transport does not auto-reconnect after a timeout — all subsequent tool calls will fail with `Transport closed`». Обход — `tool_timeout_sec = 300`.

## (б) Развилка — решение: **ГИБРИД, с REST-адаптером в рантайме**

| Вариант | Цена | Вердикт |
|---|---|---|
| **Проксировать официальный MCP** | Нужна MCP-клиентская подсистема, которой у нас нет: все адаптеры ходят через `safe-fetch.ts:182-190`. Нет per-tool стоимости ⇒ budget-guard слеп. Нет `execute-sql` и нет дешёвого чтения результата — то есть отсутствуют ровно те две операции, которые нужны рантайму. Поверхность дрейфует без changelog (404; 12 → 26 тулов). Плюс чужие клиентские таймауты и невосстанавливаемый транспорт | **Отклонено для рантайма** |
| **Свой REST-адаптер** | Пишем сами: `execute → poll → results`, бэкофф, обработка частичных результатов (внутренний потолок Dune 32GB, `allow_partial_results=true`), SQL-гард. Взамен: машиночитаемый контракт `openapi.json` (200 145 B, 47 операций) для CI-дифа; факт расхода виден через `execution_cost_credits` на `/v1/execution/{id}/status` и дельту `/v1/usage`; ложится на существующие `safeFetch` + токен-бакет + `budget-store` без новых зависимостей; асинхронность уже предусмотрена `ARCHITECTURE.md:139-144` | **Принято для рантайма** |
| **Гибрид** | Официальный MCP — только в дев-петле аналитика (Discovery-тулы `searchTables`/`searchTablesByContractAddress`/`getTableSize` для авторинга и предварительной оценки стоимости SQL); в продукт уезжает только REST-адаптер | **Принято** |

Решающий аргумент — не удобство, а бюджет: budget-guard требует факта списания на провайдера (`budget-store.ts:46-93`, ключ `provider: string`), а MCP per-tool стоимость не раскрывает. Второй аргумент — MCP не содержит `execute-sql` и дешёвого чтения результата, то есть проксирование дало бы нам **более дорогой** доступ к меньшему множеству операций.

## (в) «Максимально продвинутый коннектор» операционально

1. **Поиск.** Через MCP/REST ищутся **таблицы**, а не чужие запросы (`searchTables`, `searchTablesByContractAddress`, `POST /v1/datasets/search`). Обязательный шаг перед любым платным исполнением — `getTableSize` как оценка стоимости. Поиск чужих запросов закрывается каталогом (Q10), а не API.
2. **Чтение SQL.** `getDuneQuery` / `GET /v1/query/{id}` — гейтится (Analyst либо Plus, противоречие первоисточника не разрешено). На Free шаг **невыполним по API**, а через UI это скрапинг ⇒ каталог хранит **наш** SQL.
3. **Исполнение с параметрами.** Три пути: `executeQueryById` / `POST /v1/query/{id}/execute` с параметрами (для чужого запроса документирован 403); `POST /v1/sql/execute` — freeform SQL, scope `Read`, планового гейта в доке нет (наш основной путь); `select * from query_<id>` (Query Views с пробросом параметров) — в этом прогоне **не профилирован**, unverified. Обязательные рычаги: выбор `performance_engine` и `max_credits_per_request` (плюс парный `ignore_max_credits_per_request`) — единственная защита от непредсказуемой compute-стоимости. Polling статуса у Dune бесплатен («Free status polling.»), поэтому опрашиваем статус, а не блокируем соединение.
4. **Materialized views.** 6 тулов, но на Free практически нежизнеспособны: «On the free tier you can only create a 1MB materialized view», сторедж Free 100 MB, запись 3 credits per GB Written с «Minimum charge is 1 credit per write operation», расписание «at least 15 minutes and at most weekly», имя обязано быть `dune.<your_team>.result_<name>`, и **каждый refresh — это исполнение запроса и трата кредитов**. Для нас — anti-goal на Free.
5. **Дашборды.** 4 тула — публикация результатов обратно в Dune. Для read-only движка это чистый anti-goal: мы потребляем аналитику, а не издаём её. Отсутствие дашбордов в нашем коннекторе — **решение о scope, а не пробел**.

**Доказательство:**
26 тулов и разбивка категорий — таблица `mcp.md:173-198` (сырой markdown, HTTP 200, 14228 байт; `grep -cE '^\| \*\*'` = 26; уникальных имён 26); редирект `docs.dune.com/api-reference/agents/mcp.md` → `docs.dune.com/docs/agents/mcp.md` подтверждает отсутствие второй страницы с другим числом. Все перечисленные имена встречаются в переданной фактбазе дословно; per-tool схемы/цены/гейты в первоисточнике отсутствуют. Авторизация — `mcp.md:21-24`, `:39`, `:40`, `:244-249`, `:250-254`. Гейт Query-эндпоинтов — queries/endpoint/read.md:17, create.md:15, list.md:14, update.md:16 против billing.md:65-67. Экспорт 20/10/2 credits per MB, запись 3 credits per GB, минимум 1 кредит на write, сторедж 100 MB, вебхуки 1 — api-reference/overview/billing. Движки (Small: 0 кредитов на запуск, 2-minute timeout, 3 concurrent; Large ≈2x compute) и «Exact credit consumption varies…» — pricing-faqs.md:154-181. Matview 1MB / cron ≥15 мин ≤ weekly / `dune.<your_team>.result_<name>` — materialized-views/overview.md, create.md. Codex-таймаут 60 s и `tool_timeout_sec = 300` — `mcp.md`. 47 операций и прайс `x-payment-info` — живой `https://api.dune.com/openapi.json` (200 145 B). Наши анкеры — `safe-fetch.ts:182-190`, `budget-store.ts:46-93`, `ARCHITECTURE.md:139-144`.

**Confidence:** high — число тулов (26), разбивка категорий, авторизация, два функциональных разрыва против REST, тарифные числа (все дословно из первоисточников, число 26 перепроверено детерминированным грепом и проверкой редиректа). high — по решению развилки (оно опирается на два проверенных факта: MCP не раскрывает per-tool стоимость и не содержит `execute-sql`). medium — по вменению REST-гейтов и REST-цен конкретным MCP-тулам: первоисточник MCP этого не утверждает. unverified — 13 имён тулов (Materialized Views, часть Visualization и Dashboard), per-tool входные схемы, статус GA/beta, собственные лимиты `/mcp/v1`, работоспособность `select * from query_<id>`.

**Что делаем мы:**
В продукт уезжает REST-адаптер на `api.dune.com` (host в `providers.config.ts:115`, allowlist `safe-fetch.ts:19-23/:209`), асинхронный execute→poll→results, обязательный `max_credits_per_request`, факт расхода снимается с `execution_cost_credits` и `/v1/usage` и сверяется реконсиляцией по паттерну `nansen/index.ts:576-581`. Официальный MCP подключаем **только** в дев-окружении через `claude mcp add --scope user --transport http dune https://api.dune.com/mcp/v1` — его ценность в Discovery-тулах при авторинге SQL, а не в рантайме. Materialized views и дашборды объявляем anti-goal и фиксируем это в отчёте как решение о scope. Прежде чем писать код по этой таблице — дочитать `mcp.md:173-198` и заполнить 13 неподтверждённых имён: воспроизводить их по памяти запрещено.
