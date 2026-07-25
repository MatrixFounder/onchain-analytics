# Task 005-1 — [R-30/R-31/R-32/R-33] канонические типы M2 + регистрация `nansen` + скелет адаптера (0 сети)

| Поле                    | Значение                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                 |
| **Тип**                 | Dev (Stub-First: Phase 1 схемы-заглушки/регистрация → Phase 2 полные zod + unit-тесты) |
| **R-IDs**               | **R-30**, **R-31**, **R-32**, **R-33**                                                 |
| **Зависимости**         | нет (root M2)                                                                          |
| **Разблокирует**        | 005-2 (`nansen` в `providers` для FK), 005-4 (типы для `normalize()`)                  |
| **Источники**           | data-model §4.1 + system-architecture §3.2 — см. «Источники» ниже                      |
| **Живые кредиты**       | **0** — сети в этой задаче нет вообще                                                  |

## Источники

- [data-model.md](../architectures/data-model.md) §4.1 — три канонических типа.
- [system-architecture.md](../architectures/system-architecture.md) §3.2 «Десятый адаптер».

## Цель

Заложить всю **статическую** поверхность M2: три канонических zod-типа, 10-ю запись в реестре
адаптеров, три маршрута способностей и скелет `createNansenAdapter` — так, чтобы `pnpm typecheck`
и весь существующий сьют оставались зелёными, а ни одного сетевого/платного пути ещё не
существовало.

## Контекст: файлы

**Новые:**

- `packages/core/src/types/smart-money-flow.ts` — `SmartMoneyFlowSchema` + `type SmartMoneyFlow`.
- `packages/core/src/types/entity-label.ts` — `EntityLabelSchema` + `type EntityLabel`.
- `packages/core/src/types/token-risk-score.ts` — `TokenRiskScoreSchema` + `type TokenRiskScore`.
- `packages/core/src/adapters/nansen/index.ts` — `createNansenAdapter(deps): ProviderAdapter`
  (**единственная** публично экспортируемая фабрика пакета для этого адаптера).
- `packages/core/test/nansen.types.test.ts` — unit-тесты трёх схем.
- `packages/core/test/nansen.adapter.test.ts` — `capabilities()`/`isAvailable()`/реестр.
- `packages/core/src/adapters/nansen/.AGENTS.md` — назначение модуля (политика новых директорий).

**Правки (аддитивные, ни одна существующая логика не переписывается):**

- `packages/core/src/types/index.ts` — реэкспорт трёх новых схем/типов.
- `packages/core/src/index.ts` — реэкспорт `SmartMoneyFlowSchema`/`EntityLabelSchema`/
  `TokenRiskScoreSchema` + типы + `createNansenAdapter`/`NansenAdapterDeps`
  ([interfaces.md](../architectures/interfaces.md) §5.2).
- `packages/core/src/providers.config.ts` — 10-я запись `adapterRegistrations` + 3 `routes`.
- `packages/core/src/cache/sqlite-store.ts` — `PAID_PROVIDER_IDS` пополняется `'nansen'` рядом с
  `'dune'` (чисто информационная `providers.kind`-классификация; логика её не читает, но пропустить
  строку — молча разойтись с задокументированным инвариантом «paid providers listed here»).

## Reviewer-заметки (обязательно применить)

- **`registry.ts` НЕ редактируется** — ни здесь, ни в одной другой задаче M2. Маршрут
  `adapterIds: ['nansen']` без fallback работает уже существующим кодом.
- **Регистрация — буквально из архитектуры** (§3.2): `hosts: ['api.nansen.ai']` (только этот host —
  per-adapter SSRF-allowlist), `rateLimit: { capacity: 5, refillPerSec: 1 }` (тот же консервативный
  старт, что у 5 из 9 M1-адаптеров — заведомо ниже всех четырёх вендорских порогов),
  `requiresEnv: ['NANSEN_API_KEY']`.
- **Маршруты — `chains: ['ethereum','solana']`** (решение OQ-3): буквально то же подмножество, что
  4 M1-tool'а. Не расширять — три Nansen-энумератора чейнов не совпадают друг с другом.
- **`EntityLabel` — единственный тип, где `chain` и `address` ОБА опциональны** (`EntitySearchResult`
  не несёт ни chain, ни адреса — сущность может быть кросс-чейн). Это не небрежность, а форма
  реального ответа. `tags[]`/`labels[]` — `.default([])`, **пустой массив валиден**.
- **`TokenRiskScore`: `signal`/`signalPercentile` — `number`, не строки** (это не wei-подобные
  ончейн-целые, безопасно для JS-number/`REAL`); `score` — качественная строка (risk →
  low/medium/high, reward → bearish/neutral/bullish); `riskIndicators`/`rewardIndicators` —
  **два раздельных массива**, не один сплющенный список.
