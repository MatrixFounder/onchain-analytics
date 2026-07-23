# 10. Деплой

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 10.1. Окружения

Без изменений — только dev, локально, под Claude Code (M0/M1 не вводит staging/prod для этого
пакета). PG read-only клиент **подключается** к уже существующей dev-VM Supabase-инсталляции
(CLAUDE.n8n.md), но не разворачивает и не мигрирует её — read-only потребитель чужой БД.

### 10.2. CI/CD Pipeline

Порядок шагов CI (`.github/workflows/ci.yml`) расширяется охватом второго пакета через
repo-wide/`pnpm -r`-скрипты **плюс один структурный шаг, добавленный по результату верификации
003-8 (2026-07-23):** на свежем checkout `dist/` (gitignored) не существует, а `@onchain-intel/core`
экспонируется потребителю только через `main`/`types` → `dist/*` — поэтому **до** `typecheck`/`test`
обязателен `pnpm --filter @onchain-intel/core build` (иначе TS2307 / 7 из 9 mcp-сьютов не
резолвят пакет; локально это маскировалось остаточным dist). Шаг идемпотентен (plain tsc) и
сохраняет инвариант «mcp-server build — после test» (E2E спавнит tsx на src):

```
checkout(SHA-pin) → corepack enable (pnpm) → setup-node@22 (кеш pnpm store)
  → pnpm install --frozen-lockfile
  → pnpm lint            # repo-wide, теперь покрывает packages/core тоже
  → pnpm format:check    # repo-wide
  → pnpm --filter @onchain-intel/core build   # prerequisite: core dist для резолюции пакета (003-8)
  → pnpm typecheck       # pnpm -r typecheck — core, затем mcp-server (топология)
  → pnpm test            # pnpm -r test — core (contract+cache+SSRF+rate-limit тесты, все на фикстурах/моках)
                          #                затем mcp-server (env/ping/e2e.stdio [spawn, 5-tool list+ping]/
                          #                e2e.inprocess [InMemoryTransport, 4 tools, fixture registry] — F-1)
  → pnpm build           # pnpm -r build — core (plain tsc) → mcp-server (tsup+tsc, как в M0)
  → smoke:dist           # без изменений, ping-only (см. §3.2 обоснование)
```

**Что меняется по сути:** фикстуры/моки (D11) делают весь новый тест-объём (9 адаптеров, из
которых `dash-platform` — fixture-мок и `dune` — вообще без теста в M1, F-2/F-3/minor + registry +
cache + SSRF + rate-limit + 4 tool'а через **два** E2E-сьюта, F-1) **сетево-независимым** — ни
один новый секрет не появляется в CI (R-21: `DUNE_API_KEY`/`COINGECKO_API_KEY`/`ONCHAIN_PG_URL`
не нужны тестам, только Development-скрипту `record-fixture.mjs`, который **вне** CI). Никакого
сетевого вызова в `pnpm test` по-прежнему не должно происходить — тот же инвариант R-15/R-21 M0,
теперь проверяемый на кратно большем объёме кода.

### 10.3. Конфигурация

`EnvSchema` (`mcp-server/src/env.ts`) — по-прежнему единственный источник конфигурации процесса;
4 новых ключа **все опциональны** (R-23), пустой env остаётся валидным (UC-1). `providers.config.ts`
(`packages/core`) — единственный источник маршрутизации/allowlist/rate-limit — смена приоритета
провайдера или добавление нового хоста в allowlist — правка одного файла, не кода (R-4).

### 10.4. Инструкция по развёртыванию (dev)

1. `git clone` → `pnpm install` в корне (workspaces поднимают оба пакета).
2. `pnpm build` (`pnpm -r build`: `core` — plain `tsc`, `mcp-server` — tsup+tsc, топологический
   порядок).
3. `pnpm lint && pnpm typecheck && pnpm test` — всё зелёное без сети/секретов (UC-1, R-21).
4. (Опционально) `.env` с `COINGECKO_API_KEY`/`COINGECKO_PRO_API_KEY`/`DUNE_API_KEY`/`ONCHAIN_PG_URL`/`DATA_DIR` — ни один
   не обязателен; отсутствующие способности деградируют явно (UC-1 alt, R-24).
5. Подключение к Claude Code как локальный stdio MCP-сервер — без изменений от M0 (`node
packages/mcp-server/dist/index.js` или `tsx packages/mcp-server/src/index.ts`).
6. Вызов любого из 5 tools → канонический ответ; повторный вызов с теми же нормализованными
   аргументами в пределах TTL → `_meta.cache.status === 'hit'` (UC-3, exit-критерий ROADMAP).
