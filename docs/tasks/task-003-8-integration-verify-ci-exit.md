# Task 003-8 — интеграционная верификация: cache-hit + hot-swap proof, scope-guard, CI/smoke, exit-критерии

| Поле                    | Значение                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                             |
| **Тип**                 | Verify / config (не Stub-First — сквозная проверка + CI-обвязка)                                   |
| **R-IDs**               | **R-27**, **R-28** (owning) + перепроверка **R-15**, **R-11** (exit-mapping)                       |
| **Зависимости**         | 003-7 (транзитивно — всё)                                                                          |
| **Разблокирует**        | — (финальный гейт M1)                                                                              |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §10.2 (CI), §11; TASK.md §6 (exit); `docs/issues/rf-1-...md` |

## Цель

Собрать M1 воедино: доказать exit-критерии ROADMAP (cache-hit виден в метриках; hot-swap DAPI→
platform-explorer; 4 tool на 2 сетях; $0/без сети в CI), провести scope-guard по diff'у (R-27),
подтвердить RF-1-исполнимость всех acceptance-сниппетов (R-28), расширить CI охватом второго пакета
через `pnpm -r` и проверить топологический build-порядок эмпирически (§11).

## Контекст: файлы

- `.github/workflows/ci.yml` — шаги **структурно не меняются** (уже `pnpm -r`-фан-аут); подтвердить, что
  `lint`/`format:check`/`typecheck`/`test`/`build` покрывают `packages/core`; `smoke:dist` (ping-only)
  остаётся после `build` для `mcp-server`.
- (при необходимости) `packages/core` не имеет `smoke:dist` — это ок (библиотека без `bin`).
- Никаких новых src-файлов — только верификация + возможная правка CI-комментариев/порядка.

## Reviewer-заметки (обязательно применить)

- **`smoke:dist` остаётся ping-only** (ARCHITECTURE §3.2): его роль — проверить, что собранный
  `dist/index.js` поднимается и говорит по wire-протоколу; расширять до живых сетевых вызовов НЕЛЬЗЯ
  (вернуло бы сетевую зависимость CI, R-21). Поведение 4 tool покрыто `e2e.inprocess` (на `tsx`, не `dist/`).
- **R-15 exit-proof — через tool, не только unit** (§9.3): повторный вызов одного tool с теми же
  нормализованными аргументами → `_meta.cache.status: miss` (первый) → `hit` (второй). Уже проверяется в
  `e2e.inprocess.test.ts` (003-7) — здесь фиксируем как exit-критерий, отдельного нового `[R-15]`-пункта
  не создаём (owning — 003-3).
- **R-11 exit-proof — реальная M1-конфигурация** (§9.1): `dash-platform.isAvailable()===false` →
  `platform-explorer`; уже в `registry.fallback.test.ts` (003-5) — здесь фиксируем как exit-критерий
  (owning — 003-5).
- **Топология (§11):** `pnpm -r build`/`test` строит `core` перед `mcp-server` — это **предположение**,
  проверяемое эмпирически, не факт. Прогнать и подтвердить порядок в логе.
- **RF-1 (R-28):** ни одного bare `timeout`, ни одного форвардинга двойного дефиса в vitest через `pnpm`
  во всех task-файлах — прогнать сводный grep-гейт по `docs/tasks/task-003-*.md` (см. Acceptance). Сами
  гейты сконструированы так, чтобы **не матчить собственное определение** (anchored на строку-команду +
  bracket-trick `[-]`), иначе success-ветка недостижима (F-2).
- **Scope-грепы полагаются на правило:** запрещённые токены (`nansen`, `croner`, `BullMQ`, `@grpc`,
  `Streamable`, `SSEServerTransport`, `express`, `watchlist`) **НИКОГДА не появляются дословно в
  комментариях исходников** — иначе scope-грепы дают ложное срабатывание; где возможно, грепы сужены до
  import/require-строк (не всего файла).
- **Коммит — только оркестратор** на гейте (dev-задачи не коммитят).

## Шаги (verify)

