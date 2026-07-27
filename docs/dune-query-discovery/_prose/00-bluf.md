## 1. BLUF

**NARROW-AND-GO — полноценный Dune-слой «сложных запросов» в бесплатном контуре onchain-intel НЕ строим; строим узкий read-only срез: чтение результатов заранее закреплённых чужих публичных query_id через `GET /v1/query/{id}/results` (20 кредитов/МБ на Free, исполнение не триггерится), плюс опциональный `POST /v1/sql/execute`, у которого планового гейта в доке нет.**

Остаётся «go» ТОЛЬКО при выполнении всех четырёх условий: (1) живой зонд с бесплатным ключом подтвердил, что чужой публичный запрос действительно читается на Free (сейчас на Dune не сделано ни одного живого вызова — ключа не было); (2) снят гейт-конфликт первоисточника «Analyst» (`queries/endpoint/read:17`) против «Plus and Enterprise» (`overview/billing:65-67`); (3) расход измерен по `execution_cost_credits` из `/v1/execution/{id}/status` и дельте `POST /v1/usage`, а не оценён — Dune дословно отказывается публиковать формулу: «we don't share a single, per-query formula because credit usage depends on real-time factors»; (4) выставлен `max_credits_per_request` и НЕ выставлен `ignore_max_credits_per_request`. Если хоть одно не выполнено — вердикт автоматически падает в NO-GO, и слой замещается связкой A ниже.

---

## 2. Матрица «сценарий → выбор → почему»

| # | Сценарий | Выбор | Почему (число / эндпоинт) |
|---|---|---|---|
| 1 | Нужен готовый агрегат по BTC (эмиссия, дневные блоки/транзакции) | AWS Public Blockchain Data через keyless DuckDB; сверка — `https://api.blockchair.com/bitcoin/stats` | `btc/blocks` за 2026-07-26 = 146 блоков / 758 094 tx за 3.3 с без ключа; `h=959763 tx_count 4590` сошёлся с mempool.space точно; `circulation` 20 062 011.67 BTC против расчётной эмиссии, Δ 32.08 BTC = 0.00016% |
| 2 | Нужен произвольный SQL-агрегат по EVM | Dune `POST /v1/sql/execute` — только после живого зонда с бесплатным ключом | Сохранённые Query-эндпоинты гейтятся: «To access Query endpoints, an Analyst plan or higher is required» (`queries/endpoint/read:17`); у `/v1/sql/execute` планового гейта в доке НЕТ, scope Read; квота Free 2 500 кредитов/мес |
| 3 | Нужен holders-снимок токена | Blockscout `GET https://mcp.blockscout.com/v1/direct_api_call?chain_id=1&endpoint_path=/api/v2/tokens/<token>/holders` | Free-план дословно «100K credits/day · 5 RPS · All chains», `default`=20 кредитов/вызов; TTL уже задан в `packages/core/src/cache/ttl.ts:21` (`'token.holders': 3600`); заменяет мёртвую заглушку `packages/core/src/adapters/dune/index.ts:39` |
| 4 | Нужны метки сущностей (биржевой хот-кошелёк, протокол, is_scam) | Blockscout `GET /v1/get_address_info` вместо платного Nansen | metadata-апстрим = 120 кредитов из 100K credits/day; роут править на `packages/core/src/providers.config.ts:74` |
| 5 | Нужен дешёвый ежедневный ряд по метрике | НЕ Dune | Free = 2 500 кредитов/мес, формула стоимости не публикуется вендором; расход измерим только постфактум через `execution_cost_credits` на `/v1/execution/{id}/status`; перерасход = $5.00/100 extra |
| 6 | Нужен дневной объём DEX по сетям | Ни один бесплатный кандидат прогона не закрывает | У Blockscout 37 метрик в `/stats-service/api/v1/lines`, DEX/swap/volume среди них нет; в доке Blockchair (447 723 байта) `\bdex\b`=0, swap=0, uniswap=0, liquidity=0, amm=0 |

---

## 3. Готовые связки (bundles)

