# Задача 006-1 — Реестр сетей: тип, загрузчик, валидация, стаб-данные

| Поле               | Значение                          |
| ------------------ | --------------------------------- |
| **RTM**            | R-48, R-60                        |
| **Зависимости**    | нет — первая задача               |
| **Блокирует**      | 006-2, 006-3, 006-4, 006-5, 006-6 |
| **Платный расход** | 0                                 |

## Источники

- [ARCHITECTURE](../ARCHITECTURE.md) → [data-model.md](../architectures/data-model.md) §4.1
  (`ChainInfo`, business rules), §4.2.1 (почему артефакт сборки)
- [system-architecture.md](../architectures/system-architecture.md) §3.2 «Модуль `src/chain/registry.ts`»
- [TASK.md](../TASK.md) UC-1, UC-5, R-48, R-60

## Цель

Создать единственный источник фактов о сетях: типы, загрузчик с валидацией на старте и резолвер
с «did you mean». **Тип `ChainInfo` после этой задачи замораживается** — если последующие задачи
захотят его изменить, это сигнал вернуться в Architecture, а не править по месту.

Боевых данных здесь **нет** — только стаб на 3 сети. Полные 461 приходят в 006-2.

## Контекст: файлы

| Файл                                         | Действие                                                  |
| -------------------------------------------- | --------------------------------------------------------- |
| `packages/core/src/chain/registry.ts`        | **создать**                                               |
| `packages/core/src/chain/registry.data.json` | **создать** (стаб, 3 сети)                                |
| `packages/core/src/chain/errors.ts`          | **создать** — `UnknownChainError`                         |
| `packages/core/src/index.ts`                 | реэкспорт `ChainInfo`/`ChainRegistry`/`loadChainRegistry` |
| `packages/core/test/chain-registry.test.ts`  | **создать**                                               |
| `packages/core/.AGENTS.md`                   | обновляет Developer                                       |

## Интерфейс (буквально из system-architecture.md §3.2)

```ts
export interface ChainInfo {
  caip2: string;
  slug: string;
  name: string;
  family: 'evm' | 'svm' | 'move' | 'cosmos' | 'utxo' | 'other';
  aliases: readonly string[];
  nativeSymbol: string | null;
  vendors: Readonly<Record<string, string | null>>;
  rpcHosts: readonly string[] | null;
  tvlUsdAtSync: number | null;
  deprecated: boolean;
}

export interface ChainRegistry {
  resolve(input: string): ChainInfo;
  tryResolve(input: string): ChainInfo | null;
  get(caip2: string): ChainInfo | null;
  list(filter?: ChainListFilter): ChainInfo[];
  size(): number;
}

export function loadChainRegistry(deps?: { data?: unknown }): ChainRegistry;
```

## Phase 1 — структура + стабы `[STUB CREATION]`

1. Создать `registry.ts` с типами выше; `loadChainRegistry` возвращает объект, где `resolve`
   бросает `UnknownChainError` всегда, `list` возвращает `[]`, `size()` возвращает `0`.
2. Создать `registry.data.json` — ровно 3 записи: `eip155:1` (`ethereum`), `solana:5eykt4…`
   (`solana`), плюс запись для `dash` (`family: 'other'`, `vendors` все `null`).
   `ethereum` и `solana` обязаны присутствовать **в `aliases`**, а не только в `slug` — это
   контракт R-59.
3. E2E-тест на стабах: модуль импортируется, `loadChainRegistry()` не бросает, `size() === 0`.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. **Индексы при загрузке:** три `Map` — по `caip2`, `slug`, `alias`. Строятся один раз.
2. **Порядок резолва:** точный `caip2` → `slug` → `alias` → нормализованная форма
   (lowercase + удаление `[^a-z0-9]`). Первое совпадение выигрывает.
3. **Валидация на старте** — бросить при любом из нарушений:
   - дубль `caip2` или `slug`;
   - алиас, совпадающий с чужим `slug` или чужим алиасом (глобальная непересекаемость);
   - `caip2` не соответствует форме `<namespace>:<reference>`;
   - пустой `name`/`slug`.
4. **Деградация в пустой реестр запрещена:** отсутствующие/невалидные данные → исключение.
   Тихий пустой реестр превратил бы каждый запрос в «unknown chain», выглядя как штатная работа.
5. **`UnknownChainError`** несёт `input` и `candidates: string[]` — до 3 ближайших по
   расстоянию Левенштейна над `slug ∪ aliases`. Вычисление кандидатов происходит **только** в
   момент ошибки (O(n) не на горячем пути).
6. **`list(filter)`** — фильтры `query` / `family` / `deprecated`; фильтр по capability здесь
   **не реализуется** (нужна матрица покрытия — 006-4).

## Test Cases

| #   | Проверка                                                                                       |
| --- | ---------------------------------------------------------------------------------------------- |
| 1   | `resolve('ethereum')`, `resolve('eip155:1')`, `resolve('Ethereum')` → один и тот же `caip2`    |
| 2   | `resolve('beara')` → `UnknownChainError`, `candidates` непуст                                  |
| 3   | Резолв не делает сетевых вызовов (глобальный `fetch` подменён на бросающий)                    |
| 4   | Дубль `caip2` в данных → загрузка бросает                                                      |
| 5   | Алиас, равный чужому `slug` → загрузка бросает                                                 |
| 6   | Битый `caip2` (без `:`) → загрузка бросает                                                     |
| 7   | `loadChainRegistry({data: undefined})` при отсутствующем файле → бросает, **не** пустой реестр |
| 8   | `deps.data` инъекция: синтетический реестр из 2 сетей работает без файловой системы            |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/chain-registry.test.ts
pnpm --filter @onchain-intel/core test
pnpm typecheck
# R-48: реестр — фабрика, не модульный синглтон (нет экспортируемого готового инстанса):
grep -nE "^export const (chainRegistry|registry)\s*=" packages/core/src/chain/registry.ts && echo "REVIEW: module singleton" || echo "factory-ok"
# R-60: ни одного сетевого примитива в модуле реестра:
grep -nE "\bfetch\(|https?://|node:http" packages/core/src/chain/registry.ts && echo "REVIEW: network in registry" || echo "no-network-ok"
# R-59: legacy-имена присутствуют именно как алиасы:
grep -nE '"aliases"' -A 3 packages/core/src/chain/registry.data.json | grep -E '"ethereum"|"solana"'
```

- **[R-48]** Типы + резолвер + индексы; фабрика с DI; «did you mean» на промахе.
- **[R-60]** Валидация на старте; громкое падение; запрет пустого реестра.

## Notes

> Генератор, боевые данные, `chainSupport()`, матрица покрытия, схемы инструментов — **не здесь**.
> Эта задача даёт только фундамент. Соблазн «заодно подтянуть 461 сеть» надо гасить: вся отладка
> резолва должна идти на 3-строчном детерминированном наборе.

> `tvlUsdAtSync` присутствует в типе, но в стаб-данных равен `null` — заполняется генератором.
> Правило data-model.md §4.1 rule 3 («никогда не ответ на вопрос о TVL») здесь ещё не проверяется
> тестом — его гейт живёт в 006-7 вместе с `onchain_list_chains`.
