# Задача 006-6 — `ChainSchema`/`ChainInputSchema` + миграция семи схем инструментов

| Поле               | Значение     |
| ------------------ | ------------ |
| **RTM**            | R-50, R-59   |
| **Зависимости**    | 006-1, 006-3 |
| **Блокирует**      | 006-7        |
| **Платный расход** | 0            |

## Источники

- [system-architecture.md](../architectures/system-architecture.md) §3.2 — две схемы, обоснование разделения
- [interfaces.md](../architectures/interfaces.md) §5.1.3 — контракт параметра `chain`, тексты ошибок
- [data-model.md](../architectures/data-model.md) §4.2.2 — влияние на ключ кеша
- [TASK.md](../TASK.md) UC-1, UC-6, R-50, R-59

## Цель

Убрать литерал `z.enum(['ethereum','solana'])` из семи схем инструментов и заменить канонический
`ChainSchema` на пару схем. Экономия — ≈8.7k токенов схемы в каждом запросе к модели.

## Контекст: файлы

| Файл                                                 | Действие                                 |
| ---------------------------------------------------- | ---------------------------------------- |
| `packages/core/src/types/chain.ts`                   | **переписать** — две схемы вместо enum'а |
| `packages/mcp-server/src/tools/get-token.ts`         | `chain:` → `ChainInputSchema`            |
| `packages/mcp-server/src/tools/wallet-balances.ts`   | то же                                    |
| `packages/mcp-server/src/tools/new-pairs.ts`         | то же                                    |
| `packages/mcp-server/src/tools/protocol-tvl.ts`      | то же                                    |
| `packages/mcp-server/src/tools/smart-money-flows.ts` | то же                                    |
| `packages/mcp-server/src/tools/entity-label.ts`      | то же                                    |
| `packages/mcp-server/src/tools/token-risk.ts`        | то же                                    |
| `packages/core/test/chain-schema.test.ts`            | **создать**                              |
| `packages/mcp-server/test/chain-input.test.ts`       | **создать**                              |

## Контракт (буквально из system-architecture.md §3.2)

```ts
// Канонический — ВНУТРИ доменных типов. Ничего не резолвит.
export const ChainSchema = z.string().refine(isKnownCaip2, {...}).brand<'Caip2'>();
export type Chain = z.infer<typeof ChainSchema>;

// Входной — ТОЛЬКО в схемах инструментов. Резолвит алиас → canonical.
export const ChainInputSchema = z.string().min(1).transform(resolveChainOrIssue);
```

**Почему две, а не одна:** одна схема на оба конца пропустила бы алиас в тело канонического
объекта, оттуда в `deriveArgsHash` — и `"ethereum"` с `"eip155:1"` дали бы **две** записи кеша на
один логический запрос. На платных маршрутах это два списания вместо одного.

## Phase 1 — схемы + стабы `[STUB CREATION]`

1. Ввести обе схемы в `types/chain.ts`. `ChainInputSchema` на этом этапе принимает **только**
   `ethereum`/`solana` (через реестр, но набор тот же) — поведение движка не меняется.
2. Мигрировать все 7 инструментов на `ChainInputSchema`.
3. Гейт Phase 1: 492 теста зелёные; `grep` по `z.enum(['ethereum'` в `mcp-server` даёт ноль.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Снять искусственное ограничение: `ChainInputSchema` принимает любую сеть из реестра.
2. **Канонизация до хеширования.** Убедиться, что в `args`, попадающие в `deriveArgsHash`,
   уходит `caip2`, а не пользовательская строка. Это тест, а не ревью глазами.
3. **Ошибка неизвестной сети** (R-50c) — tool-error, ноль сетевых вызовов:
   `unknown chain 'beara'. Did you mean: berachain? Call onchain_list_chains to browse N chains.`
4. `superRefine` адреса вызывает валидацию по `family` (006-3), не по имени сети.
5. Сохранить существующую length-guard дисциплину: `address.max(64)`, ранний выход до дорогого
   `bs58.decode` (адверсариальный цикл 2 M1 — не регрессировать).

## Test Cases

| #   | Проверка                                                                         |
| --- | -------------------------------------------------------------------------------- |
| 1   | `chain: "ethereum"` и `chain: "eip155:1"` → **идентичный** `args_hash`           |
| 2   | `chain: "berachain"` принимается всеми 7 инструментами на уровне схемы           |
| 3   | Неизвестная сеть → tool-error с кандидатами, `isError: true`, процесс жив        |
| 4   | Неизвестная сеть → **ноль** сетевых вызовов (глобальный `fetch` бросает)         |
| 5   | Канонический `Token.chain` содержит `caip2`, не алиас                            |
| 6   | Все существующие M1/M2 tool-тесты зелёные без правки ожиданий                    |
| 7   | `address.max(64)` и ранний выход сохранены (регрессия цикла 2)                   |
| 8   | Размер JSON-схемы инструмента не зависит от числа сетей в реестре (снимок схемы) |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/chain-schema.test.ts
pnpm --filter @onchain-intel/mcp-server test
pnpm --filter @onchain-intel/core test
pnpm typecheck
# R-50a: литерала не осталось нигде
grep -rn "z.enum(\['ethereum'" packages/ && echo "REVIEW: chain enum literal survives" || echo "enum-removed-ok"
# R-50b: обе схемы существуют и различаются
grep -nE "export const (ChainSchema|ChainInputSchema)" packages/core/src/types/chain.ts
# R-59: канонизация происходит до построения ключа кеша
grep -rnE "deriveArgsHash" packages/core/src | head
# R-50d: схема не растёт с числом сетей — снимок размера
pnpm --filter @onchain-intel/mcp-server exec vitest run test/chain-input.test.ts
```

- **[R-50]** Две схемы; ноль литералов; ошибка с кандидатами без сети; схема не растёт.
- **[R-59]** Алиасы бессрочны; форма ответов не изменена; канонизация до хеширования.

## Notes

> **Самый вероятный дефект этой задачи** — `ChainInputSchema`, случайно применённая внутри
> доменного типа (или `ChainSchema`, применённая на входе). Первый вариант тихо ломает кеш-ключ,
> второй — ломает совместимость. Тест №1 и №5 существуют именно для этого; не удалять их как
> «очевидные».

> Разовая холодная инвалидация кеша (OQ-3, подтверждён владельцем) наступает именно здесь —
> ключ начинает считаться от `caip2`. Объявление в changelog делает 006-10.