### A. «Нулевая стоимость» — разворачивать первой, независимо от решения по Dune

| Слой | Состав | Деньги |
|---|---|---|
| Сырой UTXO/BTC агрегат | AWS Public Blockchain Data через keyless DuckDB | $0 |
| EVM explorer-примитивы (`token.holders`, `entity.labels`, адрес/контракт/лог/ABI) | Blockscout hosted REST `GET https://mcp.blockscout.com/v1/<tool>` с бесплатным ключом `proapi_*` | $0, карта не нужна |
| Перекрёстная сверка чисел | существующий `rpc-evm` (`packages/core/src/providers.config.ts:121`) + mempool.space для BTC | $0 |
| Dune | отсутствует | — |

Правила эксплуатации:
- `hosts: ['mcp.blockscout.com']` обязателен, иначе `packages/core/src/net/safe-fetch.ts:19-23` (и per-hop проверка на `:209`) зарежет запрос.
- `rateLimit: { capacity: 5, refillPerSec: 5 }` под документированные 5 RPS, кладётся в `packages/core/src/net/rate-limit.ts:102-140`.
- `requiresEnv: ['BLOCKSCOUT_PRO_API_KEY']` закладывать СРАЗУ: issue #425 дословно «Starting July 20, 2026, all requests to the official public Blockscout MCP server will require a PRO API key for authorization»; дата прошла, принуждение не включено — это grace-период, а не контракт.
- Fallback-провайдер: при HTTP 429 (эмпирика: 12 параллельных keyless-вызовов дали 3×HTTP 429) и при HTTP 401 (битый ключ `proapi_bogus_test` → 401 без отката на серверный) — уход на `rpc-evm`.
- Мониторинг тихой деградации: читать `value_truncated` и поле `notes` в ответе — сервер сам режет метаданные; усечённое значение нельзя принимать за полное.
- Реальный потолок в тул-вызовах ниже наивного: `get_address_info` фанится в 3 апстрима (20 + 120 + 20 ≈ 160 кредитов) ⇒ ≈625 вызовов/сутки, а не ≈5 000; `get_address_by_ens_name` = 150 кредитов ⇒ ≈666/сутки.
- НЕ добавлять blockscout в `PAID_PROVIDER_IDS` (`packages/core/src/cache/sqlite-store.ts:48`); при желании считать кредиты — провайдер-агностичный `packages/core/src/cache/budget-store.ts:46-93`.

### B. «Free-tier Dune + fallback» — только после снятия дефектов §4

| Слой | Состав | Деньги |
|---|---|---|
| База | всё из связки A | $0 |
| Чтение чужих результатов | Dune Free-ключ, ТОЛЬКО `GET /v1/query/{id}/results` по ЗАКРЕПЛЁННОМУ в конфиге списку query_id | 20 кредитов/МБ (Free, «Data Export»), исполнение не триггерится |
| Опционально | `POST /v1/sql/execute` — после зонда и проверки `isFreeformAllowed` | из тех же 2 500 кредитов/мес |
| Фолбэк на каждое число | слой сверки из A | $0 |

Правила эксплуатации:
- `api.dune.com` внести в SSRF-allowlist `packages/core/src/net/safe-fetch.ts` — иначе запрос не выйдет.
- Комбинированный rate-limit 55 (15 rpm low + 40 rpm high); класс лимита именно для `/query/{id}/results` в таблицах `overview/rate-limits` не перечислен — считать по нижней границе.
- Потолок расхода: `max_credits_per_request` выставлен, тумблер extra-credit limit выключен; при исчерпании ожидается HTTP 402 — алерт обязателен, иначе слой отвалится молча.
- Динамического поиска чужих запросов НЕ реализовывать: в официальном MCP тула поиска нет, в OpenAPI 39 путей и единственный search — `POST /v1/datasets/search` (поиск ТАБЛИЦ), а `GET /v1/queries` возвращает СВОИ запросы. Единственный документированный мост «человеческий URL → query_id» — `GET /v1/dashboards/by-slug/{owner_handle}/{slug}`, и он в этом прогоне не профилировался.
- Каждое число, пришедшее из чужого запроса, сверять вторым источником: на Free SQL чужого запроса не читается (`GET /v1/query/{id}` гейтится), то есть источник числа неаудируем.

