# Task 005-5 — [R-38/R-39] singleflight + wiring гейта + post-call reconciliation внутри `fetch()`

| Поле                    | Значение                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                                                                           |
| **Тип**                 | Dev (Stub-First: Phase 1 слои + композиция стабов → Phase 2 коалессинг + суммирование + resync-путь)                                             |
| **R-IDs**               | **R-38**, **R-39**                                                                                                                               |
| **Зависимости**         | 005-3 (гейт, `bucket`, `accountState`), 005-4 (реальные под-вызовы и их заголовки)                                                               |
| **Разблокирует**        | 005-6 (полностью budget-gated `fetch()` за tools)                                                                                                |
| **Источники**           | [system-architecture.md](../architectures/system-architecture.md) §3.2 «Singleflight», «Post-call reconciliation + transport-failure/402 resync» |
| **Живые кредиты**       | **0**                                                                                                                                            |

## Цель

Собрать финальную композицию `fetch()` адаптера `nansen` — так, чтобы **один логический вызов**
стоил ровно один раз, был неотменяемо учтён и не мог быть продублирован гонкой:

```
fetch(cap, args)
  └─ singleflight (ключ = deriveArgsHash(cap, args))        ← R-39, САМЫЙ внешний слой
       └─ ensureBudget(cap, args) → { reservedTotal, bucket } ← R-37 (005-3), атомарная резервация
            └─ под-вызовы endpoints.ts (1..2 HTTP)           ← R-29 (005-4)
                 └─ reconcile ОДИН раз: Σ заголовков − reservedTotal → recordDelta(…, bucket, delta)  ← R-38
```

Порядок слоёв — не стилистика: singleflight **после** гейта означал бы двойную резервацию; гейт
**до** cache lookup означал бы платящий кеш-хит (кеш живёт выше, в `CapabilityRegistry.resolve()` —
именно поэтому гейт внутри `fetch()` даёт правильный порядок бесплатно).

## Контекст: файлы

**Новые:**

- `packages/core/src/adapters/nansen/singleflight.ts` — `createSingleflight(): <T>(key: string, fn:
() => Promise<T>) => Promise<T>` поверх `Map<string, Promise<unknown>>`.
- `packages/core/src/adapters/nansen/reconcile.ts` — `reconcile({ subResponses, reservedTotal,
bucket, budgetStore, accountState })`.
- `packages/core/test/nansen.singleflight.test.ts`, `packages/core/test/nansen.reconcile.test.ts`.

**Правки:**

- `packages/core/src/adapters/nansen/index.ts` — финальная композиция `fetch()` (три приватных,
  **не экспортируемых** слоя вокруг под-вызовов 005-4).
- `packages/core/src/adapters/nansen/account-state.ts` — при необходимости добавить/использовать
  `markUnreconciled`/`isUnreconciled`/`clearUnreconciled` (интерфейс объявлен в 005-3).

## Reviewer-заметки (обязательно применить)

- **Реконсиляция — РОВНО ОДИН раз на логический `fetch()`**, после того как **все** под-вызовы
  завершились. `actualTotal = Σ(X-Nansen-Credits-Used)` по всем под-ответам,
  `delta = actualTotal − reservedTotal`, **один** `recordDelta`.
  > ⛔ Per-response реконсиляция для композитных способностей даёт
  > `usage += (5−10) + (5−10) = 0` — счётчик обнуляет сам себя на **каждом** платном вызове
  > `smart-money.flows`/`token.risk`. Это уже найденный на ревью дефект (C-1), не гипотеза.
- **`reservedTotal` — та же сумма, что ушла в `checkAndReserve`** (сумма ОБОИХ цен из cost-таблицы),
  не цена одного под-вызова.
- **`bucket` в `recordDelta` — тот же `dayBucketMs`, что вернул `ensureBudget`.** Никогда не
  пересчитывать из `Date.now()` на момент ответа: вызов, зарезервированный в 23:59:59.8 и
  отвеченный в 00:00:00.2, обязан попасть в **исходный** бакет, иначе отрицательная дельта уедет в
  чужой день и нарушит инвариант «`credits_used` только растёт или остаётся».
