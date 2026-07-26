# Задача 006-2 — Генератор реестра из вендорских каталогов + боевые данные

| Поле               | Значение                             |
| ------------------ | ------------------------------------ |
| **RTM**            | R-49                                 |
| **Зависимости**    | 006-1 (схема `ChainInfo` заморожена) |
| **Блокирует**      | 006-8                                |
| **Платный расход** | 0 (все три источника keyless)        |

## Источники

- [system-architecture.md](../architectures/system-architecture.md) §3.2 «Модуль `scripts/sync-chain-registry.ts`»
- [data-model.md](../architectures/data-model.md) §4.2.1 (почему не рантайм)
- Живая evidence: [raw/chain-registry-probe-2026-07-26.json](../onchain-analytics/raw/chain-registry-probe-2026-07-26.json)
- [TASK.md](../TASK.md) UC-4, R-49

## Цель

Dev-скрипт, превращающий три вендорских каталога в один детерминированный `registry.data.json`,
и сам этот файл на 461 сеть. Скрипт **не входит в рантайм-сборку** и не импортируется из `src/`.

## Контекст: файлы

| Файл                                                | Действие                                       |
| --------------------------------------------------- | ---------------------------------------------- |
| `packages/core/scripts/sync-chain-registry.ts`      | **создать**                                    |
| `packages/core/src/chain/registry.data.json`        | **перезаписать** боевыми данными (было 3 сети) |
| `packages/core/test/registry-generator.test.ts`     | **создать**                                    |
| `packages/core/test/fixtures/chain-registry/*.json` | **создать** — срезы трёх каталогов             |
| `packages/core/package.json`                        | скрипт `sync:chains`                           |

## Источники и ключи join'а (проверено живой пробой 2026-07-26)

| Источник                                                 | Даёт                               | Ключ                                         |
| -------------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `https://api.llama.fi/v2/chains` (461)                   | `name`, `tvlUsdAtSync`, `gecko_id` | базовый список                               |
| `https://api.coingecko.com/api/v3/asset_platforms` (461) | `coingecko` id, `chain_identifier` | `gecko_id` → `native_coin_id` (**235**)      |
| `https://chainid.network/chains_mini.json` (2660)        | `nativeCurrency`, кандидаты RPC    | `chain_identifier` → `chainId` (**257/270**) |

**`caip2` строится так:** есть `chain_identifier` → `eip155:<id>`, `family: 'evm'`. Нет —
namespace по известному справочнику (`solana:…`, `bip122:…`, `cosmos:…`), иначе `other:<slug>`
с пометкой для ручного ревью.

## Phase 1 — структура + стаб `[STUB CREATION]`

1. Создать скрипт со структурой `fetchCatalogs() → join() → validate() → writeSnapshot() → report()`,
   где `fetchCatalogs` читает **локальные фикстуры** (не сеть), а остальные шаги — сквозной проход.
2. Прогон на фикстурах даёт файл из 2–3 сетей и печатает пустой дифф-отчёт.
3. Тест: прогон на фикстурах не бросает, результат проходит `loadChainRegistry()` из 006-1.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. **Реальный сетевой слой** — только внутри скрипта, `--offline` читает фикстуры.
2. **Join по явным ключам**, имя — только fallback; каждая фаззи-склейка попадает в отдельную
   секцию отчёта. Молчаливая склейка запрещена: она проявится позже как «TVL не той сети», и
   найти её будет уже нечем.
3. **Конфликт join'а** (один `gecko_id` на две сети) → строка в отчёт, **не** в снапшот.
4. **Детерминизм:** сортировка по `caip2`, стабильный порядок ключей, никаких timestamp'ов
   внутри записей. `syncedAt` — одно поле в шапке, меняется только при реальном изменении данных.
5. **Отказ источника** → ненулевой код выхода, файл **не пишется**. Частично записанный реестр
   хуже отсутствующего: он пройдёт валидацию и молча сузит мир.
6. **Исчезнувшая сеть** → `deprecated: true`, не удаление.
7. **`rpcHosts` — НЕ заполняется здесь.** Скрипт только собирает _кандидатов_ в отчёт; сама
   колонка курируется в 006-8 (security.md §7.2.1 запрещает автозаполнение).
8. Сгенерировать боевой `registry.data.json` и закоммитить вместе с отчётом.

## Test Cases

| #   | Проверка                                                                   |
| --- | -------------------------------------------------------------------------- |
| 1   | Два прогона на одних фикстурах → **побайтово** одинаковый файл             |
| 2   | Недоступный источник (фикстура-ошибка) → ненулевой код, файл не изменён    |
| 3   | Фаззи-склейка по имени попадает в отчёт отдельной секцией                  |
| 4   | Конфликт `gecko_id` → в отчёт, не в снапшот                                |
| 5   | Сеть, исчезнувшая между прогонами, получает `deprecated: true` и остаётся  |
| 6   | Результат генератора проходит валидацию `loadChainRegistry()` (006-1)      |
| 7   | `rpcHosts` во всех сгенерированных записях — `null` (курирование не здесь) |
| 8   | Боевой файл: `resolve('berachain').caip2 === 'eip155:80094'`               |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/registry-generator.test.ts
pnpm --filter @onchain-intel/core test
# R-49: детерминизм — два прогона подряд на фикстурах
pnpm --filter @onchain-intel/core exec tsx scripts/sync-chain-registry.ts --offline --out /tmp/r1.json
pnpm --filter @onchain-intel/core exec tsx scripts/sync-chain-registry.ts --offline --out /tmp/r2.json
cmp /tmp/r1.json /tmp/r2.json && echo "deterministic-ok" || echo "REVIEW: non-deterministic output"
# R-49: рантайм не импортирует dev-скрипт
grep -rnE "from ['\"].*scripts/" packages/core/src && echo "REVIEW: src imports scripts" || echo "src-clean-ok"
# R-49: в снапшоте нет timestamp'ов внутри записей
grep -cE '"syncedAt"' packages/core/src/chain/registry.data.json   # ожидается ровно 1
# R-56 предусловие: генератор не заполняет rpcHosts
grep -nE '"rpcHosts":\s*\[' packages/core/src/chain/registry.data.json && echo "REVIEW: rpcHosts autofilled" || echo "rpcHosts-null-ok"
```

- **[R-49]** Три источника, явные ключи, детерминизм, дифф-отчёт с секцией фаззи-склеек, громкий
  отказ без записи, `deprecated` вместо удаления, изоляция от рантайма.

## Notes

> **Не заполнять `rpcHosts`.** Это единственное поле, для которого автозаполнение прямо запрещено
> архитектурой (security.md §7.2.1): allowlist, который определяет третья сторона по сети, — не
> allowlist. Кандидаты идут в отчёт для человека.

> Числа 461/235/257 — из живой пробы 2026-07-26 и **могут разойтись** к моменту исполнения
> (vendor drift, CLAUDE.md). Тесты не должны на них опираться: гейтом является детерминизм и
> корректность join'а, а не конкретное количество строк.
