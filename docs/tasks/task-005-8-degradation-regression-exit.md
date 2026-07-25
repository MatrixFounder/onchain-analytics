# Task 005-8 — [R-40] явная деградация + регрессия M1 + scope-guard + exit-критерии M2

| Поле                    | Значение                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                                               |
| **Тип**                 | Verify (интеграционная приёмка; кода добавляется минимум — только тесты деградации)                                  |
| **R-IDs**               | **R-40** (+ перепроверка R-37/R-39/R-44 в полном прогоне)                                                            |
| **Зависимости**         | 005-7 (транзитивно — всё)                                                                                            |
| **Разблокирует**        | финальный гейт оркестратора (commit/push/CI)                                                                         |
| **Источники**           | TASK.md §6 (acceptance + трассировка exit-критериев ROADMAP §M2), §4 (out of scope)                                  |
| **Живые кредиты**       | **0** — вся проверка offline                                                                                         |
| **M1-baseline**         | **287** зелёных тестов до первой правки M2 — разбивка ниже                                                           |
| **BASE_SHA**            | заполнено в 005-1 Phase 1: `git rev-parse HEAD` до первой правки M2 → **`8499a212a7dce9cf47122a80c0524cd0060b0e8f`** |

## M1-baseline

Снято в 005-1 Phase 1, до первой правки M2 (координатор):

- `@onchain-intel/core` — **212** тестов;
- `@onchain-intel/mcp-server` — **75** тестов;
- **итого 287** зелёных.

Смысл числа — сверка на приёмке: тестов должно стать строго больше, и ни один M1-тест не должен
исчезнуть или быть переписан.

## Цель

Доказать, что платный слой **добавился, а не заменил собой** движок: без ключа и при исчерпанном
бюджете M2-tools честно отказывают, а `onchain_ping` + 4 M1-tool'а работают в той же сессии без
единого изменения контракта. Плюс сквозной scope-guard и полный DoD.

## Контекст: файлы

**Новые:**

- `packages/mcp-server/test/m2-degradation.integration.test.ts` — оба сценария деградации в одной
  сессии/процессе (аналог существующего `env-degradation.integration.test.ts` из M1).

**Правки:** ожидаются **нулевые** в M1-коде. Если правка потребовалась — это находка, которую надо
разобрать, а не «поправить, чтобы прошло».

## Reviewer-заметки (обязательно применить)

- **«Деградация» в M2 = явный `isError`, НЕ registry-fallback на бесплатного провайдера.** ROADMAP
  буквально говорит «деградация на free-провайдера», но у трёх M2-способностей нет бесплатного
  эквивалента с тем же смыслом данных — молчаливая подмена была бы хуже громкой ошибки. Это
  задокументированная реинтерпретация (TASK.md §4), а не молчаливое расхождение: убедиться, что она
  отражена в отчёте о приёмке.
- **Два разных сценария, оба обязательны:** (1) **ключа нет**; (2) **ключ есть, бюджет исчерпан**.
  Второй — не дубль первого: он проходит через гейт, а не через `isAvailable()`.
- **⚠️ Изоляция от ambient-ключа (M-1 review — критично именно здесь):** после 005-7 в `.env`
  разработчика лежит **живой** `NANSEN_API_KEY`, а `pnpm test` наследует `process.env`. TC-INT-02
  гоняется **с** заданным ключом и полагается на **предзаполненный фейковый** `usage`/потолок —
  любой промах (потолок из живого `/account`, чужой бакет, реальный registry) превратил бы «0
  сетевых вызовов» в живой 10cr-вызов. Поэтому: (a) «ключ» в TC-INT-02 — `vi.stubEnv('NANSEN_API_KEY',
'test-key-not-real')`, а не ambient; (b) потолок/остаток — из инжектированного fake-`fetchImpl`
  (фикстура `/account`), не из сети; (c) `usage` предзаполняется прямым `recordDelta` в тестовый
  in-memory `BudgetStore`; (d) спавн-сервер (если используется) получает явный `env` **без**
  `NANSEN_API_KEY`. Машинный гейт — `grep` в acceptance ниже.
- **В обоих сценариях — в той же сессии** дёргаются `onchain_ping` и 4 M1-tool'а и отвечают
  нормально. Это и есть «M1 не деградировал», а не просто «сьют зелёный».
