<!--
Канонический артефакт верификации прогона dune-query-discovery (run wf_af845947-864, 2026-07-27).
Здесь ТОЛЬКО несущие утверждения, которые проверка ИЗМЕНИЛА или пометила как недостоверные.
Полные тексты kill-shot и subclaims по каждой строке — в table.json (источник истины).
Шаблон записи: тег вердикта → Доказательство → Скорректировано → Источники.
-->

# Верификация: что проверка изменила

Три независимых слоя проверки: (1) adversarial-скептик на каждую строку, чей единственный KPI —
опровергнуть; (2) completeness-критик перед синтезом; (3) ручные сверки оркестратора вне агентского
контура. Ниже — только то, что **изменилось или помечено недостоверным**. Строки, устоявшие без
правок, здесь не перечисляются.

Итог по 35 строкам: **CONFIRMED — 30 · REFUTED — 5 · UNVERIFIED (пустой kill-shot) — 0.**

---

## В-1. [REFUTED] «Разница между планами Dune количественная (квота, цена за МБ, rpm), а не в наличии доступа»

**Доказательство.** Дословно из первоисточника `docs.dune.com/learning/how-tos/pricing-faqs`:
«**The Free query engine is limited to manual query editor executions only; automated executions
(API, scheduling, refreshing) are not available**» и «**free executions are not supported via the
API**» (там же, стр. 188 и 250 raw-версии).

**Скорректировано.** Гейт качественный, а не количественный: на Free **чтение** уже посчитанного
результата открыто, **исполнение через API — закрыто**. Практическое следствие, которого не было
ни в одном профиле и которое меняет дизайн: **протухший результат чужого запроса на бесплатном
плане нельзя обновить через API ни за какие кредиты** — ни `POST /execute`, ни SDK-шный
`max_age_hours` (он инициирует исполнение и упирается в тот же запрет). Свежесть данных целиком
во власти владельца запроса.

**Почему это несущее.** Именно этот пункт решает вопрос «дашборд пересобран 16 дней назад — что
делать»: на Free ответ — **ничего**, только ждать владельца или платить за план.

**Источники.** `https://docs.dune.com/learning/how-tos/pricing-faqs` (HTTP 200, raw `.md`-зеркало) ·
`https://docs.dune.com/api-reference/executions/endpoint/get-query-result`

---

## В-2. [ПРОТИВОРЕЧИЕ ПЕРВОИСТОЧНИКА, не разрешено] Dune противоречит сам себе по четырём решающим вопросам

Скептики независимо нашли **четыре самопротиворечия внутри официальной документации**. Ни одно не
разрешено — это фиксируется как состояние источника, а не как наш вывод.

| # | Вопрос | Версия A | Версия B |
|---|---|---|---|
| 1 | Плановый гейт Query-эндпоинтов | «To access Query endpoints, an **Analyst plan** or higher is required» — `queries/endpoint/read.md:17`, `create.md:15`, `update.md:16`, `list.md:14` (4 страницы) | «Queries Endpoint — **Available on Plus and Enterprise plans**» — `api-reference/overview/billing.md:65-67` |
| 2 | Исполнения через API на Free | «the API is included in all Dune plans… including those in the **Free plan, can access the API to trigger executions** and export data, provided their spend limit has not been exceeded» — `pricing-faqs.md:254` | «**free executions are not supported via the API**» — `pricing-faqs.md:250`; «automated executions (API, scheduling, refreshing) are **not available**» — `:188` (та же страница!) |
| 3 | Цена Small-движка | «Small Engine (**0 credits** to run)» — `pricing-faqs.md:157` | «Executions on the Small engine **consume a small amount of credits**» — `query-engine/query-executions.md:131` |
| 4 | Движок по умолчанию у `execute` | «by default it will use the **'medium'** performance tier» — проза `execute-query.md:48` | «Omit to use the default tier» без указания какой — OpenAPI-блок в **том же файле**, `:220-222` |

