# Task 005-4 — [R-29/R-45] HTTP-слой адаптера `nansen` + `normalize()` → 3 канонических типа + секретная дисциплина

| Поле                    | Значение                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                             |
| **Тип**                 | Dev (Stub-First: Phase 1 модули + spec-фикстуры + golden red → Phase 2 POST-вызовы + нормализация) |
| **R-IDs**               | **R-29**, **R-45**                                                                                 |
| **Зависимости**         | 005-1 (канонические типы, регистрация/hosts/rate-limit)                                            |
| **Разблокирует**        | 005-5 (под-вызовы, чьи заголовки суммирует реконсиляция), 005-6 (zod-out для tools)                |
| **Источники**           | system-architecture §3.2 + data-model §4.1 — см. «Источники» ниже                                  |
| **Живые кредиты**       | **0** — все тесты на инжектированном `fetchImpl` + spec-derived фикстурах                          |

## Источники

- [system-architecture.md](../architectures/system-architecture.md) §3.2 — «Десятый адаптер»,
  «429», «Частичный отказ».
- [data-model.md](../architectures/data-model.md) §4.1 — канонические типы.

## Цель

Научить адаптер реально говорить с `api.nansen.ai` (POST + JSON-тело + заголовок `apiKey`) и
превращать вендорские DTO в три канонических типа — **без** единого живого вызова в этой задаче.
Плюс доказать секретную дисциплину `NANSEN_API_KEY` тестами, а не декларацией.

## Контекст: файлы

**Новые:**

- `packages/core/src/adapters/nansen/endpoints.ts` — по одной тонкой функции на эндпоинт
  (`postSmartMoneyNetflow`, `postTgmHolders`, `postTgmIndicators`, `postTgmTokenInformation`,
  `postSearchGeneral`, `postSearchEntityName`, `postProfilerAddressLabels`), каждая возвращает
  `{ body: unknown; creditsUsedHeader: string | null }` — заголовок отдаётся **наверх**, парсит его
  реконсиляция (005-5), не сам эндпоинт.
- `packages/core/src/adapters/nansen/normalize.ts` — три функции нормализации.
- `packages/core/test/fixtures/nansen/*.json` + `*.evidence.md` — **provisional, spec-derived**.
- `packages/core/test/nansen.contract.test.ts` — golden-нормализация.
- `packages/core/test/nansen.secrets.test.ts` — R-45.

**Правки:**

- `packages/core/src/adapters/nansen/index.ts` — `fetch()` перестаёт бросать: маршрутизирует
  capability → набор эндпоинтов (гейт/singleflight/реконсиляция подключаются в 005-5;
  здесь `fetch()` — «сырой» композитный HTTP-путь + `normalize()`).

## Фикстуры: spec-derived, временные (PLAN §0.3)

Записать живые фикстуры до существования `fetch()` невозможно, а платить за них дважды нельзя.
Поэтому здесь они собираются **строго по response-схемам** закоммиченного
`docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json` — тот же прецедент, что вручную
собранная фикстура `dash-platform` в M1.

> ⛔ **Не читать openapi-файл целиком (630KB).** Только точечная выборка нужной схемы, например:
>
> ```bash
> jq '.components.schemas.SmartMoneyNetflow' docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json
> jq '.components.schemas.TGMHolder, .components.schemas.TGMIndicatorsResponse' docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json
> jq '.components.schemas.GeneralSearchResponse, .components.schemas.EntitySearchResult' docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json
> jq -r '.paths | keys[] | select(startswith("/api/v1/tgm") or startswith("/api/v1/smart-money"))' docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json
> ```

Каждый `*.evidence.md` обязан нести строку `provenance: spec-derived (openapi 2026-07-23), NOT live`
— в 005-7 она меняется на реальные `recorded_at`/`endpoint`/`HTTP status`/`X-Nansen-Credits-Used`.

Минимальный набор: `smart-money-netflow.json`, `tgm-holders.json`, `tgm-holders.empty-labels.json`
(0 меток — R-32), `tgm-indicators.json`, `tgm-token-information.json`, `search-general.json`,
`search-general.empty.json`.

## Reviewer-заметки (обязательно применить)

- **Заголовок `apiKey: <NANSEN_API_KEY>`, НЕ `Authorization: Bearer`.** Bearer использует
  MCP-эндпоинт Nansen (вне скоупа) — перепутать легко, поэтому в коде рядом стоит комментарий с
  источником (живой пробник: `auth.scheme:'apiKey', in:'header', name:'apiKey'`).
- **Все эндпоинты, кроме `GET /api/v1/account`, — POST с JSON-телом:**
  `{ method:'POST', headers:{ 'content-type':'application/json', apiKey }, body: JSON.stringify(...) }`
  — та же форма, что у `rpc-evm`'s JSON-RPC POST.
