# Task 005-6 — [R-41/R-42/R-43/R-46] три MCP-tool + `_meta.budget` + env/`.env.example`/`interfaces.md` §5.3

| Поле                    | Значение                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                                                        |
| **Тип**                 | Dev (Stub-First: Phase 1 zod in/out + хендлер-стабы + e2e red → Phase 2 хендлеры + `_meta.budget` + green)                    |
| **R-IDs**               | **R-41**, **R-42**, **R-43**, **R-46**                                                                                        |
| **Зависимости**         | 005-4 (нормализованные выходы), 005-5 (полный budget-gated `fetch()`)                                                         |
| **Разблокирует**        | 005-7 (живая запись идёт через продовый путь, а не через самодельный пробник)                                                 |
| **Источники**           | [interfaces.md](../architectures/interfaces.md) §5.1.2 (контракты + `_meta.budget`), §5.2 (`createServer`), §5.3 (интеграции) |
| **Живые кредиты**       | **0** — e2e идут на инжектированном fixture-registry, как в M1                                                                |

## Цель

Выставить три платные способности наружу как MCP-tool'ы с тем же качеством контракта, что 4
M1-tool'а, и дать вызывающему **видимость расхода** (`_meta.budget`) — не молчаливый расход.
Плюс закрыть env/доки, чтобы оператор мог включить слой одной переменной.

## Контекст: файлы

**Новые:**

- `packages/mcp-server/src/tools/smart-money-flows.ts`
- `packages/mcp-server/src/tools/entity-label.ts`
- `packages/mcp-server/src/tools/token-risk.ts`
- `packages/mcp-server/src/tools/budget-meta.ts` — общий хелпер `budgetMeta(budgetStore, now)` →
  `{ provider:'nansen', creditsUsedToday } | undefined` (тот же приём разделяемого хелпера, что
  `resolve-capability.ts` в M1).
- `packages/mcp-server/test/tools/smart-money-flows.test.ts`, `entity-label.test.ts`,
  `token-risk.test.ts`.

**Правки:**

- `packages/mcp-server/src/server.ts` — регистрация трёх tools; `CreateServerDeps` получает
  `budgetStore?: BudgetStore` (инжектируемый тем же способом, что `registry`).
- `packages/mcp-server/src/index.ts` — `['nansen', createNansenAdapter({ env, budgetStore })]` в Map
  адаптеров; `createBudgetStore()` конструируется один раз и передаётся и в адаптер, и в
  `createServer`.
- `packages/mcp-server/src/env.ts` — три новых опциональных ключа.
- `packages/mcp-server/test/e2e.inprocess.test.ts` — три новых сценария (fixture-registry).
- `packages/mcp-server/test/e2e.stdio.test.ts` — `tools/list` → **8**.
- `.env.example` — `NANSEN_API_KEY` из «M2+ зарезервировано» в «код читает сейчас» + два новых ключа.
- `docs/architectures/interfaces.md` §5.3 — **сверить** строку `nansen` с фактическим кодом.

## Контракты (буквально из [interfaces.md](../architectures/interfaces.md) §5.1.2)

```jsonc
// onchain_smart_money_flows — { chain: "ethereum"|"solana", tokenAddress: string (.max(64)) }
//   → SmartMoneyFlow      | capability smart-money.flows, costOf() = 10cr
// onchain_entity_label — {
//     chain, query? (.max(200)), tokenAddress? (.max(64)), exhaustive? (default false)
//   } → { chain, entities: EntityLabel[], source, fetchedAt }
//   | capability entity.labels, costOf() = 0 / 5 / 100cr
// onchain_token_risk — { chain, tokenAddress (.max(64)) }
//   → TokenRiskScore      | capability token.risk, costOf() = 6cr
```

```ts
export interface BudgetMeta {
  provider: 'nansen';
  creditsUsedToday: number; // usage.credits_used текущего day-бакета ПОСЛЕ этого вызова
}
```

## Reviewer-заметки (обязательно применить)

- **`chain` — `z.enum(['ethereum','solana'])`**, буквально та же пара, что 4 M1-tool'а (решение
  OQ-3). `.strict()` на объекте, `.max()` на строках, тот же `superRefine`/`isValidAddress`-идиом —
  **переиспользовать** M1-паттерн из `get-token.ts`, не изобретать заново (включая length-guard в
  начале `superRefine`, чтобы дорогой `bs58.decode` не запускался для патологического входа).