**Скорректировано.** Любой вывод о цене и доступности на Free получает `confidence: medium`
максимум, а решение «строить или нет» становится зависимым от **живого зонда**, а не от чтения
документации. Это прямая причина, по которой итоговый вердикт — NARROW-AND-GO с условиями, а не GO.

**Источники.** `https://docs.dune.com/api-reference/overview/billing` ·
`https://docs.dune.com/learning/how-tos/pricing-faqs` ·
`https://docs.dune.com/api-reference/queries/endpoint/read` ·
`https://docs.dune.com/query-engine/query-executions` ·
`https://docs.dune.com/api-reference/executions/endpoint/execute-query`

---

## В-3. [ИСПРАВЛЕНО] Числовые ошибки в тарифной сетке

**Доказательство.** `https://docs.dune.com/resources/credits-billing/how-credits-work.md`, строки 49–52.

**Скорректировано.** Профиль схлопнул четыре строки тарифа в две и перенёс **месячную** ставку на
**годовой** тариф. Верно:

| План | $/мес | $/год | кредитов/мес | $ за 100 кредитов |
|---|---|---|---|---|
| Free | $0 | — | 2 500 | $5.00 (overage) |
| Analyst | $75 | — | 4 000 | $1.875 |
| Analyst (Annual) | $65 | $780 | 4 000 | **$1.625** |
| Plus | $399 | — | 25 000 | $1.596 |
| Plus (Annual) | $349 | $4 188 | 25 000 | **$1.396** |

Две ставки были приписаны не тем тарифам, две отсутствовали вовсе.

---

## В-4. [ИСПРАВЛЕНО] Класс rate-limit для `GET /query/{id}/results` — 15 rpm, а не 40

**Доказательство.** High-limit корзина в `api-reference/overview/rate-limits` перечислена поимённо:
«read query, get execution result, get execution result CSV, get execution status, cancel execution».
**`get latest query result` в этом списке отсутствует.**

**Скорректировано.** Профиль выдал вывод за цитату. Планировать нагрузку следует от **15 rpm**
(low-limit корзина), а не от 40. Для агента, дергающего каталог из N закреплённых query_id, это
разница между «опрос раз в 4 секунды» и «раз в 1.5».

---

## В-5. [ИСПРАВЛЕНО] Несуществующий npm-пакет

**Доказательство.** `https://registry.npmjs.org/@duneanalytics%2Fclient` → `{"error":"Not found"}`.
Реальное имя — в поле `name` файла
`https://raw.githubusercontent.com/duneanalytics/ts-dune-client/main/package.json`.

**Скорректировано.** `npm install @duneanalytics/client` **упадёт**. Верно —
`@duneanalytics/client-sdk` (версия 0.4.3, публикация 2026-07-01).

---

## В-6. [СМЯГЧЕНО] «`POST /v1/sql/execute` — единственный документированный способ выполнить произвольный SQL»

**Доказательство.** Официальный CLI Dune имеет команду `dune query run-sql` — «Execute raw DuneSQL
directly (no saved query needed)»
(`https://raw.githubusercontent.com/duneanalytics/skills/main/skills/dune/SKILL.md`, стр. 133;
`README` репозитория `duneanalytics/cli`, стр. 39).

**Скорректировано.** Формулировка смягчена до «единственный API-**механизм**; доступен через REST,
официальный CLI и SDK». Утверждение на уровне механизма уцелело — CLI почти наверняка ездит поверх
того же эндпоинта, — но «единственный документированный способ» было переобобщением.

---

## В-7. [ИСПРАВЛЕНО, важно для цены] Выборочное цитирование про бесплатность неудачных прогонов

**Доказательство.** Профиль процитировал вторую половину `<Note>` в `billing.md` («Dune does not
charge for SQL syntax/semantic errors…») и **обрезал первую**: «Failed executions are **not always**
charged. Queries that run until Dune's execution timeout, executions stopped by a user-defined
resource/cost cap, and user-cancelled executions after compute has been used **may consume credits**
for resources already used.»

