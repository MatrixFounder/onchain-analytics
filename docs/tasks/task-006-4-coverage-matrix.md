# Задача 006-4 — Матрица покрытия, `chainSupport()`, новый тип ошибки, порядок гейтов

| Поле               | Значение            |
| ------------------ | ------------------- |
| **RTM**            | R-51                |
| **Зависимости**    | 006-1               |
| **Блокирует**      | 006-5, 006-7, 006-9 |
| **Платный расход** | 0                   |

## Источники

- [data-model.md](../architectures/data-model.md) §4.2.3 (формула, таблица предикатов, два типа отказа)
- [system-architecture.md](../architectures/system-architecture.md) §3.2 «Модуль `src/chain/coverage.ts`» + порядок гейтов 1→6
- [TASK.md](../TASK.md) UC-3, R-51

## Цель

Сделать покрытие пары (capability, chain) **вычислимым**, а не хранимым, и поставить его отказ
**выше** резервирования кредитов.

## Контекст: файлы

| Файл                                             | Действие                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| `packages/core/src/chain/coverage.ts`            | **создать**                                         |
| `packages/core/src/chain/errors.ts`              | добавить `CapabilityNotCoveredOnChainError`         |
| `packages/core/src/adapters/types.ts`            | добавить `chainSupport?(chain: ChainInfo): boolean` |
| `packages/core/src/adapters/registry.ts`         | встроить гейт в `resolve()`                         |
| `packages/core/test/coverage.test.ts`            | **создать**                                         |
| `packages/core/test/registry.gate-order.test.ts` | **создать**                                         |

## Формула (буквально из data-model.md §4.2.3)

```
covered(capability, chain) :=
    ∃ adapterId ∈ route(capability).adapterIds :
        adapter(adapterId).chainSupport(chainInfo) === true
```

Адаптер, не реализующий `chainSupport`, считается не привязанным к сети — поведение как сейчас.

## Порядок гейтов в `CapabilityRegistry.resolve()` — обязателен

```
1. резолв chain по реестру         (нет сети, нет денег)
2. проверка покрытия пары           (нет сети, нет денег)   ← ДОБАВЛЯЕТСЯ ЗДЕСЬ
3. cache lookup                     (нет сети, нет денег)
4. adapter.isAvailable()            (нет сети, нет денег)
5. budget-gate: check + reserve     (деньги резервируются)
6. adapter.fetch()                  (сеть, деньги тратятся)
```

Пункт 2 **обязан** стоять выше пункта 5. Иначе рост множества сетей с 2 до 461 превращается в
вектор расхода денег: каждый промах мимо покрытия стоил бы резервации кредитов.

## Phase 1 — интерфейс + стаб `[STUB CREATION]`

1. `chainSupport?` добавлен в `ProviderAdapter` как **опциональный** — ни один существующий
   адаптер пока его не реализует, сборка и все 492 теста остаются зелёными.
2. `coverage.ts` — `isCovered()` возвращает `true` всегда (стаб), `chainsFor(capability)` и
   `capabilitiesFor(chain)` возвращают `[]`.
3. `CapabilityNotCoveredOnChainError` создан, но пока не бросается.
4. E2E-тест на стабах: `resolve()` ведёт себя ровно как до задачи.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Реализовать формулу над `routes` (`providers.config.ts`) × картой адаптеров.
2. `chainsFor(capability)` / `capabilitiesFor(chain)` — обе выборки из **тех же** двух источников,
   что и сам предикат: списки в тексте ошибки не могут разойтись с поведением.
3. Встроить гейт в `resolve()` строго на позицию 2.
4. **Текст ошибки** несёт: непокрытую пару, список сетей для capability, список capability для
   сети. Списки урезаются (напр. до 10) с указанием остатка — иначе ошибка сама раздувает контекст.
5. **Разделение типов отказа — это контракт, а не косметика:**

| Ситуация             | Тип                                               | Что делает агент                    |
| -------------------- | ------------------------------------------------- | ----------------------------------- |
| Пара не покрыта      | `CapabilityNotCoveredOnChainError`                | ищет альтернативу, **не** повторяет |
| Провайдер недоступен | `CapabilityUnavailableError` (R-24, существующий) | чинит конфиг / повторяет позже      |

## Test Cases

| #   | Проверка                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------- |
| 1   | Непокрытая пара → `CapabilityNotCoveredOnChainError`, **не** `CapabilityUnavailableError`                |
| 2   | Текст ошибки содержит оба списка и оба непусты                                                           |
| 3   | **Гейт выше денег:** непокрытая платная пара не доходит до `nansen.fetch()` и **не** инкрементит `usage` |
| 4   | Гейт выше кеша: непокрытая пара не создаёт запись в `cache_entries`                                      |
| 5   | Покрытая пара с недоступным провайдером по-прежнему даёт `CapabilityUnavailableError`                    |
| 6   | Адаптер без `chainSupport` ведёт себя как до задачи (регрессия M1)                                       |
| 7   | `chainsFor`/`capabilitiesFor` согласованы с `isCovered` на случайной выборке пар                         |
| 8   | Длинные списки в тексте ошибки урезаются и сообщают остаток                                              |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/coverage.test.ts test/registry.gate-order.test.ts
pnpm --filter @onchain-intel/core test
pnpm --filter @onchain-intel/mcp-server test
# R-51a: покрытие нигде не хранится списком — только вычисляется
grep -nE "COVERAGE_(MATRIX|TABLE)|coveredChains\s*[:=]\s*\[" packages/core/src && echo "REVIEW: coverage stored as list" || echo "derived-ok"
# R-51b: два типа ошибки существуют раздельно
grep -nE "class CapabilityNotCoveredOnChainError" packages/core/src/chain/errors.ts
grep -nE "class CapabilityUnavailableError" packages/core/src
# R-51d: гейт покрытия расположен ДО budget/fetch в resolve()
grep -nE "isCovered|NotCoveredOnChain" packages/core/src/adapters/registry.ts
```

- **[R-51]** Производная матрица; отдельный тип ошибки; оба списка в тексте; отказ до
  резервирования кредитов и до сети.

## Notes

> **Почему предикат, а не колонка:** колонка потребовала бы держать покрытие в двух местах
> (реестр + `capabilities()`), и первое же изменение их рассинхронизировало бы. Предикат оставляет
> реестр источником фактов о сети, а адаптер — источником фактов о себе.

> Сами предикаты адаптеров реализуются в **006-5**, здесь только интерфейс и движок матрицы.
> Пункт 3 Test Cases до 006-5 проверяется на **синтетическом** адаптере — не откладывать его до
> 006-5: это денежный гейт, он должен быть зелёным с момента появления матрицы.