- **Каждый вызов идёт через `throttle('nansen', RATE_LIMIT)` → `safeFetch(url, opts, HOSTS, fetchImpl)`**
  — `hosts` берутся из `adapterRegistrations`-записи (per-adapter allowlist), не из литерала в коде.
- **Ключ читается ВНУТРИ вызова**, никогда на module-load, никогда не логируется, никогда не входит
  в `args_hash` (`deriveArgsHash` хеширует только нормализованный tool-input — это M1-инвариант,
  здесь его нужно **доказать тестом**, а не сохранить случайно).
- **`SENSITIVE_HEADER_RE` в `net/safe-fetch.ts` (`/authorization|api-?key/i`) уже покрывает `apiKey`**
  регистронезависимо (`Headers` лишает заголовок регистра до сравнения) — **правок regex не
  требуется**, нужен regression-тест конкретно для `nansen`.
- **`429`** → **явная немедленная ошибка** с `retry-after` в тексте. Никакого retry внутри адаптера
  (решение архитектуры: YAGNI + retry взаимодействовал бы с уже сделанной резервацией). Не «тихий»
  бесконечный цикл.
- **`402 Payment Required`** → авторитетный сигнал «бюджета сейчас нет»: `fetch()` бросает **целиком**
  (флаг `markUnreconciled` ставится в 005-5, здесь достаточно типизированной ошибки, которую 005-5
  распознает).
- **Частичный отказ композитных способностей:** если второй под-вызов упал после успешного первого —
  `fetch()` бросает целиком. **Никаких частичных canonical-результатов в M2** (fail-fast, как у
  любого M1-адаптера).
- **`normalize()` не бросается на «пустом, но валидном» ответе:** 0 меток / пустой `data[]` —
  валидный результат (R-32), не ошибка. Ошибка — только структурно сломанный ответ.
- **Anti-corruption:** обёртка `{data, pagination}` и любые вендорские имена полей (`net_flow_24h_usd`,
  `address_label`, …) остаются внутри `normalize.ts`; наружу уходят только канонические типы 005-1.
- **`fetchedAt`** — из инжектируемого `deps.now ?? Date.now` (детерминизм golden-тестов, как в
  `coingecko`).

## Phase 1 — модули + фикстуры + red `[STUB CREATION]`