- **Отсутствующий/непарсящийся `X-Nansen-Credits-Used` хотя бы на ОДНОМ под-ответе → вся
  реконсиляция деградирует к `delta = 0`** (`Number()` + `Number.isFinite`-guard на каждый
  под-ответ). **Никогда** частичная сумма по тем под-ответам, где заголовок распарсился: частичная
  сумма систематически **недо**-считает факт — хуже консервативного нуля. Плюс
  `markUnreconciled()` и одна stderr-строка.
- **Транспортная ошибка/таймаут/`402` на любом под-вызове** → реконсиляция **не запускается вовсе**
  (нечего суммировать), резервация остаётся как единственный известный факт (**никогда не
  обнуляется молча** — направление безопасно, перерасход невозможен), `markUnreconciled()`.
  Следующий вход в gate обязательно резолвит `/account` (005-3, триггер 2) — это и есть лечение
  phantom-lockout'а.
- **Один и тот же механизм** покрывает «сеть отвалилась» и «Nansen сам сказал 402» — не два разных
  пути.
- **Ретрай (если когда-нибудь появится) не резервирует повторно:** резервация делается ровно один
  раз на вход в gate.
- **`clearUnreconciled()` — только успешный `refreshAccount()`**, не успешная реконсиляция.
- **Singleflight — per-process**, in-memory `Map`, ключ `deriveArgsHash(capability, args)`
  (существующий экспорт `net/args-hash.js`, **не новый примитив**), запись стирается в `finally`.
  Вызов, пришедший **после** разрешения первого, стартует заново — это новый по времени запрос, ему
  нужна собственная свежая проверка бюджета. Два **разных процесса** — два законных запроса,
  коалессинг между машинами не делается и не нужен.
- **Гейт/singleflight/reconcile — приватные шаги внутри `fetch()`**, не экспортируемые: из пакета
  наружу уходит только `createNansenAdapter` (нельзя случайно зарегистрировать «сырой» адаптер).
- **`registry.ts` по-прежнему не редактируется.** Отказ гейта — обычный `throw` из `fetch()`,
  который уже существующий try/catch `resolve()` превращает в `CapabilityUnavailableError` →
  `isError: true`.

## Phase 1 — слои и композиция `[STUB CREATION]`

1. `singleflight.ts` — фабрика + сигнатура (стаб: просто вызывает `fn()`).
2. `reconcile.ts` — сигнатура + стаб (no-op).
3. `index.ts` — композиция трёх слоёв вокруг существующих под-вызовов 005-4.
4. Тесты red.
5. **Verification Phase 1:**

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit
pnpm --filter @onchain-intel/core test    # 005-1…005-4 остаются зелёными
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Singleflight: `Map`, дедупликация, `finally`-очистка.
2. `reconcile`: суммирование, guard'ы, `recordDelta`, `markUnreconciled` на всех трёх аварийных
   путях, stderr-строка.
3. Композиция в `fetch()`: `singleflight(key, async () => { const {reservedTotal, bucket} = await
ensureBudget(...); try { const subs = await callEndpoints(...); await reconcile({subs, reservedTotal,
bucket, ...}); return normalizeInput; } catch (e) { accountState.markUnreconciled(); throw e; } })`.
4. Тесты green.

## Test Cases

1. **TC-UNIT-01 (R-38, композитный успех):** `smart-money.flows`, под-ответы с
   `X-Nansen-Credits-Used: 5` и `5`, `reservedTotal = 10` → **ровно один** `recordDelta` с
   `delta === 0`; итоговый `getUsage === 10` (не `0`, не `20`). **Прямой тест на дефект C-1.**
2. **TC-UNIT-02 (R-38, фактический ≠ зарезервированный):** заголовки `5` и `8` при
   `reservedTotal = 10` → `recordDelta(+3)`, `getUsage === 13`.
3. **TC-UNIT-03 (R-38, отрицательная дельта):** заголовки `2` и `2` при `reservedTotal = 10` →
   `recordDelta(-6)`, `getUsage === 4` (≥0).
4. **TC-UNIT-04 (R-38, один заголовок битый):** первый под-ответ `5`, второй — заголовка нет →
   `delta === 0` целиком (**не** `-5`), `markUnreconciled() === true`, одна stderr-строка.