- **`onchain_entity_label` — единственный из 7 tools с составным `superRefine`:** требуется **хотя
  бы одно** из `query`/`tokenAddress`; при `exhaustive: true` **обязателен** `tokenAddress`.
- **`exhaustive` — explicit opt-in независимо от плана** (решение OQ-4): на Pro дефолт **не**
  поднимается автоматически. Дорогая операция всегда запрашивается явно.
- **`_meta.budget` присутствует ТОЛЬКО при `_meta.cache.status === 'miss'`** — на кеш-хите гейт/
  `costOf()`/сеть не исполнялись вовсе, поэтому поле **отсутствует целиком**, не коэрсится в
  `0`/`null` (тот же принцип, что `_meta.cache.ageMs` на miss).
- **`_meta.budget` читается отдельным `budgetStore.getUsage('nansen', dayBucketMs(Date.now()))`
  ПОСЛЕ `registry.resolve()`** — это чистое отображение, **не** часть gate-решения (оно уже
  случилось внутри `nansen.fetch()`). `CapabilityRegistry.resolve()`'s возвращаемый тип **не
  расширяется** — он общий для всех 10 адаптеров и не растёт ради одного платного.
- **`_meta` — сибling `structuredContent`, схема выхода не растёт** (M1-инвариант).
- **Хендлер — pure-функция `{ok:true,...}|{ok:false,reason}`, никогда не бросает**; `registerXTool`
  явно строит `{isError:true, content:[{type:'text', text: reason}]}` — тот же паттерн, что 4
  M1-tool'а (причина — осознанно выбранное сообщение, а не generic `.message`).
- **`budgetStore` отсутствует (не инжектирован)** → tool работает, просто без `_meta.budget`
  (деградация видимости, не отказ функции).
- **Env — все три ключа опциональны, `emptyAsUndefined`:**
  `NANSEN_API_KEY: emptyAsUndefined(z.string().optional())`,
  `NANSEN_DAILY_CREDIT_CAP: emptyAsUndefined(z.coerce.number().int().positive().optional())`,
  `NANSEN_BUDGET_WARN_RATIO: emptyAsUndefined(z.coerce.number().min(0).max(1).optional())`.
  **`EnvSchema.parse({})` обязан по-прежнему не бросать** (R-23-инвариант M1).
- **`.env.example`:** строка `#NANSEN_API_KEY=` переезжает в раздел «код читает сейчас» с
  комментарием (a) заголовок `apiKey`, **не** `Authorization: Bearer`; (b) вызовы платные, режутся
  budget-guard'ом; (c) без ключа три M2-tool'а отдают `isError`, остальной движок работает.
  Рядом — два новых опциональных ключа с пояснением, что cap может только **сузить** живой потолок.
- **`interfaces.md` §5.3** уже содержит строку `nansen` — задача **сверяет** её с кодом
  (`api.nansen.ai`, `apiKey`-заголовок, REST POST кроме `GET /account`) и правит **только** при
  расхождении. Никакой другой правки доков в этой задаче.
- **`tools/list` === 8** (`ping` + 4 M1 + 3 M2) — обновить spawn-e2e.

## Phase 1 — контракты и стабы `[STUB CREATION]`

1. Три `tools/*.ts` — zod in/out + `registerXTool` + хендлер-стаб, возвращающий фиксированный
   `{ok:false, reason:'not implemented'}`.
2. `budget-meta.ts` — сигнатура + стаб (`undefined`).
3. `server.ts`/`index.ts` — регистрация + проброс `budgetStore`.
4. `env.ts` — три ключа.
5. e2e/unit red; spawn-e2e ожидает 8 tools.
6. **Verification Phase 1:**