1. `endpoints.ts` — сигнатуры всех семи функций + стаб-тела.
2. `normalize.ts` — три сигнатуры + стабы, возвращающие минимально-валидный объект.
3. Spec-derived фикстуры + evidence-файлы.
4. `nansen.contract.test.ts` / `nansen.secrets.test.ts` — red.
5. **Verification Phase 1:**

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit
ls packages/core/test/fixtures/nansen/    # фикстуры + evidence на месте
grep -L "provenance: spec-derived" packages/core/test/fixtures/nansen/*.evidence.md   # пусто
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Реальные POST-вызовы (throttle → safeFetch → статус-обработка → `response.json()` +
   `response.headers.get('x-nansen-credits-used')`).
2. Маршрутизация capability → эндпоинты внутри `fetch()`:
   - `smart-money.flows` → netflow + tgm/holders (всегда оба);
   - `entity.labels` → search/general [+ entity-name] / + tgm/holders / **только**
     profiler/address/labels при `exhaustive`;
   - `token.risk` → tgm/indicators + tgm/token-information (всегда оба).
3. `normalize()` → `SmartMoneyFlow` / `EntityLabel[]` / `TokenRiskScore`, финальный
   `Schema.parse(...)`.
4. Тесты green.

## Test Cases

### Golden / contract

1. **TC-CONTRACT-01 (R-31):** фикстура netflow+holders → `SmartMoneyFlow` поле-в-поле (4 окна
   netflow, `topHolders[]` — подмножество полей `TGMHolder`, адрес нормализован).
2. **TC-CONTRACT-02 (R-32, ≥1 метка):** `search-general.json` + `tgm-holders.json` → `EntityLabel[]`
   с непустым `labels[]`, `premiumRequested: false`.
3. **TC-CONTRACT-03 (R-32, 0 меток):** `search-general.empty.json` / `tgm-holders.empty-labels.json`
   → **валидный** результат с пустым массивом, не throw.
4. **TC-CONTRACT-04 (R-33):** `tgm-indicators.json` + `tgm-token-information.json` →
   `TokenRiskScore` с **раздельными** `riskIndicators`/`rewardIndicators`, числа — `number`.
5. **TC-CONTRACT-05:** malformed/обрезанный ответ → понятная ошибка нормализации, не крэш процесса.

### R-29 (HTTP-контракт)

6. **TC-UNIT-06:** заголовки исходящего запроса содержат `apiKey` и **не** содержат
   `authorization` (проверка на перехваченном `fetchImpl`).
7. **TC-UNIT-07:** метод — `POST`, `content-type: application/json`, тело — валидный JSON с
   ожидаемыми полями (доказывает, что тело реально сериализуется — это же требование к
   fixture-recorder'у в 005-7).
8. **TC-UNIT-08 (SSRF):** попытка вызова на host вне `['api.nansen.ai']` отклоняется **до** сети.
9. **TC-UNIT-09 (429):** ответ 429 + `retry-after: 30` → ошибка с текстом, содержащим `retry after`;
   **spy показывает ровно один** сетевой вызов (никакого молчаливого retry).
10. **TC-UNIT-10 (402):** ответ 402 → `fetch()` бросает типизированную ошибку (её 005-5 превратит в
    `markUnreconciled`).
11. **TC-UNIT-11 (частичный отказ):** первый под-вызов ок, второй бросает → `fetch()` бросает
    целиком, частичного результата наружу нет.
12. **TC-UNIT-12 (R-29, `isAvailable`):** без ключа — `{ok:false, reason}` **и ни одного** сетевого
    вызова.

### R-45 (секреты)

13. **TC-SEC-13:** `deriveArgsHash(cap, args)` идентичен при двух **разных** значениях
    `NANSEN_API_KEY` и одинаковых args.
14. **TC-SEC-14:** cross-host редирект (`302` на другой host из allowlist или проверка на уровне
    `safeFetch`-теста) → на следующем хопе заголовка `apiKey` **нет** (существующий
    `SENSITIVE_HEADER_RE`, без правок regex).
15. **TC-SEC-15:** перехват `console.log`/`console.error` во время полного цикла `fetch()` — ни одна
    строка не содержит значения ключа; сообщения ошибок (429/402/HTTP-статус) тоже.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/nansen.contract.test.ts
pnpm --filter @onchain-intel/core exec vitest run test/nansen.secrets.test.ts
pnpm --filter @onchain-intel/core test
# R-29: apiKey, не Bearer; POST-тело:
grep -nE "apiKey" packages/core/src/adapters/nansen/endpoints.ts
grep -nEi "authorization|bearer" packages/core/src/adapters/nansen/endpoints.ts && echo "REVIEW: wrong auth scheme" || echo "apikey-scheme-ok"
grep -nE "method: 'POST'" packages/core/src/adapters/nansen/endpoints.ts
# R-45: ключ не в кеш-ключе и не в логах:
grep -rn "NANSEN_API_KEY" packages/core/src/net/args-hash.ts && echo "REVIEW: key in cache key" || echo "key-not-in-args-hash-ok"
grep -rnE "console\.(log|error)\([^)]*apiKey" packages/core/src && echo "REVIEW: key may be logged" || echo "no-key-logging-ok"
# SENSITIVE_HEADER_RE не правился:
git diff -- packages/core/src/net/safe-fetch.ts | grep -E "SENSITIVE_HEADER_RE" && echo "REVIEW: regex touched (should not be needed)" || echo "regex-untouched-ok"
# M-2 (провенанс golden-теста): зафиксировать baseline-SHA nansen.contract.test.ts на spec-derived
# фикстурах — 005-7 сверяет его после живой записи (ассерты не должны переписываться под реальность):
shasum -a 256 packages/core/test/nansen.contract.test.ts   # записать в шапку task-005-7 (поле GOLDEN_TEST_SHA)
```

> **M-2:** SHA golden-теста (`nansen.contract.test.ts`), полученный здесь на spec-derived фикстурах,
> записывается в поле `GOLDEN_TEST_SHA` шапки [task-005-7](task-005-7-fixtures-live-verification.md).
> Там он сверяется `shasum -a 256` **после** живой записи — расхождение без явного логированного
> override = «тихая подгонка теста под фикстуру», нарушение R-44. Легальны только правки
> `normalize.ts`, не ассертов теста.

- **[R-29]** POST+JSON, `apiKey`-заголовок, только `api.nansen.ai`, `isAvailable()` до сети,
  консервативный rate-limit, 429 — явная ошибка без retry, 402 — типизированная ошибка,
  частичный отказ — throw целиком; unit-тесты на все пути.
- **[R-45]** ключ вне `args_hash`, вне логов, снимается на cross-host редиректе существующим
  `SENSITIVE_HEADER_RE` (без правок regex) — доказано тремя тестами.

## Notes

> **0 живых вызовов.** Записывать фикстуры живьём — задача 005-7 и только она. Если для отладки
> нормализации не хватает поля — брать его из openapi-схемы точечным `jq`, а не звонить в API.