- **`SmartMoneyFlow` — четыре скользящих окна** (`netflow1hUsd`/`netflow24hUsd`/`netflow7dUsd`/
  `netflow30dUsd`), а не абстрактные `windowStart`/`windowEnd`: реальный ответ отдаёт фиксированный
  набор. `netflow24hUsd` закрывает минимальную планку R-31.
- **Anti-corruption:** ни один из трёх типов не содержит Nansen-специфичных полей/обёрток
  (`{data, pagination}` не протекает). `tokenAddress`/`address` — через существующий
  `normalizeAddress`, не сырая строка вендора.
- **Скелет адаптера:** `fetch()`/`normalize()` бросают `NotImplementedError`-подобную ошибку
  (переиспользовать существующий `adapters/not-implemented-error.ts` или добавить рядом аналог с
  сообщением про 005-4/005-5); `costOf()` временно `{ credits: Number.POSITIVE_INFINITY }` — **не
  `0`**: fail-closed с первой же строки, чтобы недоделанный адаптер физически не мог быть принят
  гейтом за бесплатный.
- **`isAvailable()`** уже здесь настоящий: `{ ok: false, reason: 'needs NANSEN_API_KEY' }` при
  отсутствии/пустом ключе (читается из инжектированного `deps.env ?? process.env` **внутри** метода,
  никогда на module-load), иначе `{ ok: true }`.

## Phase 1 — структура и стабы `[STUB CREATION]`

1. **Зафиксировать baseline (два значения):** прогнать `pnpm test` **до единой правки** и записать
   фактическое число зелёных тестов **и** `git rev-parse HEAD` (→ `BASE_SHA`) в шапку
   `docs/tasks/task-005-8-degradation-regression-exit.md`. Оба нужны 005-8: число — сверка
   «M1 не регрессировал»; `BASE_SHA` — якорь для immutability-грепов, устойчивый к mid-run коммиту
   фикстур (PLAN §0.4), в отличие от working-tree `git diff` против `HEAD`.
2. Три файла типов — пустые/минимальные zod-объекты + экспорт типов; реэкспорты.
3. `adapters/nansen/index.ts` — `createNansenAdapter` с `id`, `capabilities()`, `isAvailable()`,
   стаб-`costOf()`/`fetch()`/`normalize()`.
4. `providers.config.ts` — регистрация + 3 маршрута; `PAID_PROVIDER_IDS += 'nansen'`.
5. Тесты red.
6. **Verification Phase 1:**

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit     # 0 ошибок
pnpm --filter @onchain-intel/core test                  # существующий сьют по-прежнему зелёный
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Полные zod-схемы по [data-model.md](../architectures/data-model.md) §4.1 (поле-в-поле, включая
   опциональность и дефолты).
2. `capabilities()` → `[{id:'smart-money.flows', chains:['ethereum','solana']}, {id:'entity.labels', …},
{id:'token.risk', …}]`.
3. `isAvailable()` — реальная проверка ключа.
4. Unit-тесты: валидный/невалидный пример на каждый тип; `EntityLabel` с 0 меток и с ≥1 меткой;
   `TokenRiskScore` с раздельными группами; `isAvailable()` без ключа/с ключом; реестр строится и
   резолвит три новых `(capability, chain)` в адаптер `nansen`.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/nansen.types.test.ts    # R-31/R-32/R-33
pnpm --filter @onchain-intel/core exec vitest run test/nansen.adapter.test.ts  # R-30 + isAvailable
pnpm --filter @onchain-intel/core test                                        # весь core-сьют зелёный
pnpm --filter @onchain-intel/mcp-server test                                  # M1 не затронут
# R-30: регистрация и маршруты на месте, registry.ts не тронут:
grep -nE "id: 'nansen'|hosts: \['api\.nansen\.ai'\]" packages/core/src/providers.config.ts
grep -cE "capability: '(smart-money\.flows|entity\.labels|token\.risk)'" packages/core/src/providers.config.ts  # === 3
# registry.ts не тронут (working-tree; в этой задаче коммита ещё нет, поэтому HEAD-сравнение достаточно):
git diff --stat -- packages/core/src/adapters/registry.ts                     # пусто
# Fail-closed костОф с первой строки (стаб НЕ возвращает 0):
grep -nE "POSITIVE_INFINITY" packages/core/src/adapters/nansen/index.ts
```

- **[R-30]** 10-я регистрация + 3 маршрута `adapterIds:['nansen']`; реестр стартует без падения.
- **[R-31]** `SmartMoneyFlow` — 4 окна netflow + `topHolders[]`, DTO не протекает; unit-тест.
- **[R-32]** `EntityLabel` — `chain?`/`address?`, пустой `labels[]` валиден; unit-тест на обе формы.
- **[R-33]** `TokenRiskScore` — раздельные risk/reward, числа — `number`; unit-тест.

## Notes

> Сеть, бюджет, cost-таблица, `usage` — **не в этой задаче**. `fetch()` обязан бросать. Никакого
> `NANSEN_API_KEY` в окружении прогона тестов.