5. **TC-UNIT-05 (R-38, транспортная ошибка на втором под-вызове):** реконсиляция **не вызывалась**
   (spy на `recordDelta` — 0 вызовов сверх резервации), `usage` = резервация, `isUnreconciled()`.
6. **TC-UNIT-06 (R-38, `402`):** тот же путь, что TC-05; следующий вход в gate делает `/account`
   (spy на `fetchImpl` видит `GET /api/v1/account`), а `clearUnreconciled` срабатывает **только**
   после его успеха.
7. **TC-UNIT-07 (R-38, bucket binding через полночь):** `now` на резервации = `D1 23:59:59.800`,
   на ответе = `D2 00:00:00.200` → `recordDelta` вызван с бакетом **D1**; `getUsage(D2) === 0`.
8. **TC-UNIT-08 (R-39, коалессинг):** два **параллельных идентичных** `fetch()` (без `await` между
   стартами) → `fetchImpl`-spy: ровно **один** набор под-вызовов; `checkAndReserve`-spy: **один**
   вызов; `recordDelta`: **один**; обе промисы получают один и тот же результат.
9. **TC-UNIT-09 (R-39, последовательные вызовы не коалессируются):** второй вызов **после**
   разрешения первого → новая проверка бюджета и новый сетевой вызов (это корректно).
10. **TC-UNIT-10 (R-39, ключ):** два вызова с одинаковыми args в **разном порядке ключей** дают
    один и тот же `deriveArgsHash` → коалессируются; разные args — нет.
11. **TC-UNIT-11 (R-39, очистка на ошибке):** первый вызов упал → запись из `Map` удалена, повторный
    вызов стартует заново (не залипает на отвергнутом промисе навсегда).
12. **TC-UNIT-12 (порядок слоёв):** при отказе гейта `fetchImpl` не вызван **ни разу**, но
    singleflight-запись всё равно очищена.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/nansen.singleflight.test.ts
pnpm --filter @onchain-intel/core exec vitest run test/nansen.reconcile.test.ts
pnpm --filter @onchain-intel/core test
# R-38: ровно один recordDelta на логический fetch (m-1 review — count + честный loop-детектор,
# не хрупкий позиционный grep; настоящий дефект уже ловит TC-UNIT-01 getUsage===10):
test "$(grep -c 'recordDelta' packages/core/src/adapters/nansen/reconcile.ts)" = 1 && echo "single-recordDelta-ok" || echo "REVIEW: recordDelta count != 1"
grep -nE "(for\b|forEach|\.map\(|\.reduce\()[^;]*recordDelta" packages/core/src/adapters/nansen/reconcile.ts && echo "REVIEW: per-response reconciliation" || echo "single-reconcile-ok"
# R-38: bucket приходит параметром, не пересчитывается:
grep -nE "dayBucketMs\(Date\.now\(\)\)|Date\.now\(\)" packages/core/src/adapters/nansen/reconcile.ts && echo "REVIEW: bucket recomputed at reconcile" || echo "bucket-threaded-ok"
# R-39: singleflight использует существующий deriveArgsHash:
grep -nE "deriveArgsHash" packages/core/src/adapters/nansen/index.ts
# registry.ts по-прежнему не тронут (working-tree; финальный BASE_SHA-срез — в 005-8):
git diff --stat -- packages/core/src/adapters/registry.ts    # пусто
```

- **[R-38]** реконсиляция ровно один раз на `fetch()`, `Σ` по под-ответам, подписанная дельта тем же
  аддитивным upsert, тот же `bucket`, fail-safe `delta=0` при битом заголовке, `markUnreconciled` на
  всех аварийных путях, `clearUnreconciled` только по успешному resync'у.
- **[R-39]** singleflight — самый внешний слой, до check-and-reserve; два параллельных идентичных
  вызова → 1 сетевой запрос + 1 запись `usage`; ключ — существующий `deriveArgsHash`.

## Notes

> **0 живых вызовов.** Все заголовки `X-Nansen-Credits-Used` в тестах — синтетические
> (`new Response(body, { headers })` в инжектированном `fetchImpl`).
