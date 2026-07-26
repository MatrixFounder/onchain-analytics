# Задача 006-5 — Миграция пяти адаптеров на реестр (удаление приватных вендорских мап)

| Поле               | Значение                                                |
| ------------------ | ------------------------------------------------------- |
| **RTM**            | R-54 (Must), R-57 (Should — не гейтит приёмку)          |
| **Зависимости**    | 006-1, 006-4                                            |
| **Блокирует**      | 006-7, 006-8, 006-9                                     |
| **Платный расход** | 0 (Nansen здесь только объявляет предикат, вызовов нет) |

## Источники

- [system-architecture.md](../architectures/system-architecture.md) §3.2 — таблица удаляемых мап + `ProviderAdapter.chainSupport`
- [data-model.md](../architectures/data-model.md) §4.2.3 — таблица предикатов по адаптерам
- [TASK.md](../TASK.md) R-54, R-57

## Цель

Убрать из адаптеров их собственные копии знания о сетях. После задачи адаптер знает только «умею
ли я эту сеть» (предикат) и «как эта сеть называется у моего вендора» (чтение из реестра).

## Контекст: файлы

| Файл                                | Что удаляется                                        | Чем заменяется                                      |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `src/adapters/defillama/index.ts`   | `type SupportedChain`, `CHAIN_TVL_KEY`               | `chain.vendors.defillama`                           |
| `src/adapters/dexscreener/index.ts` | `type SupportedChain`, `NATIVE_QUERY`                | `chain.nativeSymbol` + `chain.vendors.dexscreener`  |
| `src/adapters/coingecko/index.ts`   | inline-проверка на две сети                          | `chain.vendors.coingecko`                           |
| `src/adapters/nansen/endpoints.ts`  | `type NansenChain`                                   | `chain.vendors.nansen` (покрытие — 006-9)           |
| `src/adapters/rpc-evm/index.ts`     | проверка `chain !== 'ethereum'`                      | `chain.family === 'evm' && chain.rpcHosts !== null` |
| `src/providers.config.ts`           | литералы `chains: ['ethereum','solana']` в маршрутах | покрытие считает матрица (006-4)                    |

Тесты: golden-тесты адаптеров дополняются, **существующие ожидания для `ethereum`/`solana` не
меняются** — это регрессионный гейт.

## Предикаты `chainSupport()` (буквально из data-model.md §4.2.3)

| Адаптер                                              | Предикат                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `defillama`                                          | `c.vendors.defillama !== null`                                           |
| `coingecko`                                          | `c.vendors.coingecko !== null`                                           |
| `dexscreener`                                        | `c.vendors.dexscreener !== null`                                         |
| `rpc-evm`                                            | `c.family === 'evm' && c.rpcHosts !== null`                              |
| `rpc-solana`                                         | `c.caip2 === <solana mainnet>`                                           |
| `nansen`                                             | `c.caip2 ∈ CoverageProbe('nansen').chains` — **временный стаб до 006-9** |
| `dash-platform` / `platform-explorer` / `pg-history` | `c.caip2 === <dash>`                                                     |
| `dune`                                               | без изменений (`isAvailable()` безусловно `false`)                       |

## Phase 1 — предикаты + стабы `[STUB CREATION]`

1. Каждый адаптер получает `chainSupport()`, **возвращающий прежнее поведение** (только
   `ethereum`/`solana`, для `rpc-evm` — только `ethereum`). Приватные мапы пока на месте.
2. Матрица покрытия (006-4) начинает реально работать, но результат идентичен доэтому.
3. Гейт Phase 1: все 492 теста зелёные, поведение движка не изменилось ни в одном сценарии.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Заменить предикаты на боевые (таблица выше). Удалить приватные мапы и `type SupportedChain`.
2. Вендорский ключ читается из `chain.vendors.<id>` в точке построения URL/тела запроса.
3. `providers.config.ts`: убрать литеральные `chains` там, где их теперь считает матрица.
   **Не** удалять маршруты и не менять порядок `adapterIds` — приоритет и fallback (R-11) не
   являются предметом этой задачи.
4. **Anti-corruption (R-54d) не ослабляется:** реестр отдаёт короткую строку-идентификатор и
   ничего больше; `normalize()` остаётся единственным местом сужения; направление зависимости —
   адаптер читает реестр, реестр про адаптеры не знает.
5. **[R-57, Should]** `dexscreener` берёт нативный символ из `chain.nativeSymbol`. Если у сети он
   `null` — capability считается непокрытой для неё (через предикат), а не падает.

## Test Cases

| #   | Проверка                                                                                    |
| --- | ------------------------------------------------------------------------------------------- |
| 1   | `defillama` отдаёт TVL для не-Ethereum/Solana протокола, взяв ключ из реестра               |
| 2   | `coingecko` строит URL с platform id из реестра для третьей сети                            |
| 3   | Golden-тесты M1/M2 для `ethereum`/`solana` — ожидания **не изменены**                       |
| 4   | `rpc-evm.chainSupport()` = `false` для EVM-сети с `rpcHosts: null`                          |
| 5   | Вендорский DTO не протекает наружу ни в одном адаптере (существующие anti-corruption тесты) |
| 6   | `dune.isAvailable()` по-прежнему безусловно `false`                                         |
| 7   | **[R-57]** `pairs.new` отрабатывает хотя бы на одной сети вне `ethereum`/`solana`           |
| 8   | Сеть с `nativeSymbol: null` → `dexscreener.chainSupport()` = `false`, не исключение         |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core test
pnpm --filter @onchain-intel/mcp-server test
pnpm typecheck
# R-54a/b: приватных мап и узких union'ов сети не осталось
grep -rnE "CHAIN_TVL_KEY|NATIVE_QUERY|type NansenChain|type SupportedChain" packages/core/src/adapters && echo "REVIEW: private chain map survives" || echo "maps-removed-ok"
# R-54: адаптеры больше не сравнивают chain со строковыми литералами
grep -rnE "chain (!==|===) '(ethereum|solana)'" packages/core/src/adapters && echo "REVIEW: literal chain compare" || echo "no-literal-compare-ok"
# R-54c: каждый живой адаптер объявил предикат
grep -rlE "chainSupport" packages/core/src/adapters | sort
# R-54d: направление зависимости не перевёрнуто
grep -rnE "from ['\"].*adapters/" packages/core/src/chain && echo "REVIEW: registry imports adapters" || echo "dependency-direction-ok"
```

- **[R-54]** Мапы удалены, предикаты объявлены, вендорский ключ из реестра, anti-corruption цел.
- **[R-57]** _(не гейтит)_ нативный символ из реестра; `null` → непокрыто, не падение.

## Notes

> **Порядок Phase 1 → Phase 2 здесь особенно важен.** Phase 1 доказывает, что матрица покрытия
> (006-4) встроена правильно, **не меняя наблюдаемого поведения**. Если после Phase 1 хоть один из
> 492 тестов красный — дефект в 006-4, и чинить надо там, а не подгонять предикаты.

> `nansen.chainSupport()` в Phase 2 остаётся стабом на `ethereum`/`solana` до 006-9 — расширять
> его «по спеке» здесь **нельзя**: пересечение под-вызовов ещё не реализовано, а объединение дало
> бы 8 сетей с гарантированно половинным вызовом после списания кредитов (PLAN §0.2).
