# Task 005-3 — [R-36/R-37] cost-table codegen + `costOf()` + `NansenAccountState` + pre-call budget gate

| Поле                    | Значение                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                                                                                               |
| **Тип**                 | Dev (Stub-First: Phase 1 codegen + сигнатуры → Phase 2 формула потолка + гейт + 3 обязательных теста)                                                                |
| **R-IDs**               | **R-36**, **R-37**                                                                                                                                                   |
| **Зависимости**         | 005-1 (скелет адаптера), 005-2 (`BudgetStore.checkAndReserve`, `dayBucketMs`)                                                                                        |
| **Разблокирует**        | 005-5 (wiring гейта в `fetch()`), 005-6 (`NANSEN_DAILY_CREDIT_CAP`/`WARN_RATIO` как deps)                                                                            |
| **Источники**           | [system-architecture.md](../architectures/system-architecture.md) §3.2 «Cost-table generation», «Account-state», «Формула потолка бакета», «Атомарный check+reserve» |
| **Живые кредиты**       | **0** — `/account` в тестах отдаётся инжектированным `fetchImpl` из фикстуры                                                                                         |

## Цель

Сделать бюджет **вычислимым до сети**: точная цена вызова из статической таблицы, живой потолок из
`/account`, и атомарный гейт, который отказывает **до** единого исходящего байта. Оба обязательных
отказ-кейса (150cr и 100cr) закрываются здесь — **чистой арифметикой, без сетевого вызова**.

## Контекст: файлы

**Новые:**

- `packages/core/scripts/generate-nansen-cost-table.mjs` — ручной dev-скрипт (аналог
  `record-fixture.mjs`, **вне CI**): читает `x-credit-cost` из закоммиченного
  `docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json`, пишет `cost-table.ts`.
- `packages/core/src/adapters/nansen/cost-table.ts` — **сгенерированный, закоммиченный** литерал
  `NANSEN_COST_TABLE: Readonly<Record<string, { free: number; pro: number }>>`.
- `packages/core/src/adapters/nansen/account-state.ts` — `NansenAccountSnapshot`,
  `NansenAccountState`, `createNansenAccountState()`.
- `packages/core/src/adapters/nansen/cost-of.ts` — маппинг capability+args → список `(method,path)`
  → сумма цен под живым `plan`.
- `packages/core/src/adapters/nansen/budget-gate.ts` — `ensureBudget(...)`: resync-решение,
  `effectiveCeiling`, вызов `checkAndReserve`, warn-порог.
- `packages/core/test/nansen.cost-of.test.ts`, `packages/core/test/nansen.budget-gate.test.ts`.
- `packages/core/test/fixtures/nansen/account.free.json`, `account.pro.json` — **provisional,
  spec-derived** (форма из пробника `nansen-probe-2026-07-23.json`; в 005-7 `account.free.json`
  заменяется реально записанным, 0cr).

**Правки:**

- `packages/core/src/adapters/nansen/index.ts` — `costOf()` перестаёт быть стабом; `NansenAdapterDeps`
  получает `budgetStore`, `dailyCreditCap?`, `budgetWarnRatio?`, `now?`, `fetchImpl?`, `env?`.

## Cost-таблица — ровно ~8 эндпоинтов (не все 74)

```ts
export const NANSEN_COST_TABLE: Readonly<Record<string, { free: number; pro: number }>> = {
  'GET /api/v1/account': { free: 0, pro: 0 },
  'POST /api/v1/smart-money/netflow': { free: 5, pro: 5 },
  'POST /api/v1/tgm/holders': { free: 5, pro: 5 },
  'POST /api/v1/search/general': { free: 0, pro: 0 },
  'POST /api/v1/search/entity-name': { free: 0, pro: 0 },
  'POST /api/v1/profiler/address/labels': { free: 100, pro: 100 },
  'POST /api/v1/tgm/indicators': { free: 5, pro: 5 },
  'POST /api/v1/tgm/token-information': { free: 1, pro: 1 },
};
```

`costOf()` — маппинг capability → фиксированный список эндпоинтов, **сумма** их цен:

| Capability                                                                    | HTTP-вызовы                                          | `costOf()`   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| `smart-money.flows`                                                           | `/smart-money/netflow` + `/tgm/holders` (всегда оба) | **10** (5+5) |
| `entity.labels`, дефолт (`query` без `tokenAddress`)                          | `/search/general` [+ `/search/entity-name`]          | **0**        |
| `entity.labels`, token-scoped (`tokenAddress`, `!exhaustive`)                 | + `/tgm/holders`                                     | **5**        |
| `entity.labels`, `exhaustive: true`                                           | **только** `/profiler/address/labels`                | **100**      |
| `token.risk`                                                                  | `/tgm/indicators` + `/tgm/token-information`         | **6** (5+1)  |
| `smart-money.flows`/`entity.labels` с `premium_labels=true` на `/tgm/holders` | — (отказ-кейс)                                       | **150**      |

## Формула потолка — ЕДИНСТВЕННАЯ корректная свёртка

```
spentSinceAnchor = usage.credits_used(provider, bucket) - snapshot.usageAtObserve

allowed ⟺ (spentSinceAnchor + cost) <= snapshot.creditsRemainingAtObserve            // вендорский, anchor-relative
        ∧ (usage.credits_used(bucket) + cost) <= (NANSEN_DAILY_CREDIT_CAP ?? Infinity) // self-imposed, bucket-relative

⟺  effectiveCeiling = min( snapshot.usageAtObserve + snapshot.creditsRemainingAtObserve,
                           NANSEN_DAILY_CREDIT_CAP ?? Infinity )
   allowed ⟺ usage.credits_used(bucket) + cost <= effectiveCeiling
```

> ⛔ **`min(creditsRemainingAtObserve, CAP)` БЕЗ перебазирования на `usageAtObserve` — дефект, уже
> найденный на ревью.** При каждом mid-bucket resync он повторно вычитает уже учтённый расход:
> при 100cr и вызовах по 5cr после resync #2 (remaining=75, usage=25) потолок стал бы 75 вместо 100,
> и каждый следующий resync занижал бы его снова → phantom-lockout при живых деньгах на счёте.
> Числовая таблица-разбор — [system-architecture.md](../architectures/system-architecture.md) §3.2.

## Reviewer-заметки (обязательно применить)

- **Неизвестный `(method,path)` → `Number.POSITIVE_INFINITY`, НИКОГДА `0`.** Гейт проверяет
  `Number.isFinite(cost)` **до** любого обращения к `BudgetStore`/сети — `Infinity` не должен
  доходить до SQLite-параметра (биндить нечего).
- **Дефолт `plan: 'free'` до первого резолва** — консервативно: `free`-цена `>=` `pro`-цены на
  **каждом** из 8 используемых эндпоинтов, значит ошибка возможна только в безопасную сторону.
- **Resync (`GET /account`, 0cr) — только по двум триггерам:** (1) cold start **или**
  `snapshot.dayBucketMs !== dayBucketMs(now)`; (2) `accountState.isUnreconciled()`. **Не на каждый
  вызов** — `/account` бесплатен по кредитам, но не по rate-limit-слоту и латентности.
- **`/account` и чтение `usage.credits_used(provider, bucket)` — ОДИН логический шаг resync'а**
  (оба значения попадают в ОДИН `NansenAccountSnapshot`, без платного вызова между ними), иначе
  якорь протухает до того, как станет частью снимка.
- **⚠️ `refreshAccount()` шлёт ПЕРВЫЙ аутентифицированный запрос — заголовок `apiKey`, НЕ
  `Authorization: Bearer`** (M-4 review). `/account`-resync живёт **здесь**, а не в 005-4: `Bearer`
  тут провалил бы **каждый** resync → fail-closed → тотальный lockout, впервые обнаруженный только в
  005-7 на живом ключе. Использовать тот же helper/форму, что `endpoints.ts` (005-4): заголовок
  `apiKey: <NANSEN_API_KEY>` (живой пробник: `auth.scheme:'apiKey', in:'header', name:'apiKey'`;
  Bearer — это MCP-эндпоинт Nansen, вне скоупа). Грепом покрыто в acceptance.
- **Провал самого resync'а — fail-closed:** `fetch()` бросает **до** `checkAndReserve` (валидного
  `ceiling` нет — вычислять нечего), а не работает со stale/нулевым потолком.
- **`dayBucketMs` фиксируется ОДИН раз** локальной константой **до** `checkAndReserve` и
  возвращается наружу вместе с `reservedTotal`, чтобы 005-5 передал **тот же** бакет в
  `recordDelta`. **Никогда** не пересчитывается из `Date.now()`.
