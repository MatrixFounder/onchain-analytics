# Задача 006-7 — `onchain_list_chains` + capability `chain.tvl` / `onchain_chain_tvl`

| Поле               | Значение              |
| ------------------ | --------------------- |
| **RTM**            | R-52, R-53            |
| **Зависимости**    | 006-4, 006-5, 006-6   |
| **Блокирует**      | 006-10                |
| **Платный расход** | 0 (DeFiLlama keyless) |

## Источники

- [interfaces.md](../architectures/interfaces.md) §5.1.3 — контракты обоих инструментов
- [data-model.md](../architectures/data-model.md) §4.1 rule 3 (`tvlUsdAtRegistrySync`)
- [TASK.md](../TASK.md) UC-1, UC-2, R-52, R-53; OQ-4 (ряды — вне скоупа)

## Цель

Дать агенту (а) способ узнать допустимые значения `chain` — компенсацию за открытую строку вместо
енума, и (б) ответ на исходный вопрос владельца «какой TVL у сети».

## Контекст: файлы

| Файл                                                         | Действие                          |
| ------------------------------------------------------------ | --------------------------------- |
| `packages/mcp-server/src/tools/list-chains.ts`               | **создать**                       |
| `packages/mcp-server/src/tools/chain-tvl.ts`                 | **создать**                       |
| `packages/core/src/adapters/defillama/index.ts`              | добавить capability `chain.tvl`   |
| `packages/core/src/providers.config.ts`                      | маршрут `chain.tvl` → `defillama` |
| `packages/core/src/cache/ttl.ts` (или где живёт TTL-таблица) | TTL для `chain.tvl`               |
| `packages/mcp-server/src/server.ts`                          | регистрация двух инструментов     |
| тесты обоих пакетов                                          | **создать**                       |

## Контракты (буквально из interfaces.md §5.1.3)

```jsonc
// onchain_list_chains — ноль сетевых вызовов
// { query?, family?, capability?, minTvlUsd?, limit? (default 50, max 200) }
// → { chains: [{slug, caip2, name, family, nativeSymbol, capabilities[],
//               tvlUsdAtRegistrySync, deprecated}],
//     total, registrySyncedAt }
// onchain_chain_tvl — DeFiLlama /v2/chains
// { chain: ChainInput } → { chain, name, tvlUsd, source: "defillama", fetchedAt }
```

## Phase 1 — структура + стабы `[STUB CREATION]`

1. Оба инструмента зарегистрированы, схемы объявлены; `list_chains` возвращает
   `{chains: [], total: 0, registrySyncedAt: 0}`, `chain_tvl` — фиксированный объект-заглушку.
2. `chain.tvl` появляется в `capabilities()` DeFiLlama и в `routes`; `fetch` — стаб.
3. E2E-тесты на стабах: инструменты видны в `tools/list`, вызываются, возвращают валидную по
   схеме форму.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

### `onchain_list_chains`

1. Фильтры поверх `registry.list()` + `capabilitiesFor(chain)` из матрицы (006-4).
2. **`limit` с дефолтом и `total` обязательны.** Без них `{}` вывалил бы 461 строку — инструмент,
   созданный экономить 8.7k токенов схемы, потратил бы больше при первом вызове.
3. `total` считается **до** применения `limit` — агент видит, что список урезан.
4. Поле в выдаче называется **`tvlUsdAtRegistrySync`**, не `tvlUsd` — оно заведомо устаревшее и
   не является ответом на вопрос о TVL (data-model.md §4.1 rule 3).
5. Ноль сетевых вызовов: инструмент не ходит в `CapabilityRegistry.resolve()` вообще.

### `chain.tvl` + `onchain_chain_tvl`

1. Адаптер: `GET https://api.llama.fi/v2/chains` → выбор записи по `chain.vendors.defillama`.
2. `normalize()`: **отказ до записи в кеш** на non-finite/отрицательном `tvlUsd` — тот же приём,
   что уже реализован для `protocol.tvl` (`defillama/index.ts` finding 1b M1). Форма результата
   следует прецеденту `ProtocolTvlResult` (`tvlUsd: number`), **не** `value_raw`-дисциплине:
   она предписана для точных целых сверх 2^53, а TVL в USD изначально приблизителен.
3. Хендлер использует `safeParse` (не `parse`) на ответе провайдера — контракт M1 цикла 2.
4. TTL — соразмерный частоте обновления `/v2/chains`; выбранное значение обосновать в коде.

## Test Cases

| #   | Проверка                                                                                  |
| --- | ----------------------------------------------------------------------------------------- |
| 1   | `list_chains({})` → урезано до дефолтного `limit`, `total` отражает полное число          |
| 2   | `list_chains({capability:'chain.tvl'})` → ровно покрытые сети (сверка с матрицей)         |
| 3   | `list_chains` не делает сетевых вызовов (глобальный `fetch` бросает)                      |
| 4   | `list_chains({query:'bera'})` находит по slug, имени и алиасу                             |
| 5   | Поле выдачи называется `tvlUsdAtRegistrySync` (не `tvlUsd`) — снимок схемы                |
| 6   | `chain_tvl('berachain')` → число; повторный вызов — cache hit, `_meta.cache.status='hit'` |
| 7   | Фикстура с `tvlUsd: -1` / `NaN` / `Infinity` → отказ, запись в кеш **не** создана         |
| 8   | `chain_tvl` на непокрытой сети → `CapabilityNotCoveredOnChainError`, не сетевая ошибка    |
| 9   | Контракт `onchain_protocol_tvl` не изменён (регрессия)                                    |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/mcp-server test
pnpm --filter @onchain-intel/core test
pnpm typecheck
# R-52b: discovery не ходит в сеть
grep -nE "resolve\(|fetch\(" packages/mcp-server/src/tools/list-chains.ts && echo "REVIEW: network in list_chains" || echo "offline-ok"
# R-52c: дефолтный limit и total присутствуют в схеме/выдаче
grep -nE "default\(|total" packages/mcp-server/src/tools/list-chains.ts
# R-53c: защита от мусорного значения ДО кеша
grep -nE "Number.isFinite" packages/core/src/adapters/defillama/index.ts
# R-53b: два разных контракта, не перегрузка одного
grep -nE "chain\.tvl|protocol\.tvl" packages/core/src/providers.config.ts
# data-model §4.1 rule 3: устаревший TVL не маскируется под живой
grep -rn "tvlUsdAtRegistrySync" packages/mcp-server/src/tools/list-chains.ts
```

- **[R-52]** Фильтры, ноль сети, дефолтный `limit` + `total`, поиск по алиасам.
- **[R-53]** Отдельная capability и отдельный контракт; отказ на мусорном значении до кеша.

## Notes

> **Не объединять с `onchain_protocol_tvl`.** У протокола есть `totalTvlUsd` поверх всех сетей, у
> сети такого понятия нет; параметр-переключатель менял бы смысл остальных полей — худшая форма
> перегрузки контракта.

> **OQ-4 закрыт:** только текущее значение. Историю `/v2/historicalChainTvl` не подключать, даже
> если она рядом и выглядит дешёвой — это отдельный выходной контракт и отдельная задача.