```bash
pnpm --filter @onchain-intel/mcp-server exec tsc --noEmit
pnpm --filter @onchain-intel/mcp-server exec vitest run test/env.test.ts   # parse({}) не бросает
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Хендлеры: нормализация входа → `resolveCapability(registry, cap, chain, args)` → валидация
   выхода своей zod-схемой (`safeParse`, не `parse`) → `_meta.cache` + `_meta.budget`.
2. `budgetMeta()` — `getUsage` только при `status==='miss'`, ошибки чтения → `undefined`
   (видимость не должна ронять ответ).
3. e2e через инжектированный fixture-registry + fake `BudgetStore`.
4. Обновить `.env.example` и сверить `interfaces.md` §5.3.

## Test Cases

1. **TC-E2E-01 (R-41):** `onchain_smart_money_flows` на фикстуре → валидный `SmartMoneyFlow`,
   `_meta.cache.status === 'miss'`, `_meta.budget.creditsUsedToday === 10`.
2. **TC-E2E-02 (R-41, кеш-хит):** повторный вызов в TTL → `status === 'hit'` **и `_meta.budget`
   отсутствует целиком** (кеш-хит бюджет не тратит — UC-5).
3. **TC-UNIT-03 (R-41, input):** невалидный адрес / чужой chain / лишнее поле (`.strict()`) →
   валидация отвергает **до** резолва.
4. **TC-E2E-04 (R-42, дефолт 0cr):** только `query` → `entities[]`, `costOf` = 0,
   `_meta.budget.creditsUsedToday` не вырос.
5. **TC-E2E-05 (R-42, token-scoped 5cr):** `tokenAddress` без `exhaustive` → метки из `tgm/holders`.
6. **TC-UNIT-06 (R-42, superRefine):** ни `query`, ни `tokenAddress` → отказ; `exhaustive:true` без
   `tokenAddress` → отказ.
7. **TC-E2E-07 (R-42, эскалация отказана):** `exhaustive:true` при остатке <100 → `isError:true` с
   причиной про бюджет, **0 сетевых вызовов** (тот же реальный отказ-кейс, что R-37(b)).
8. **TC-E2E-08 (R-42, пустой результат):** адрес без меток → **успех** с пустым массивом, не ошибка.
9. **TC-E2E-09 (R-43):** `onchain_token_risk` → `TokenRiskScore` с раздельными группами;
   `_meta.budget.creditsUsedToday === 6`.
10. **TC-UNIT-10 (R-43, не Dune):** grep-гейт — ни один из трёх tool-файлов не импортирует
    `dune`-адаптер; `dune.isAvailable()` по-прежнему безусловно `false`.
11. **TC-E2E-11 (isError-путь):** без `NANSEN_API_KEY` все три tool'а → `isError:true`, причина
    называет ключ, значение ключа не фигурирует.
12. **TC-UNIT-12 (R-46):** `EnvSchema.parse({})` не бросает; `NANSEN_DAILY_CREDIT_CAP: ''` ≡ не задан;
    `NANSEN_BUDGET_WARN_RATIO: '1.5'` → ошибка валидации, называющая **только** ключ, не значение.
13. **TC-E2E-13:** `tools/list` возвращает **8** имён.
14. **TC-UNIT-14 (`_meta.budget` без стора):** `budgetStore` не инжектирован → tool отвечает
    нормально, `_meta.budget` отсутствует.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/mcp-server exec vitest run test/tools/smart-money-flows.test.ts
pnpm --filter @onchain-intel/mcp-server exec vitest run test/tools/entity-label.test.ts
pnpm --filter @onchain-intel/mcp-server exec vitest run test/tools/token-risk.test.ts
pnpm --filter @onchain-intel/mcp-server exec vitest run test/e2e.inprocess.test.ts
pnpm --filter @onchain-intel/mcp-server test
pnpm test                                   # оба пакета
# R-46: env + .env.example синхронны:
grep -nE "NANSEN_(API_KEY|DAILY_CREDIT_CAP|BUDGET_WARN_RATIO)" packages/mcp-server/src/env.ts
grep -nE "^#?NANSEN_" .env.example
grep -n "M2+ — ЗАРЕЗЕРВИРОВАНО" -A 12 .env.example | grep -c "NANSEN_API_KEY"   # === 0 (переехал)
# R-43: не Dune:
grep -rniE "dune" packages/mcp-server/src/tools/token-risk.ts && echo "REVIEW: dune referenced" || echo "not-dune-ok"
# tools/list === 8:
grep -nE "toolNames|tools/list" packages/mcp-server/test/e2e.stdio.test.ts | head
```

- **[R-41]** tool + zod in/out + `_meta.budget` на miss / отсутствует на hit + contract/E2E + isError-путь.
- **[R-42]** трёхуровневая цена, составной `superRefine`, opt-in эскалация (реально отказывающая на
  free), пустой результат — валиден.
- **[R-43]** risk/reward раздельно, источник — Nansen, не Dune.
- **[R-46]** три опциональных ключа в `EnvSchema` (`parse({})` не бросает), `.env.example` обновлён,
  `interfaces.md` §5.3 сверена с кодом.

## Notes

> **0 живых вызовов.** E2E работают на инжектированном fixture-registry — тот же механизм, что M1
> (`e2e.inprocess.test.ts`), не глобальный мок `fetch`.