- **Отказ называет, какой из двух пределов сработал:** «vendor: need X, remaining (as of last
  resync) Y» vs «self-imposed cap: need X, NANSEN_DAILY_CREDIT_CAP allows Y» — иначе оператор не
  отличит реальное исчерпание счёта от собственной защёлки.
- **Ключ никогда не попадает в текст причины отказа.**
- **Warn-порог:** `NANSEN_BUDGET_WARN_RATIO` (дефолт `0.8`) — доля, не абсолютное число; одна
  stderr-строка, **не чаще одного раза на пересечение порога за бакет** (boolean-флаг в
  `NansenAccountState`, сбрасывается на следующем resync). Тот же канал, что M1 cache-метрики —
  **stdout не трогать** (инвариант M0 §7.3).
- **`clearUnreconciled()` снимается только успешным `refreshAccount()`**, не успешным платным
  вызовом (флаг означает «до следующего resync живому счётчику доверять нельзя»).
- **Гейт — внутренний, не экспортируемый модуль.** Из `src/index.ts` наружу уходит **только**
  `createNansenAdapter` — «сырых», не прошедших гейт примитивов в публичном API пакета нет.
- **Генератор cost-таблицы читает openapi точечно** (`jq`-выборка нужных операций), **не** грузит
  весь 630KB-файл в память агента при ревью; сам скрипт может читать файл целиком — это Node, не
  контекст агента.

## Phase 1 — codegen + сигнатуры `[STUB CREATION]`