1. **Сводный DoD-прогон** (порядок как в CI, без сети/секретов):

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @onchain-intel/mcp-server run smoke:dist
```

2. **Топология build (§11, эмпирически):**

```bash
pnpm -r build 2>&1 | grep -nE "@onchain-intel/(core|mcp-server)"   # core должен собраться раньше mcp-server
```

3. **R-15 cache-hit exit-proof:**

```bash
pnpm --filter @onchain-intel/mcp-server exec vitest run test/e2e.inprocess.test.ts   # _meta.cache miss→hit присутствует
```

4. **R-11 hot-swap exit-proof:**

```bash
pnpm --filter @onchain-intel/core exec vitest run test/registry.fallback.test.ts     # dash-platform→platform-explorer
```

5. **R-27 scope-guard (grep по всему диффу M1):**

```bash
# нет платных провайдеров/Nansen (полагается на правило: запрещённый токен НЕ пишется дословно в комментах):
grep -RniE "nansen" packages/*/src && echo "REVIEW: paid provider" || echo "no-nansen-ok"
# нет ВНЕШНИХ write-путей (pg-клиент/адаптеры/mcp-server). Движко-локальный кеш-upsert
# (INSERT ... ON CONFLICT ... DO UPDATE) в packages/core/src/cache/ ТРЕБУЕТСЯ (R-14) — поэтому НЕ сканируется:
grep -RnE "\b(INSERT|UPDATE|DELETE)\b" packages/core/src/pg packages/core/src/adapters packages/mcp-server/src && echo "REVIEW: external write path" || echo "no-external-write-ok"
# нет планировщика (import/require-скан, не комментарии):
grep -RnE "^[[:space:]]*(import|export)[^;]*(croner|bullmq|node-cron)|require\(['\"](croner|bullmq|node-cron)" packages/*/src && echo "REVIEW: scheduler" || echo "no-scheduler-ok"
# нет HTTP/SSE/Streamable-транспорта (import/usage-скан, не комментарии):
grep -RnE "^[[:space:]]*(import|export)[^;]*(Streamable|SSEServerTransport)|from ['\"]express|require\(['\"]express|http\.createServer\(" packages/*/src && echo "REVIEW: http transport" || echo "stdio-only-ok"
# нет @grpc в M1 (import/require-скан + dependency-скан — не комментарии):
grep -RnE "^[[:space:]]*(import|export)[^;]*@grpc|require\(['\"]@grpc" packages/*/src && echo "REVIEW: grpc import in M1" || echo "no-grpc-import-ok"
grep -RnE "\"@grpc/(grpc-js|proto-loader)\"" packages/*/package.json && echo "REVIEW: grpc dependency in M1" || echo "no-grpc-dep-ok"
# нет ERC-20/SPL токен-балансов в M1 (import/usage):
grep -RniE "getTokenAccountsByOwner|eth_call.*balanceOf" packages/*/src && echo "REVIEW: token-balance path (ERC20/SPL out of M1)" || echo "native-only-ok"
# нет watchlists (import/usage, не комментарии):
grep -RnE "^[[:space:]]*(import|export)[^;]*watchlist|onchain_watch" packages/*/src && echo "REVIEW: watchlist" || echo "no-watchlist-ok"
```

6. **R-28 RF-1 сводный гейт по task-файлам:**

```bash
# Оба гейта сканируют ТОЛЬКО строки-команды (начинаются с pnpm/буквы-команды) и используют bracket-trick
# ([-] вместо -), поэтому НЕ матчат собственное определение/пояснительную прозу (F-2 fix):
grep -nE "^[[:space:]]*[a-z][^#]*\btimeout [0-9]" docs/tasks/task-003-*.md && echo "REVIEW: bare timeout in a command (RF-1)" || echo "no-bare-timeout-ok"
grep -nE "^[[:space:]]*pnpm [^#]*test [-][-] [-][-]" docs/tasks/task-003-*.md && echo "REVIEW: pnpm forwards [-][-] to vitest (RF-1)" || echo "no-dashdash-forward-ok"
```

7. **Exit-критерии ROADMAP (TASK.md §6) — сверка вручную:** все 4 tool отвечают на ethereum+solana
   (003-7 e2e); cache-hit в метриках (шаг 3); $0/keyless (003-4/5, ни один секрет в CI); golden зелёные
   (003-1/2/4); scope-guard чист (шаг 5).

## Acceptance (команды — RF-1-safe)

```bash
# полный сьют зелёный, без сети/секретов:
pnpm test
# сборка + smoke (ping-only):
pnpm build && pnpm --filter @onchain-intel/mcp-server run smoke:dist
# scope-guard и RF-1-гейты (шаги 5–6) — все ветки печатают *-ok
```

- **[R-27]** diff не содержит платных провайдеров, write-путей, планировщика, HTTP-транспорта, watchlists,
  `@grpc`, live-Dune, ERC-20/SPL — grep-гейты зелёные; ревью PR подтверждает §3 In Scope.
- **[R-28]** все acceptance-сниппеты во всех task-файлах RF-1-исполнимы (нет bare `timeout`, нет
  форвардинга двойного дефиса в vitest через `pnpm`); сводный DoD-прогон зелёный на macOS+pnpm 11.
- **(exit) R-15** cache-hit виден в метриках (`_meta.cache` miss→hit) — подтверждено e2e.
- **(exit) R-11** hot-swap DAPI→platform-explorer — подтверждён на реальной M1-конфигурации.

> Финальный гейт (только по команде оркестратора): commit + push → GitHub Actions зелёный (Node 22).
> Никаких новых src-возможностей в этой задаче — только верификация + CI-обвязка (guard R-27).