**Скорректировано.** Вывод «прогон чужого незнакомого SQL в дифф-проверке в общем случае бесплатен»
**не держится**: чужой незнакомый SQL — ровно тот случай, который упирается в таймаут или в
cost-cap, то есть в платную ветку. Для дизайна это значит: проверка чужого запроса «прогоном»
закладывается в бюджет как платная.

---

## В-8. [ОПРОВЕРГНУТО, 5 строк] Что скептики убили целиком

| Строка | kill-shot (суть) | Итог |
|---|---|---|
| **Blockchair API v2 (keyless)** | Живая проверка: `/stats` и `/bitcoin/stats` → HTTP 200 (ровно 2 запроса), дальше `/bitcoin/blocks?a=sum(generation)`, `/bitcoin/addresses`, `/ethereum/addresses` → **HTTP 430 на весь IP**; после >10 мин остывания бан вернулся первым же запросом и накрыл ранее работавший `/bitcoin/stats`. Вендор дословно: «Last week we had to enforce blocking all API requests that didn't use an API key» | keyless-режим мёртв ⇒ `reference` |
| **Blockscout Public REST API v2 (per-instance)** | Объявленный sunset: «PER INSTANCE API WILL BE DEPRECATED JULY…», дата уже просрочена; преемник key-gated на всех тарифах | понижение ⇒ `reference` |
| **Dune Advanced Search Filters** (`code:`/`author:`/`tags:`) | Убит не вывод, а **доказательство под ним**: proof-of-absence был построен неверно. Сам вывод «программного способа нет» устоял | `reject` |
| **Dune CLI** | Атака по плановому гейту: «`dune query get` вытаскивает SQL чужого публичного запроса и на Free это практически безлимитно» — не держится, Query-эндпоинты гейтятся платным планом | `reference` |
| **Dune MPP (HTTP-402)** | Из шести атак попали две: прайс-лист вендором не публикуется, фактический списываемый USD не раскрыт | `reference` |

---

---

# Поправки добивочного прогона (`wf_86bdc4b9-bab`)

Добивка профилировала 11 кандидатов, которых не хватало основному прогону. Три её вывода
**отменяют** утверждения основного прогона — они имеют приоритет.

## В-9. [REFUTED] «Дневной объём DEX по сетям не закрывает ни один бесплатный кандидат»

Это утверждение стояло строкой №6 в матрице сценариев BLUF основного прогона и было следствием
дефекта покрытия: семейство `alt-free` получило квоту 6 строк, и DefiLlama-агрегаты в неё не попали.

**Доказательство (живые вызовы, keyless, 2026-07-27).**
`GET https://api.llama.fi/overview/dexs/{chain}` → **HTTP 200 без единого заголовка авторизации**.
Собран целевой ответ: **10 сетей × 92 дня** за окно 2026-04-27…2026-07-27 за 12.3 с, **пропусков
нет ни в одной сети** (Ethereum $101.9B · Solana $178.7B · BSC $75.4B · Base $85.1B · Arbitrum
$18.5B · Polygon $24.2B · Hyperliquid L1 $29.1B · Avalanche $6.6B · OP Mainnet $1.8B · Sui $5.0B).
Глобальный ряд `totalDataChart` — 3 737 дневных точек с 2016-04-19; покрытие 287 сетей.

**Скорректировано.** Класс вопросов «дневной объём DEX по сетям» закрывается **бесплатно,
без ключа, и у нас уже есть адаптер `defillama` с хостом `api.llama.fi` в SSRF-allowlist**
(`packages/core/src/providers.config.ts:107-110`). Это самая дешёвая интеграция во всём
исследовании и одновременно строка с **максимальным fit во всей таблице — 12/12**.