1. Написать `generate-nansen-cost-table.mjs`, прогнать, закоммитить сгенерированный `cost-table.ts`
   (артефакт должен быть человекочитаемым и git-diff'абельным).
2. `account-state.ts` — фабрика + стаб-методы; `cost-of.ts`/`budget-gate.ts` — сигнатуры + стабы
   (`costOf` → `Infinity`, `ensureBudget` → throw «not implemented»).
3. Фикстуры `account.free.json` / `account.pro.json` (spec/probe-shaped, помечены `provenance:
spec-derived, NOT live` в соседнем `.evidence.md`).
4. Тесты red.
5. **Verification Phase 1:**

```bash
node packages/core/scripts/generate-nansen-cost-table.mjs   # перегенерация идемпотентна
git diff --stat -- packages/core/src/adapters/nansen/cost-table.ts   # пусто при повторном прогоне
pnpm --filter @onchain-intel/core exec tsc --noEmit
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. `costOf(cap, args)` — маппинг по таблице выше, сумма, `plan` из `accountState.get()?.plan ?? 'free'`,
   неизвестный ключ → `Infinity`.
2. `refreshAccount()` — `GET /api/v1/account` через `safeFetch` + `throttle('nansen', …)` с
   `apiKey`-заголовком; собирает `NansenAccountSnapshot` (включая `usageAtObserve` из
   `budgetStore.getUsage`) одним шагом.
3. `ensureBudget(cap, args)` → `{ reservedTotal, bucket }` или throw: resync-решение → `costOf` →
   `Number.isFinite`-проверка → `effectiveCeiling` → `checkAndReserve` → warn-порог.
4. Тесты (см. ниже).

## Test Cases

1. **TC-UNIT-01 (R-37, отказ-кейс A — 150 против 100):** снимок `plan:'free',
creditsRemainingAtObserve:100, usageAtObserve:0`; запрос `premium_labels=true` на `/tgm/holders`
   (150cr) → `ensureBudget` бросает/`{ok:false}`, **`fetchImpl`-spy имеет 0 вызовов**,
   `getUsage` до и после идентичен. _Сети нет — это арифметика против статической таблицы._
2. **TC-UNIT-02 (R-37, отказ-кейс B — 100 против остатка):** `entity.labels` с `exhaustive:true`
   (100cr) при `usage(bucket)=5`, ceiling=100 → отказ; те же две проверки (0 сетевых вызовов,
   `usage` не изменился). Независим от TC-01.
3. **TC-UNIT-03 (R-37, atomicity):** два **разных** одновременных вызова по 60cr при ceiling=100 →
   ровно один проходит, ровно один отказ, ровно одна резервация в `usage`.
4. **TC-UNIT-04 (R-37, fail-closed цена):** capability, чей эндпоинт отсутствует в
   `NANSEN_COST_TABLE` → `costOf() === Infinity` → отказ **до** `checkAndReserve` (spy на
   `budgetStore.checkAndReserve` не вызван — `Infinity` не должен доходить до SQLite).
5. **TC-UNIT-05 (R-36, UC-9 — апгрейд плана без правки кода):** та же попытка 150cr, но фикстура
   `/account` = `plan:'pro', credits_remaining:100000` → **проходит**. Меняется только фикстура,
   ни строки кода.
6. **TC-UNIT-06 (R-36, mid-bucket resync НЕ занижает потолок):** сценарий из архитектуры —
   `usage=25`, resync даёт `remaining=75` → `effectiveCeiling === 100` (не `75`); следующий 5cr-вызов
   проходит. **Прямой тест на дефект наивной формулы.**
7. **TC-UNIT-07 (R-36, cold start посреди бакета):** `usage(bucket)=40` уже персистентно (рестарт
   процесса), первый resync → `usageAtObserve === 40`, `effectiveCeiling === 40 + remaining`.
8. **TC-UNIT-08 (R-36, смена дня):** снимок из вчерашнего бакета → обязательный resync, а не перенос
   вчерашнего остатка.
9. **TC-UNIT-09 (R-36, resync упал):** `fetchImpl` для `/account` бросает → `ensureBudget` бросает,
   `checkAndReserve` **не вызывался** (fail-closed).
10. **TC-UNIT-10 (R-37, `NANSEN_DAILY_CREDIT_CAP`):** cap=20 при vendor-ceiling=100 → третий 10cr-вызов
    отказан, и в причине названа **self-imposed cap**, а не vendor.
11. **TC-UNIT-11 (R-37, warn-порог):** пересечение `0.8` → ровно одна stderr-строка; повторный вызов
    в том же бакете — **без** второй строки; stdout пуст.
12. **TC-UNIT-12 (R-37, bucket binding):** `ensureBudget` возвращает `bucket`, равный
    `dayBucketMs(now)` на момент **входа**; подмена `now` после резервации его не меняет.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/nansen.cost-of.test.ts
pnpm --filter @onchain-intel/core exec vitest run test/nansen.budget-gate.test.ts
pnpm --filter @onchain-intel/core test
# R-37: fail-closed цена и корректная свёртка потолка:
grep -nE "POSITIVE_INFINITY" packages/core/src/adapters/nansen/cost-of.ts
grep -nE "usageAtObserve \+ .*creditsRemainingAtObserve" packages/core/src/adapters/nansen/budget-gate.ts
# запрет наивной свёртки (m-2 review — ловит и argument-swapped Math.min(cap, …creditsRemainingAtObserve),
# и идентификаторы с цифрами; настоящий дефект уже ловит TC-UNIT-06 численно):
grep -nE "Math\.min\([^)]*creditsRemainingAtObserve" packages/core/src/adapters/nansen/budget-gate.ts | grep -v "usageAtObserve" && echo "REVIEW: naive ceiling collapse" || echo "anchored-ceiling-ok"
# R-36: потолок не из cost-таблицы:
grep -nE "NANSEN_COST_TABLE" packages/core/src/adapters/nansen/budget-gate.ts && echo "REVIEW: ceiling derived from cost table?" || echo "live-derived-ceiling-ok"
# M-4: /account resync шлёт apiKey, НЕ Bearer (первый аутентифицированный запрос — во всей nansen-директории):
grep -rnEi "authorization|bearer" packages/core/src/adapters/nansen/ && echo "REVIEW: wrong auth scheme" || echo "apikey-scheme-ok"
grep -rn "apiKey" packages/core/src/adapters/nansen/account-state.ts packages/core/src/adapters/nansen/budget-gate.ts
# генератор вне CI:
grep -rn "generate-nansen-cost-table" .github/workflows/ && echo "REVIEW: codegen in CI" || echo "codegen-not-in-ci-ok"
```

- **[R-36]** потолок только из `/account` + заголовков; `plan`-дефолт `free`; resync по двум
  триггерам; fail-closed при провале resync'а; UC-9 доказан подменой фикстуры.
- **[R-37]** `costOf()` — точная цена из сгенерированной таблицы, неизвестный ключ → `Infinity`;
  атомарный check+reserve; `effectiveCeiling` перебазирован на `usageAtObserve`; `dayBucketMs`
  зафиксирован на входе; оба отказ-теста + atomicity-тест зелёные **без единого сетевого вызова**.

## Notes

> **Ни одного живого вызова Nansen в этой задаче.** `fetchImpl` всегда инжектируется; если тест
> «случайно» попал в сеть — он написан неправильно, а не «почти работает».