### C. «Когда появится платный план»

| Слой | Состав | Деньги |
|---|---|---|
| Dune | план, открывающий Query-эндпоинты (чтение SQL чужого запроса ⇒ появляется аудируемость) | цена unverified — первоисточник противоречив: «Analyst plan or higher» (`queries/endpoint/create:15`, `queries/endpoint/read:17`) против «Available on Plus and Enterprise plans» (`overview/billing:65-67`) |
| Blockscout | апгрейд, если упрёмся в 100K credits/day | $49/mo = 100M credits · 15 RPS; $199/mo = 500M credits · 30 RPS |
| Хранение/запись на Dune | учитывать отдельно | storage 100 МБ, запись 3 кредита/ГБ, webhooks 1 |

Правило перехода: сначала месяц телеметрии `execution_cost_credits` + дельт `POST /v1/usage` на Free, потом апгрейд. Апгрейд «на глаз» запрещён — формулы стоимости у вендора нет.

---

## 4. Дефекты целостности прогона — решить до любых трат

1. **По Dune не сделано ни одного живого вызова** (ключа не было). Центральный вопрос прогона — исполняется/читается ли ЧУЖОЙ публичный запрос на Free — закрыт только документацией. Опасность: весь §2-ряд «выбор = Dune» держится на доке, а дока Dune уже уличена в самопротиворечии (см. п.2).
2. **Первоисточник Dune противоречит сам себе по плановому гейту**: «Analyst plan or higher» против «Plus and Enterprise plans». Опасность: покупка не того плана.
3. **Формула стоимости кредитов не публикуется вендором** дословно. Опасность: бюджет Free (2 500 кредитов/мес) может выгореть за один тяжёлый прогон, и узнаем мы это только по HTTP 402.
4. **`isFreeformAllowed` не проверен.** Опасность: `POST /v1/sql/execute` — единственный обход планового гейта — может оказаться аккаунт-гейченным, и связка B схлопнется до чистого read-only.
5. **`select * from query_<id>` (Query Views с пробросом параметров) ушёл ниже линии и не профилировался.** Опасность: возможно, самый дешёвый путь переиспользования чужой логики пропущен.
6. **`core-api.dune.com` не зондировался ни разу**, Google-путь `site:dune.com/queries` не оценивался, UI-фильтры `code:"from dex.trades"`, `author:`, `tags:` существуют только в UI и headless-агенту непригодны. Опасность: раздел «обнаружение запросов» закрыт отрицательным выводом без полного перебора поверхностей.
7. **MPP тащит в контур агента кошелёк и on-chain escrow**, чего существующий budget-guard не моделирует. Живой 402 показал `amount 10710` при `decimals 6` ≈ $0.0107/запрос. Опасность: новый класс риска (ключи от денег в агентском контуре) не спроектирован.
8. **Blockscout keyless — закрывающееся окно**: issue #425 объявил принуждение с 2026-07-20, дата прошла, механизм анонса вмёржен PR #431 (merged_at 2026-07-24), но переменная на официальном деплое не выставлена. Опасность: молчаливая поломка в любой день. Митигация — завести бесплатный ключ ДО интеграции.
9. **Лицензия Blockscout — не OSS и отзывная**: `SPDX-License-Identifier: LicenseRef-Blockscout`, Effective 2026-05-15 (смена в v0.16.0, PR #347), `gh api` → `NOASSERTION`; §4(a) запрещает без Commercial Licence монетизированное/SaaS-использование Software, §2(c) требует видимой атрибуции, §10(b) допускает отзыв. Применимость §4(a) к ПОТРЕБЛЕНИЮ хостируемого сервиса — unverified, отдельного ToS PRO API найти не удалось. Опасность: путь «self-host + продать» перекрыт; потребление хоста — юридически не подтверждённая трактовка.
10. **Покрытие сетей у Blockscout уже 100, из них 47 тестнетов, мейннетов 53, не-EVM = 0.** Опасность: без `chainSupport`, построенного из `get_chains_list`, матрица покрытия `packages/core/src/chain/coverage.ts:70-89` будет рекламировать несуществующее (Bitcoin и Solana в списке отсутствуют).
11. **`packages/mcp-server/src/tools/budget-meta.ts:9` и `:38` жёстко зашиты на литерал `'nansen'`.** Опасность: второй кредитный провайдер не будет виден в `_meta` — расход станет невидимым именно там, где мы обещали мониторинг.
12. **Дефект покрытия прогона (логируется, не замалчивается):** семейство alt-free зажато квотой 6 строк (`.claude/workflows/dune-query-discovery.js:424`); минимум 2 из них съел near-дубликат Blockscout, ещё одну — Blockchair со статусом REFUTED. Из сидов брифа §4 НЕ профилирован ни один: Flipside SQL API, BigQuery public crypto datasets, Coin Metrics community, mempool.space, blockchain.com charts, growthepie, Artemis, Token Terminal, Bitquery free, The Graph. Отсутствие любого из них в отчёте — потеря покрытия, а не решение по скоупу.
13. **Дизайн интеграции (Q7) не доведён до `file:line`**: не заданы имена capability и тулов, форма адаптера, TTL по классам ответов, врезка кредитов в существующий `checkAndReserve`/usage-леджер и контур ограничения модель-сгенерированного SQL — а он становится ОБЯЗАТЕЛЬНЫМ, если ответом станет `POST /v1/sql/execute`.

---

## 5. Отклонённые гипотезы — REJECTED, задокументировано для полноты

- **«Исполнять чужие публичные Dune-запросы на Free» — REJECTED.** Фатально: `POST /v1/query/{id}/execute` документирует 403 «Not allowed to execute query… not enough permissions». Переиспользование чужой логики сводится к чтению уже посчитанного результата.
- **«Обнаруживать чужие запросы через официальный API/MCP Dune» — REJECTED.** Фатально: тула поиска по чужим запросам нет; в OpenAPI 39 путей, единственный search — `POST /v1/datasets/search` (таблицы), `GET /v1/queries` — свои. Дискавери в бесплатном контуре не реализуемо документированными средствами.
- **«Blockchair как бесплатный keyless-источник» — REJECTED.** Фатально: вендор дословно «Last week we had to enforce blocking all API requests that didn't use an API key» (issue #1652, 2025-07-15); живьём ровно 2 успешных keyless-запроса, дальше HTTP 430 на весь IP, бан держался >15 минут и накрыл ранее работавший `/bitcoin/stats`. Обе целевые функции (`/{chain}/addresses`, `?a=sum(generation)`) без ключа недостижимы. Дополнительно: changelog замер на v.2.0.95 от 23 декабря 2021, `next_major_update` = 2023-11-12 просрочен.
- **«3xpl как бесплатный преемник Blockchair» — REJECTED.** Фатально: `api.3xpl.com` → HTTP 403 «Access token is required», `https://3xpl.com/data` → HTTP 429. Обещание вендора «currently free to use» протухло.
- **«Blockscout закрывает потребность в агрегатах вместо Dune» — REJECTED.** Фатально: произвольных SQL-агрегатов нет как класса; 37 метрик в `/stats-service/api/v1/lines` без DEX/swap/volume; покрытие чисто EVM (не-EVM = 0), Bitcoin и Solana отсутствуют. Использование этой строки для агрегатных вопросов — ошибка архитектуры, а не компромисс.
- **«Blockchair покрывает 41 сеть» — REJECTED.** Фатально: живой `/stats` = 14 сетей, дока = 19, status-page = 15, rich list документирован для 10 UTXO + ethereum. Число 41 существует только как title недоступной краулеру страницы (401 + QRATOR).
- **«Blockscout — OSS и покрывает 3 000+ сетей» — REJECTED.** Фатально: `LicenseRef-Blockscout` (не OSI, `NOASSERTION`); живой `get_chains_list` = 100 записей, Chainscout = 752 — источника числа 3 000+ не существует.
- **«ERC-20 top-holders у Blockchair» — REJECTED.** Фатально: эндпоинт «ERC-20 token holder info» — это баланс ОДНОГО адреса по ОДНОМУ токену; документированного распределения холдеров токена в API нет. Подмена `token.holders` rich-list'ом нативной монеты была бы враньём в матрице покрытия.

---

## 6. Финал — решение

**Решение: NARROW-AND-GO.** Dune остаётся в контуре только как узкий read-only слой чтения результатов заранее закреплённых публичных query_id, и включается ТОЛЬКО после живого зонда с бесплатным ключом. Связка A («нулевая стоимость») разворачивается немедленно и независимо: она уже сегодня закрывает две capability, которые у нас висят мёртвыми — `token.holders` (заглушка `packages/core/src/adapters/dune/index.ts:39` отключена безусловно) и `entity.labels` (сейчас на платном Nansen, `packages/core/src/providers.config.ts:74`).

**Что знаем уверенно.** Бесплатный EVM-слой построчных explorer-данных существует и проверен живыми вызовами: Blockscout, Free-план «100K credits/day · 5 RPS · All chains», 16 тулов, 100 сетей, REST-фасад `GET /v1/<tool>` без MCP-клиента, ложится на существующий `safeFetch` + token-bucket + budget-store без новых зависимостей. Бесплатный BTC-агрегат существует и сверен независимо: 146 блоков / 758 094 tx за 3.3 с keyless, `tx_count 4590` сошёлся с mempool.space, `circulation` разошлась с расчётной эмиссией на 32.08 BTC = 0.00016%. Уверенно знаем и негатив: дискавери чужих запросов и исполнение чужих запросов на Dune Free закрыты (403, отсутствие search-эндпоинта), а DEX-агрегаты не закрывает ни один бесплатный кандидат прогона.

**Где доказательства тонкие.** Вся Dune-часть — доковая, живых вызовов ноль. Первоисточник Dune противоречит сам себе по плановому гейту, а формулу стоимости кредитов вендор публиковать отказывается — значит бюджет бесплатного контура принципиально не моделируется до первого живого замера. Keyless-доступ к Blockscout — объявленное к закрытию окно с прошедшей датой принуждения. Лицензионная применимость `LicenseRef-Blockscout` §4(a) к потреблению хоста — наша трактовка, юридически не подтверждённая. И отдельно: воронка `272 discovered → 272 deduped → 272 domain-gate → 35 curated → 35 profiled → 35 verified → 0 lost` при вердиктах `{"reference":14,"adopt":15,"steal-pattern":2,"reject":4}` включает near-дубликат Blockscout, съевший часть квоты семейства alt-free, — то есть ширина бесплатной обоймы недооценена, а не исчерпана.

**Следующее действие (одно, до любых трат).** Завести бесплатный Dune-ключ и выполнить зонд из трёх вызовов на ОДНОМ известном публичном query_id: `GET /v1/query/{id}/results` (читается ли чужой публичный результат), `POST /v1/sql/execute` (не гейтится ли freeform, что говорит `isFreeformAllowed`), `POST /v1/usage` до и после (фактическая дельта кредитов). Владелец — интегратор onchain-analytics; веха — до первой строки кода Dune-адаптера. Результат зонда — единственный переключатель между NARROW-AND-GO (связка B) и NO-GO (остаёмся на связке A). Параллельно и независимо от зонда: завести бесплатный `proapi_*`-ключ Blockscout и внести blockscout в `packages/core/src/providers.config.ts:69` и `:74`, зарегистрировать в `packages/mcp-server/src/index.ts:91`, параметризовать литерал `'nansen'` в `packages/mcp-server/src/tools/budget-meta.ts:9` и `:38`.