**Побочная находка, повышающая доверие к источнику.** Скептик сверил арифметику внутри одного
документа: сумма `total24h` по протоколам без флага `doublecounted` = 5 955 816 880.62 против
последней точки графика 5 955 816 743.62 — расхождение **0.000002%**. То есть DefiLlama сам
исключает двойной счёт агрегаторов (54 протокола, $91.4M/24h: Unibot, Banana Gun, BONKbot, Photon,
BullX, Axiom, Trojan) — ровно та ловушка, которую чек-лист корректности требует проверять вручную.

**Оговорка, которую скептик добавил и которую нельзя терять:** гейт у DefiLlama **по-эндпоинтный,
а не по-хостовый**. На том же бесплатном хосте `GET https://api.llama.fi/emissions` → **HTTP 402**
«Upgrade to the paid API plan». Обобщать «api.llama.fi = бесплатно» на непроверенные пути нельзя.

## В-10. [REFUTED] «Flipside — живой бесплатный конкурент Dune по произвольному SQL»

Flipside был первым кандидатом в сидах брифа §4 как основная альтернатива Dune. Он **мёртв**.

**Доказательство (живые проверки 2026-07-27).** Девять хостов: `api-v2.flipsidecrypto.xyz` →
TLS `SSL_ERROR_SYSCALL`, HTTP 000; **два независимых DoH-резолвера** (`dns.google` и
`cloudflare-dns.com`) согласованно возвращают **NXDOMAIN** с висящим CNAME на
`compas-publi-…us-east-1.elb.amazonaws.com` без A-записи. Сам `flipsidecrypto.xyz/`, `/api-keys`,
`/flipspace/` и `data.flipsidecrypto.xyz` → **HTTP 301 на `https://edisyl.com/`** — домен уехал.
`docs.flipsidecrypto.com/api`, `api.flipsidecrypto.com`, `app.flipsidecrypto.com` → 403 Cloudflare
**даже с полным Chrome-UA** (то есть это не «блок бота»). Официальный SDK — в архиве.

**Скорректировано.** `fit 1/12`, вердикт `reject`. Практическое следствие: **бесплатной
альтернативы Dune по произвольному SQL в этом прогоне не найдено вообще** — ни одной. Это
усиливает вердикт NARROW-AND-GO, а не ослабляет: если Dune-путь не открывается живым зондом,
заменить его «другим SQL-движком» не получится, останется ярус готовых агрегатов (В-9) плюс
explorer-примитивы.

## В-11. [ПОНИЖЕНО] Мост «URL дашборда → query_id»: эндпоинт есть, но он не документирован

Это был главный практический вопрос владельца («вот дашборд, возьмите из него данные»).

**Доказательство.** `GET /api/v1/dashboards/by-slug/{owner_handle}/{slug}` существует в
первопартийной OpenAPI-спеке (`api.dune.com/openapi.json`, 200 145 байт), но **отсутствует во всём
опубликованном справочнике API**: `docs.dune.com/llms.txt` (HTTP 200, 99 948 байт, 1 086 строк —
собственный полный индекс документации вендора) перечисляет 77 страниц `/api-reference/*.md`, из
них `api-reference/dashboards` — **0 совпадений**, `api-reference/visualiz` — **0**. Официальный
Python-SDK `duneanalytics/dune-client` не имеет ни одного dashboard-эндпоинта; Go-страница доки
упоминает «dashboard» 0 раз.

**Скорректировано, три материальных факта:**
1. **Нужен ВТОРОЙ хоп.** Ответ отдаёт `visualization_widgets[].visualization_id`, а не query_id;
   чтобы получить query_id, на каждый виджет требуется `GET /api/v1/visualizations/{id}`.
2. **Плановый гейт — `unknown-likely-paid`.** Ни один первоисточник не заявляет требование плана
   для `/v1/dashboards/*`; в OpenAPI плановых метаданных нет вовсе. Неблагоприятная аналогия —
   ближайшее документированное семейство: «To access Query endpoints, an Analyst plan or higher
   is required».
3. **Вердикт `reference`, не `adopt`.** Строить продовый путь на недокументированном эндпоинте,
   плановый гейт которого неизвестен, — это принимать риск молчаливой поломки без уведомления.