- **M1-ассерты не правятся.** Если M1-тест потребовал правки — регрессия, а не «обновление
  ожиданий». Единственное легальное изменение M1-теста в M2 — счётчик `tools/list` (5 → 8) в
  spawn-e2e, уже сделанный в 005-6.
  > ⚠️ **Фактически изменены ещё два M1-теста (vdd-multi цикл 4, G-9).** Оба защитимы, но правило
  > выше их не разрешало, и до сих пор они нигде не были записаны против него:
  > `packages/core/test/cache.test.ts` — ассерт бутстрапа провайдеров 9 → 10 (прямое следствие
  > десятой записи реестра, иначе тест красный по определению); `packages/mcp-server/test/env-degradation.integration.test.ts`
  > — пять мест переписаны на `toProcessEnv(env)` (механическая адаптация к новой форме env-слоя).
  > Ни одно не меняет проверяемое M1-поведение. Исходники M1 при этом не тронуты побайтово —
  > сверено против `8499a21`.
- **`_meta.cache`-контракт побитово тот же** (форма, набор полей, отсутствие `ageMs` на miss).
- **Grep-гейт неприкосновенности:** `registry.ts`, `resolve-capability.ts`, 4 M1-tool-файла, 9
  M1-адаптеров — **нулевой дифф**. По архитектуре это должно выполняться by design (гейт внутри
  `fetch()` адаптера), так что срабатывание гейта = сигнал, что что-то пошло не тем путём.
- **Scope-guard** — тот же приём, что R-27 в M1: диффом и грепом подтвердить отсутствие
  out-of-scope кода (список ниже).
- **Offline-прогон обязателен** (не «мы уверены, что фикстуры покрывают всё»).

## Steps

1. Написать `m2-degradation.integration.test.ts` (оба сценария + M1-tools в той же сессии).
2. Прогнать полный DoD (см. Acceptance).
3. Прогнать scope-guard-грепы.
4. Сверить фактическое число тестов с M1-baseline из 005-1: **должно быть строго больше**, и ни один
   M1-тест не должен исчезнуть/быть переписан (`git diff` по `packages/*/test/` показывает только
   добавления + счётчик tools/list).
5. Заполнить трассировку exit-критериев ROADMAP §M2 в отчёте о приёмке.

## Test Cases

1. **TC-INT-01 (R-40, нет ключа):** пустой `.env` → `onchain_smart_money_flows` /
   `onchain_entity_label` / `onchain_token_risk` → `isError: true`, причина называет
   `NANSEN_API_KEY`, **значения ключа нет**; **в той же сессии** все пять M1-путей (`onchain_ping`,
   `onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`, `onchain_protocol_tvl`)
   отвечают нормально.
2. **TC-INT-02 (R-40, M-1b — бюджет исчерпан):** ключ задан, `usage(bucket)` предзаполнен до
   потолка → три M2-tool'а → `isError` с бюджетной причиной, **0 сетевых вызовов**; те же 5
   M1-путей в той же сессии работают.
3. **TC-INT-03 (R-40, `_meta.cache` неизменён):** ответ M1-tool'а несёт ровно тот же набор полей
   `_meta.cache`, что до M2 (сравнение со snapshot-ассертом M1-теста).
4. **TC-VERIFY-04 (перепроверка R-37):** оба отказ-теста + atomicity-тест зелёные в полном прогоне.
5. **TC-VERIFY-05 (перепроверка R-39):** singleflight-тест зелёный.
6. **TC-VERIFY-06 (перепроверка R-44):** полный `pnpm test` при отключённой сети — зелёный.
7. **TC-VERIFY-07 (scope-guard):** грепы ниже — все «ok».

## Acceptance (команды — RF-1-safe)

