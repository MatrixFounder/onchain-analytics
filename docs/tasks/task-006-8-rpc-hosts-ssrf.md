# Задача 006-8 — `rpcHosts`: курирование и SSRF-периметр

| Поле               | Значение                                                            |
| ------------------ | ------------------------------------------------------------------- |
| **RTM**            | R-56                                                                |
| **Зависимости**    | 006-2 (кандидаты из отчёта генератора), 006-5 (`rpc-evm` предикат)  |
| **Блокирует**      | 006-10                                                              |
| **Платный расход** | 0                                                                   |
| **Класс**          | **security-critical** — единственный нетривиальный риск всей задачи |

## Источники

- [security.md](../architectures/security.md) §7.2.1 — три жёстких правила, критерий включения
- [system-architecture.md](../architectures/system-architecture.md) §3.2 — предикат `rpc-evm`
- [TASK.md](../TASK.md) R-56; OQ-2 (решён дефолтом)

## Цель

Дать `wallet.balances.native` работать на нескольких десятках EVM-сетей, **не** превращая
SSRF-allowlist в список, который определяет третья сторона по сети.

## Риск, который здесь снимается

`chainid.network` отдаёт `rpc[]` для **2660** сетей. Наивная реализация — импортировать их в
allowlist — означала бы, что множество хостов, куда движок делает исходящие запросы, задаётся
недоверенным источником. Гейт, чей allowlist задаёт третья сторона, — не гейт.

## Контекст: файлы

| Файл                                           | Действие                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/core/src/chain/registry.data.json`   | заполнить `rpcHosts` **вручную**, по отчёту 006-2                           |
| `packages/core/scripts/sync-chain-registry.ts` | секция отчёта «кандидаты RPC» (уже есть из 006-2) — **не** запись в колонку |
| `packages/core/src/adapters/rpc-evm/index.ts`  | хосты берутся из `chain.rpcHosts`                                           |
| `packages/core/src/net/safe-fetch.ts`          | **не менять механизм** — только источник allowlist                          |
| `packages/core/test/ssrf-multichain.test.ts`   | **создать**                                                                 |
| `docs/architectures/security.md`               | зафиксировать фактически включённые сети (после курирования)                |

## Три правила (буквально из security.md §7.2.1) — не пересматриваются

1. **`rpcHosts` — курируемая колонка.** Генератор только **предлагает**; запись — через ревью и
   коммит человека. Единственное поле реестра с явным запретом автозаполнения.
2. **Allowlist статичен в рантайме.** Ни один ответ вендора не может расширить множество
   разрешённых хостов. Формулировка шире, чем «не брать из chainid.network»: запрещён **любой**
   путь, в котором данные из сети влияют на allowlist.
3. **Сеть без `rpcHosts` — честно непокрыта, не сломана.** `rpcHosts: null` →
   `rpc-evm.chainSupport()` = `false` → `CapabilityNotCoveredOnChainError` **до** сети.
   Альтернатива (попытаться и упасть по таймауту) маскировала бы отсутствие конфигурации под сбой.

## Критерий включения (дефолт OQ-2)

Топ-N по TVL с **ручной** проверкой живости endpoint'а. Обоснование порога: топ-50 сетей = 99.1%
всего TVL — курирование десятков хостов, а не тысяч, даёт практически полный охват спроса.
Остальные сети остаются полностью функциональными для keyless-capability (`chain.tvl`,
`token.price`, `token.metadata`, `pairs.new`), которым RPC не нужен.

## Phase 1 — механика без данных `[STUB CREATION]`

1. `rpc-evm` читает хосты из `chain.rpcHosts`; в реестре заполнена **только** запись
   `eip155:1` (Ethereum) — ровно то, что было до задачи.
2. Гейт Phase 1: все 492 теста зелёные, поведение `wallet_balances` не изменилось.

## Phase 2 — курирование `[LOGIC IMPLEMENTATION]`

1. Прогнать генератор, взять секцию «кандидаты RPC» из отчёта.
2. Для каждой сети-кандидата **вручную** проверить живость (`eth_chainId` возвращает ожидаемый id).
3. Внести подтверждённые хосты в `rpcHosts`. Записать в `security.md` фактический список сетей и
   дату проверки.
4. Убедиться, что `safeFetch`/`assertAllowedHost` **не изменены** — меняется только источник
   данных для allowlist, не механизм.

## Test Cases

| #   | Проверка                                                                                     |
| --- | -------------------------------------------------------------------------------------------- |
| 1   | Сеть с `rpcHosts: null` → `CapabilityNotCoveredOnChainError`, **ноль** сетевых вызовов       |
| 2   | Запрос к хосту вне `rpcHosts` этой сети → отклонён SSRF-гейтом                               |
| 3   | **Ключевой:** ответ вендора, содержащий новый хост, не расширяет allowlist (попытка → отказ) |
| 4   | Редирект на хост вне allowlist отклоняется на каждом хопе (регрессия M1)                     |
| 5   | `wallet_balances` на новой EVM-сети с курированным хостом отрабатывает                       |
| 6   | Хосты одной сети не действуют для другой (allowlist per-chain, не глобальный)                |
| 7   | Все записи `rpcHosts` — только `https://`                                                    |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/ssrf-multichain.test.ts
pnpm --filter @onchain-intel/core test
pnpm --filter @onchain-intel/mcp-server test
# R-56a: генератор по-прежнему не пишет rpcHosts (курирование ручное)
grep -nE "rpcHosts\s*[:=]" packages/core/scripts/sync-chain-registry.ts && echo "REVIEW: generator writes rpcHosts" || echo "curated-only-ok"
# R-56c: allowlist не строится из сетевого ответа
grep -rnE "allowlist|allowedHosts" packages/core/src/adapters/rpc-evm/index.ts
# R-56d: механизм SSRF-гейта не тронут
git diff --stat -- packages/core/src/net/safe-fetch.ts   # ожидается: без изменений
# все rpcHosts — https
python3 -c "import json;d=json.load(open('packages/core/src/chain/registry.data.json'));bad=[c['slug'] for c in d['chains'] if c.get('rpcHosts') and any(not h.startswith('https://') for h in c['rpcHosts'])];print('REVIEW:',bad) if bad else print('https-only-ok')"
```

- **[R-56]** Курируемая колонка; статичный allowlist; непокрытие вместо рантайм-падения;
  механизм SSRF не ослаблен.

## Notes

> **Соблазн, который надо погасить:** «отчёт же уже содержит проверенные RPC, давайте генератор
> их и запишет». Нет — автоматизация именно этого поля есть эквивалент отдачи allowlist наружу.
> Ручной коммит здесь **является** механизмом контроля, а не бюрократией.

> Асимметрия покрытия после задачи (`chain.tvl` на сотнях сетей, `wallet.balances.native` на
> десятках) — ожидаемое следствие честности, а не недоделка. Матрица делает её видимой через
> `onchain_list_chains({capability})`.