**Что это значит для исходного вопроса.** Взять данные из конкретного дашборда технически можно, но
путь: (а) не документирован, (б) двухшаговый, (в) с неизвестным плановым гейтом, (г) и всё равно
упирается в В-1 — на Free исполнение через API запрещено, то есть свежее число получить нельзя,
только то, что владелец дашборда пересчитал сам.

---

## О. Слой оркестратора: ручные сверки вне агентского контура

Три решающих факта перепроверены мной лично, независимо от агентов (§6 методологии).

### О-1. [CONFIRMED] Инвентарь официального Dune MCP — ровно 26 тулов

Прямой `WebFetch` `https://docs.dune.com/api-reference/agents/mcp` (HTTP 200) дал поимённый список,
совпавший с агентским инвентарём **побайтово**: Discovery 5 (`searchDocs`, `searchTables`,
`listBlockchains`, `searchTablesByContractAddress`, `getTableSize`) · Query Lifecycle 5
(`createDuneQuery`, `getDuneQuery`, `updateDuneQuery`, `executeQueryById`, `getExecutionResults`) ·
Materialized Views 6 · Visualization 5 · Dashboard 4 · Account 1.

Утверждение прошлого исследования (`docs/onchain-analytics/verification-corrections.md` §1)
«26 тулов, а не 29» — **подтверждено повторно на 2026-07-27**.

> **Ловушка, которую поймал скептик инвентаря:** WebFetch-суммаризатор по той же странице в другом
> прогоне выдал «Total: 30». Правильное число получено только `curl` + `grep -cE '^\| \*\*'` по
> сырому `.md` (14 228 байт). Вывод для будущих прогонов: **считать элементы кодом по сырому
> источнику, а не глазами суммаризатора.**

### О-2. [ПОДТВЕРЖДЕНО] В Discovery-категории нет поиска по чужим запросам

Все пять Discovery-тулов ищут **документацию и таблицы**, а не чужие запросы/дашборды. Официальный
MCP спроектирован под сценарий «найди нужные ТАБЛИЦЫ → напиши СВОЙ SQL → исполни», а не под
«найди готовый чужой запрос». Это подтверждено и агентами независимо: в OpenAPI 39 путей,
единственный search — `POST /v1/datasets/search` (поиск таблиц), а `GET /v1/queries` возвращает
**свои** запросы.

### О-3. [ПОДТВЕРЖДЕНО] Гейт прав у `execute-query` — реальный

`https://docs.dune.com/api-reference/executions/endpoint/execute-query` документирует ошибку
**403 «Not allowed to execute query. Query is archived, unsaved or not enough permissions»**.
Права на исполнение — реальный гейт, а не формальность. При этом отдельный первоисточник
(`query-engine/query-executions.md:13`) даёт гарантию «Query executions can be triggered by **any
user or team for public queries**» — то есть 403 относится к приватным/архивным, а публичные
исполнимы. Оба факта сохранены в строках таблицы.

### О-4. [СТАТУС ДОСТАВКИ] `dune.com/pricing` — 403 краулеру, а не «частичный рендер»

Профиль писал «JS-рендерная, отдала краулеру только навигацию». Фактически `curl` получает
**HTTP 403 Forbidden, 5 441 байт**, без единого токена pricing/credits — это блок антибота.
Практическое следствие: **ни одно тарифное число нельзя брать со страницы цен**; все они должны
приходить из `docs.dune.com`, что и сделано.

Проверено также: `https://dune.com/the_defi_report/btc-deep-dive` (реальный дашборд владельца) —
`curl` с браузерным User-Agent возвращает **HTTP 403, 5 721 байт, `<title>Just a moment...`**
(Cloudflare-челлендж), ни одного `queryId` в теле. Скрапинг страницы дашборда для headless-агента
не работает — это подтверждает вердикт `reject` у строки «Dune Query page в вебе».

### О-5. [ИСПРАВЛЕНО] Ложная тревога в BLUF: «дизайн интеграции не доведён до `file:line`»