```bash
# Полный DoD (порядок как в CI):
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @onchain-intel/mcp-server run smoke:dist

# R-40: деградация в одной сессии
pnpm --filter @onchain-intel/mcp-server exec vitest run test/m2-degradation.integration.test.ts
pnpm --filter @onchain-intel/mcp-server exec vitest run test/env-degradation.integration.test.ts   # M1-версия — без правок

# M-1: M2-тесты не читают ambient-ключ (после 005-7 в .env лежит живой NANSEN_API_KEY):
grep -rn "process\.env\.NANSEN_API_KEY" packages/*/test/ && echo "REVIEW: ambient key in tests" || echo "env-isolated-ok"

# Неприкосновенность M1 — ДВА среза (M-3 review): против pre-M2 BASE_SHA (устойчиво к mid-run коммиту
# фикстур, PLAN §0.4) И working-tree (незакоммиченное). Подставить BASE_SHA из шапки. Все — пусто:
M1_PATHS="packages/core/src/adapters/registry.ts packages/mcp-server/src/tools/resolve-capability.ts packages/mcp-server/src/tools/get-token.ts packages/mcp-server/src/tools/wallet-balances.ts packages/mcp-server/src/tools/new-pairs.ts packages/mcp-server/src/tools/protocol-tvl.ts packages/mcp-server/src/tools/ping.ts packages/core/src/adapters/coingecko packages/core/src/adapters/dexscreener packages/core/src/adapters/defillama packages/core/src/adapters/dune packages/core/src/adapters/rpc-evm packages/core/src/adapters/rpc-solana packages/core/src/adapters/dash-platform packages/core/src/adapters/platform-explorer packages/core/src/adapters/pg-history"
git diff --stat "$BASE_SHA"..HEAD -- $M1_PATHS    # закоммиченные правки с начала M2
git diff --stat -- $M1_PATHS                       # незакоммиченные правки в рабочем дереве (working tree vs INDEX)

# ⚠️ Orchestrator correction (005-8 execution, RF-1-class fix — записано, не молча): ни один M2-коммит
# не был сделан поверх BASE_SHA на момент прогона этой задачи (весь M2 живёт в рабочем дереве) — тогда
# HEAD === BASE_SHA, и первая команда выше (`BASE_SHA..HEAD`) вырожденно пуста ЛЮБЫМ образом, а вторая
# (`git diff` без ref) совпадает с проверкой ниже ТОЛЬКО пока индекс не тронут (`git add` ничего не
# застейджил) — хрупкое совпадение, не гарантия. Единственная команда, которая сравнивает рабочее дерево
# напрямую с BASE_SHA независимо от состояния индекса/коммитов, — один ref, без `..HEAD`:
git diff --stat "$BASE_SHA" -- $M1_PATHS           # АВТОРИТЕТНАЯ проверка — рабочее дерево vs BASE_SHA напрямую

# Scope-guard (все — «ok»):
grep -rn "bitquery" packages/ --include=*.ts && echo "REVIEW: bitquery in scope?" || echo "no-bitquery-ok"
grep -rn "mcp.nansen.ai" packages/ && echo "REVIEW: nansen MCP endpoint wired" || echo "no-nansen-mcp-ok"
grep -rnE "agent/(fast|expert)" packages/ && echo "REVIEW: agent endpoints wired" || echo "no-agent-endpoints-ok"
grep -rnE "premium-labels" packages/core/src && echo "REVIEW: 500cr endpoint wired" || echo "no-premium-labels-ok"
grep -rnE "\b(croner|bullmq)\b" packages/ --include=*.ts && echo "REVIEW: scheduler in M2" || echo "no-scheduler-ok"
grep -rnE "\b(INSERT|UPDATE|DELETE)\b" packages/core/src/pg/ && echo "REVIEW: write path in pg client" || echo "pg-select-only-ok"
grep -rniE "streamableHttp|SSEServerTransport" packages/mcp-server/src && echo "REVIEW: HTTP transport in M2" || echo "stdio-only-ok"
# dune не оживлён:
grep -n "isAvailable" -A 3 packages/core/src/adapters/dune/index.ts   # по-прежнему безусловный false
```

**Ручная проверка exit-критериев ROADMAP §M2** (Claude Code, локальный stdio-сервер):

- **8 tools** видны в `tools/list`.
- Без `NANSEN_API_KEY`: три M2-tool'а → `isError`; 4 M1-tool'а + `onchain_ping` → нормальные ответы.
- С ключом: `onchain_smart_money_flows` отдаёт потоки **и** метки холдеров (exit-критерий #1, уже
  закрыт живьём в 005-7 — **повторно платить не требуется**, TTL-кеш отдаёт `hit`).
- Повторный вызов в TTL → `_meta.cache.status === 'hit'`, `_meta.budget` **отсутствует**.

- **[R-40]** явная деградация (нет ключа **и** исчерпан бюджет) + полная регрессия M1 (baseline из
  005-1, ассерты M1 не правились, `_meta.cache` неизменён, M1-код с нулевым диффом).

## Notes

> Если R-44 остался незакрытым (нет живого ключа — см. Notes 005-7), это фиксируется в отчёте о
> приёмке **явно** («M2 принят с открытым R-44: фикстуры provisional»), а exit-критерий #1 ROADMAP
> помечается недоказанным живьём. Никакой «частичной приёмки по умолчанию».
