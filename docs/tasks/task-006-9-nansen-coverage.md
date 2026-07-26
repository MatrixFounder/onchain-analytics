# Задача 006-9 — Покрытие Nansen: codegen из спеки + живой спот-чек

| Поле               | Значение                                             |
| ------------------ | ---------------------------------------------------- |
| **RTM**            | R-58                                                 |
| **Зависимости**    | 006-4, 006-5                                         |
| **Блокирует**      | 006-10                                               |
| **Платный расход** | **≤ 6 кредитов** — единственная платная задача плана |

## Источники

- Закоммиченная спека: [raw/nansen-openapi-2026-07-23.json](../onchain-analytics/raw/nansen-openapi-2026-07-23.json)
- [data-model.md](../architectures/data-model.md) §4.1 (`CoverageProbe`), §4.2.3 (деградированный путь)
- [PLAN.md](../PLAN.md) §0.2 — находка разведки и зафиксированное отклонение от R-58a
- [TASK.md](../TASK.md) R-58, UC-3

## Цель

Заполнить chain-покрытие Nansen **фактом, а не догадкой**, потратив почти ноль кредитов.

## Находка, определяющая объём задачи

Закоммиченная спека **уже перечисляет** поддерживаемые сети по эндпоинтам — 20 различных
chain-энумов. Покрытие извлекается codegen'ом за **0 кредитов**, тем же приёмом, которым M2 уже
генерирует `costOf()`-таблицу.

| Схема в спеке         | Сетей | Обслуживает                                 |
| --------------------- | ----- | ------------------------------------------- |
| `SmartMoneyChain`     | 17    | `POST /smart-money/netflow`                 |
| `TGMHoldersChain`     | 25    | `POST /tgm/holders`                         |
| `TGMChain`            | 25    | `/tgm/indicators`, `/tgm/token-information` |
| `ProfilerLabelsChain` | 19    | `/profiler/address/labels` (exhaustive)     |

## ⚠️ Составная capability покрыта ПЕРЕСЕЧЕНИЕМ под-вызовов

`smart-money.flows` — один `fetch()`, делающий **два** запроса (netflow + tgm/holders).

```
covered(smart-money.flows) = SmartMoneyChain ∩ TGMHoldersChain = 17
```

Объединение дало бы 25 и добавило **8 сетей** — `bitcoin`, `injective`, `mantra`, `near`,
`starknet`, `sui`, `ton`, `tron` — на которых вызов отработал бы **наполовину**: один под-запрос
успешен, второй отвергнут вендором, кредиты за первый уже списаны. Это ровно класс DF-1.

**Итог после задачи:** `smart-money.flows` — 17 сетей (было 2), `token.risk` — 25,
`entity.labels` — 25 (exhaustive-tier — 19).

## Контекст: файлы

| Файл                                                                | Действие                                         |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/core/scripts/gen-nansen-coverage.ts`                      | **создать** — codegen из спеки                   |
| `packages/core/src/adapters/nansen/chain-coverage.ts`               | **создать** (генерируемый, коммитится)           |
| `packages/core/src/adapters/nansen/index.ts`                        | `chainSupport()` — боевой, вместо стаба из 006-5 |
| `packages/core/src/chain/registry.data.json`                        | колонка `vendors.nansen`                         |
| `docs/onchain-analytics/raw/nansen-chain-spotcheck-2026-07-XX.json` | evidence спот-чека                               |
| `packages/core/test/nansen-coverage.test.ts`                        | **создать**                                      |

## Phase 1 — codegen + стаб `[STUB CREATION]`

1. Скрипт извлекает четыре энума из спеки в committed `.ts`-модуль. Значение `'all'`
   **исключается** — это не сеть, а модификатор запроса.
2. `chainSupport()` пока возвращает прежнее (`ethereum`/`solana`) — поведение не меняется.
3. Тест: сгенерированный модуль содержит ожидаемые размеры энумов; повторный прогон
   детерминирован.

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Реализовать покрытие **по capability**, а не по адаптеру целиком: `smart-money.flows` —
   пересечение, `token.risk` — `TGMChain`, `entity.labels` — `TGMHoldersChain` (+ `ProfilerLabelsChain`
   для exhaustive-tier).
2. Заполнить `vendors.nansen` в реестре (вендорский slug сети — как её называет Nansen).
3. **Живой спот-чек, ≤6cr:** один `token.risk` на одной новой сети (напр. `base`) — самый дешёвый
   из трёх (6cr). Подтверждает, что спека не разошлась с реальностью. Результат — evidence-файл с
   датой, сетью, потраченными кредитами.
4. **Деградированный путь (R-58d):** ключа нет → спот-чек пропускается, покрытие берётся из спеки,
   `CoverageProbe.status = 'spec-only'`. Это `unverified`, **не** `unsupported`: ложное сужение
   так же плохо, как ложное расширение.

## Test Cases

| #   | Проверка                                                                                    |
| --- | ------------------------------------------------------------------------------------------- |
| 1   | **Ключевой:** каждая из 8 «половинных» сетей → `smart-money.flows` **не** покрыта           |
| 2   | Те же 8 сетей → `token.risk`/`entity.labels` покрыты (пересечение считается per-capability) |
| 3   | `'all'` не попал в множество сетей ни одной capability                                      |
| 4   | Повторный прогон codegen → побайтово идентичный модуль                                      |
| 5   | Непокрытая сеть для `smart-money.flows` → отказ **до** HTTP, `usage` не инкрементится       |
| 6   | Нет ключа → `spec-only`, покрытие непусто (не схлопнулось в `unsupported`)                  |
| 7   | `ethereum`/`solana` покрыты всеми тремя capability (регрессия M2)                           |
| 8   | Evidence-файл спот-чека существует и содержит `creditsSpent`                                |

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/nansen-coverage.test.ts
pnpm --filter @onchain-intel/core test
pnpm --filter @onchain-intel/mcp-server test
# R-58: покрытие сгенерировано из спеки, не вписано руками
grep -nE "GENERATED|do not edit" packages/core/src/adapters/nansen/chain-coverage.ts
# пересечение, а не объединение — проверка глазами на 8 сетях
grep -nE "bitcoin|injective|mantra|near|starknet|sui|ton|tron" packages/core/src/adapters/nansen/chain-coverage.ts
# 'all' исключён
grep -nE "'all'" packages/core/src/adapters/nansen/chain-coverage.ts && echo "REVIEW: 'all' leaked into chain set" || echo "all-excluded-ok"
# расход кредитов зафиксирован
ls -la docs/onchain-analytics/raw/nansen-chain-spotcheck-*.json
```

- **[R-58]** Покрытие из спеки (0cr); пересечение для составных; спот-чек ≤6cr с evidence;
  `spec-only` вместо `unsupported` при отсутствии ключа.

## Notes

> **Зафиксированное отклонение от R-58a.** Буква требования — «прогон с ключом». Спека закрывает
> вопрос точнее и дешевле; полный перебор 25 сетей живыми вызовами стоил бы кредитов без нового
> знания. Дух («факт, а не догадка») соблюдён строже буквы. Отклонение названо здесь и в PLAN §0.2,
> а не оставлено неявным.

> **Спека датирована 2026-07-23** и может разойтись с вендором (CLAUDE.md: vendor counters drift).
> Спот-чек существует именно для обнаружения расхождения. Если он покажет расхождение — это не
> повод править покрытие руками: надо перезаписать спеку живым probe'ом и перегенерировать.