BLUF-агент внёс это в список дефектов целостности (п. 13). **Опровергнуто:** BLUF-агент не получал
на вход прозу дизайна врезки — только строки таблицы и вывод критика. В самом разделе «Дизайн
врезки» **74 ссылки `file:line`**, развилка коннектора разрешена (гибрид), есть схема записи
каталога, кредиты, TTL, безопасность и пошаговый план внедрения. Дефект снят.

### О-6. [ИСПРАВЛЕНО] Ложная тревога в BLUF: «Query Views ушли ниже линии и не профилировались»

BLUF-агент внёс это как дефект №5. **Опровергнуто:** строка `DuneSQL query-as-a-view
(SELECT * FROM query_<id>)` профилирована в семействе `dune-authoring` с вердиктом
`steal-pattern`. В `below_line` действительно лежит одноимённый near-дубликат из семейства
`dune-access` — BLUF-агент увидел его и принял за отсутствие. Это следствие дефекта дедупа Д-3
(см. `methodology.md` §7).

---

### О-7. [ИСПРАВЛЕНО] Скептик добивки объявил несуществующим файл, который существует

**Утверждение скептика** (строка DefiLlama, поле `rate_limit`): ограничение
`capacity 5 / refillPerSec 1` «cited at providers.config.ts:110 — **a file that does NOT exist in
this repository**».

**Проверено мной вручную:**

```
$ grep -n "defillama" -A3 packages/core/src/providers.config.ts
107:    id: 'defillama',
108-    hosts: ['api.llama.fi'],
109-    rateLimit: { capacity: 5, refillPerSec: 1 },
110-    requiresEnv: [],
```

Файл существует (`packages/core/src/providers.config.ts`, 8 939 байт, 173 строки), значение
`{capacity: 5, refillPerSec: 1}` — реальное и стоит на строке **109** (профилировщик промахнулся на
одну строку, но по существу был прав). Скептик, судя по формулировке, искал файл в корне
репозитория, а не в `packages/core/src/`, и от неудачного поиска сделал вывод о несуществовании.

**Почему это важно, а не мелочь.** Скептик на этом основании объявил «287 сетей ≈ 287 с» нашим
самоограничением, которого якобы нет в коде. Ограничение **есть** — оно реальное и его придётся
поднимать при интеграции DefiLlama-агрегатов. Вывод скептика (у API нет своего потолка — 65/65
origin-запросов без 429) остаётся верным; неверна только вторая половина про несуществующий файл.

**Урок для протокола:** «я не нашёл файл» ≠ «файла нет». Отрицательное утверждение о существовании
требует показать команду поиска и её область — иначе это не доказательство, а неудачный grep.

## Что осталось UNVERIFIED и почему

| Ячейка | Почему не проверено | Как проверить |
|---|---|---|
| Работает ли `GET /query/{id}/results` по чужому публичному запросу **на живом Free-ключе** | Нет `DUNE_API_KEY`; заводить аккаунт агентам запрещено | Зонд владельца: 1 вызов с бесплатным ключом |
| Гейтится ли `POST /v1/sql/execute` аккаунтом (`isFreeformAllowed`) | То же | Зонд: 1 вызов + чтение поля ответа |
| Фактический расход кредитов на вызов | Вендор дословно отказывается публиковать формулу: «we don't share a single, per-query formula because credit usage depends on real-time factors» | `execution_cost_credits` из `/v1/execution/{id}/status` + дельта `POST /v1/usage` до/после |
| Точный платный «пол» для Query-эндпоинтов ($65–75 Analyst против $349–399 Plus) | Противоречие первоисточника В-2, тай-брейкер `dune.com/pricing` отдаёт 403 | Письмо в поддержку либо живой вызов с Analyst-ключом |
| Дата введения scoped API keys | `docs.dune.com/changelog` отдал 404, поиск пуст | Сами скоупы Read/Read-Write подтверждены на странице authentication; дата — нет |
