# PLAN — TASK-001 · M0: Discovery & каркас (`onchain-intel`)

| Поле | Значение |
|---|---|
| **Task** | [TASK-001 `m0-discovery-skeleton`](TASK.md) |
| **Architecture** | [ARCHITECTURE.md](ARCHITECTURE.md) — v1, APPROVED |
| **ADR** | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — Accepted (D1–D3, D10–D12) |
| **Статус плана** | Draft (готов к Development-фазе) |
| **Дата** | 2026-07-21 |
| **Стратегия** | Stub-First (две фазы на каждую dev-задачу: Phase 1 структура/стабы/red → Phase 2 логика/green) |

---

## 0. Стратегия и границы

M0 — это **минимальный работающий скелет** под уже принятые решения ADR-001, а не проектирование
стека. План строго следует `docs/ARCHITECTURE.md` (§3.2 — раскладка, §5.2 — интерфейсы, §10.2 —
CI). Реализуется ровно то, что в скоупе TASK.md §2; всё из §3 (адаптеры/кеш/БД/планировщик/платные
ключи/HTTP-транспорт) **не трогается** (guard R-15).

**Ключевые инженерные конвенции (из APPROVED reviewer-заметок — обязательны):**

1. **`version` прокидывается явно** (резолвит неоднозначность ARCHITECTURE §5.2 в пользу explicit
   deps): `createServer(deps: { env, version })`, `registerPingTool(server, { version })`,
   `pingHandler(input, ctx: { version })`. Версия читается из `package.json` **один раз** на входе
   (`src/index.ts`) и прокидывается вниз — не хардкодится строкой в бизнес-коде.
2. **Плейсхолдеры `"^*"` в `package.json` заменяются реальными пиннутыми диапазонами** на этапе
   установки: версии проставляет `pnpm add` (резолвит `^latest`), lockfile коммитится, CI ставит с
   `--frozen-lockfile`.
3. **`PingOutput = { ok, service, version, ts }`** — намеренно богаче необязательного примера R-10
   (`{ pong, ts }`). Форма детерминирована; в тестах `ok === true`, `service` и `version` —
   фиксированные литералы/строка версии, `ts` проверяется как `number` (это `Date.now()`).
4. **Порядок CI `test` → `build`** — сознательная конвенция (E2E спавнит исходник через `tsx`, не
   `dist/`), а не жёсткое ограничение.
5. **Автоматизированный stdio E2E-тест ОБЯЗАТЕЛЕН** (SDK `Client` + `StdioClientTransport` против
   дочернего процесса) — именно он делает exit-критерий M0 проверяемым в CI.

**Дисциплина коммитов:** dev-задачи **ничего не коммитят и не пушат**. Коммит/пуш (и, как
следствие, реальный прогон CI на remote `MatrixFounder/onchain-analytics`) выполняется **в самом
конце**, только по явной команде оркестратора (см. Задача 001-4 §Финальный гейт).

**Окружение:** локально Node v24 (ок — `engines.node >= 22` лишь декларирует минимум); CI пиннит
Node 22. `pnpm` глобально не установлен → поднять через `corepack enable pnpm` (corepack идёт с
Node), fallback `npm i -g pnpm`.

---

## 1. Граф задач (DAG)

```
001-1  Монорепо + toolchain scaffold        (config/setup, без стабов)
   │
   └─► 001-2  MCP-скелет + env + onchain_ping   (dev: Phase 1 стабы → Phase 2 логика)
          │
          └─► 001-3  Тесты: unit + stdio E2E      (dev: Phase 1 red → Phase 2 green)
                 │
                 └─► 001-4  CI + verification-only + M0 exit  (config/verify; зависит также от 001-1)
```

- **001-1** — нет зависимостей.
- **001-2** — зависит от **001-1** (workspace, tsconfig, зависимости установлены).
- **001-3** — зависит от **001-2** (src-модули существуют и импортируются; для E2E нужен рабочий
  `src/index.ts` с транспортом).
- **001-4** — зависит от **001-3** (локально зелёный сьют lint+typecheck+test) и от **001-1** (CI
  переиспользует корневые скрипты).

---

## 2. Шаги плана (по задачам) — RTM checklist

> RTM-линковка: один пункт RTM (TASK.md §4) = один чек-бокс, префикс `[R-ID]`. Все R-1…R-15
> присутствуют как явные токены. Verification-only (R-1, R-2, R-13, R-14) — отдельные проверочные
> пункты; scope-guard R-15 — сквозная проверка.

### Шаг 1 — [Задача 001-1] Монорепо + toolchain scaffold  (R-3, R-5, R-11)
Файл: [task-001-1-monorepo-toolchain-scaffold.md](tasks/task-001-1-monorepo-toolchain-scaffold.md)

- [ ] **[R-3]** pnpm-монорепо: `pnpm-workspace.yaml` + корневой `package.json` + пакет
  `packages/mcp-server/package.json` с `engines.node: ">=22"`; `pnpm install` в корне проходит без
  ошибок (lockfile сгенерирован; плейсхолдеры `"^*"` заменены реальными версиями через `pnpm add`).
- [ ] **[R-5]** ESLint + Prettier настроены: конфиги присутствуют, корневые скрипты `lint` и
  `format:check` объявлены и проходят на скелете (`pnpm lint`, `pnpm format:check` → 0 ошибок).
- [ ] **[R-11]** Лицензия Apache-2.0: корневой `LICENSE` содержит полный текст Apache License 2.0;
  `"license": "Apache-2.0"` в корневом и в `packages/mcp-server/package.json`.

### Шаг 2 — [Задача 001-2] MCP-скелет + env-модуль + `onchain_ping`  (R-4, R-9, R-10, R-12)
Файл: [task-001-2-mcp-server-env-ping.md](tasks/task-001-2-mcp-server-env-ping.md)
Stub-First: **Phase 1** — файлы/сигнатуры/стабы, `tsc --noEmit` зелёный (импортируемо); **Phase 2** —
zod-схемы, `pingHandler`, `registerPingTool`, монтаж `StdioServerTransport` в `src/index.ts`.

- [ ] **[R-4]** TS strict-конфиг (`strict: true`, `noUncheckedIndexedAccess: true` в
  `tsconfig.base.json`); `pnpm typecheck` (`tsc --noEmit`) — 0 ошибок на скелете; `pnpm build`
  (tsup) собирает `dist/`; `tsx src/index.ts` стартует без ошибок трансформации.
- [ ] **[R-9]** Скелет MCP-сервера на `@modelcontextprotocol/sdk`, **только stdio**: `src/index.ts`
  подключает `StdioServerTransport`; в коде нет ни строки HTTP/SSE/Streamable-транспорта.
- [ ] **[R-10]** Инструмент называется ровно `onchain_ping`; input/output-схема — **zod** как
  единственный источник правды (валидация ↔ MCP tool-schema, без ручного дублирования); ответ
  детерминирован (`PingOutput = { ok, service, version, ts }`).
- [ ] **[R-12]** Env-модуль `src/env.ts`: `EnvSchema` (zod, все поля optional в M0) + `loadEnv()`
  fail-fast; `EnvSchema.parse({})` не бросает (подтверждающий unit-тест поставляется в 001-3);
  `.env.example` документирует конвенцию `0600` (создаётся в 001-1, значений не содержит).

### Шаг 3 — [Задача 001-3] Тесты: unit + stdio E2E  (R-6)
Файл: [task-001-3-tests-unit-e2e-stdio.md](tasks/task-001-3-tests-unit-e2e-stdio.md)
Stub-First: **Phase 1** — написать `env.test.ts` / `ping.test.ts` / `e2e.stdio.test.ts` (red или
против стабов); **Phase 2** — весь сьют зелёный на реальной логике из 001-2.

- [ ] **[R-6]** `pnpm test` запускает vitest; минимум 1 зелёный тест. Фактически поставляются три
  файла: `env.test.ts` (unit: `EnvSchema.parse({})` не бросает — закрывает контракт R-12),
  `ping.test.ts` (unit: `pingHandler()` → `PingOutputSchema.parse(...)` проходит), и **обязательный**
  `e2e.stdio.test.ts` (SDK `Client` + `StdioClientTransport` спавнит `src/index.ts` через `tsx`,
  `tools/list` содержит `onchain_ping`, `tools/call onchain_ping` возвращает валидную форму).

### Шаг 4 — [Задача 001-4] CI-гейт + verification-only + M0 exit  (R-7, R-8, R-1, R-2, R-13, R-14, R-15)
Файл: [task-001-4-ci-verification-exit.md](tasks/task-001-4-ci-verification-exit.md)

- [ ] **[R-7]** `.github/workflows/ci.yml` существует, триггеры `push` + `pull_request`, шаги
  lint + typecheck + test (порядок: install → lint → format:check → typecheck → **test → build**).
- [ ] **[R-8]** CI на Node 22: `actions/setup-node` пиннит `node-version: '22'` (или `'22.x'`/LTS-
  алиас 22-й линии); в логе прогона видно `Node v22.x.x`.
- [ ] **[R-1]** *(verification-only)* ADR-001 имеет статус **Accepted** (`Accepted: 2026-07-20
  (Sergey)`) — проверить заголовок `docs/onchain-analytics/ADR-001-tech-stack.md`, **правок в ADR
  не вносить**; факт уже зафиксирован ссылкой в TASK.md/ARCHITECTURE.md.
- [ ] **[R-2]** *(verification-only)* `docs/ARCHITECTURE.md` и `docs/TASK.md` существуют, созданы
  этим прогоном пайплайна, ARCHITECTURE ссылается на TASK-001 и на ADR-001 (D1–D12) — подтвердить
  наличие и перекрёстные ссылки, отдельной инженерной работы не требуется.
- [ ] **[R-13]** *(verification-only)* `.gitignore` уже содержит `.env`, `.env.*`, `!.env.example`
  — проверить (строки ~47–50), новых правок не вносить, если пробел не найден.
- [ ] **[R-14]** *(verification-only)* `.gitignore` уже содержит `/DATA_DIR/`, `*.db`, `*.sqlite`,
  `*.sqlite3`, `*-wal`, `*-shm` — проверить (строки ~61–67); M0 не добавляет БД-кода и артефактов
  состояния.
- [ ] **[R-15]** *(cross-cutting scope-guard)* Ревью diff'а: изменения ограничены корневыми
  манифестами монорепо, `packages/mcp-server` (сервер + `onchain_ping` + env), CI workflow,
  lint/format/test-конфигами, `LICENSE`, `.env.example` — **ни строки** adapter/provider/cache/
  scheduler/DB-migration/HTTP-транспорт кода.

---

## 3. Полная трассировка RTM (R-1 … R-15)

| R-ID | Требование (кратко) | Задача | Фаза | Тип |
|---|---|---|---|---|
| R-1  | ADR-001 = Accepted (верификация) | 001-4 | verify | verification-only |
| R-2  | ARCHITECTURE.md + TASK.md как продукт пайплайна | 001-4 | verify | verification-only |
| R-3  | pnpm-монорепо + `engines.node >= 22`, `pnpm install` ок | 001-1 | setup | dev/config |
| R-4  | TS strict, tsup-сборка, tsx-dev, typecheck 0 ошибок | 001-2 | Phase 1+2 | dev |
| R-5  | ESLint + Prettier + lint/format-скрипты | 001-1 | setup | dev/config |
| R-6  | vitest, ≥1 зелёный тест | 001-3 | Phase 2 | dev/test |
| R-7  | CI workflow lint+typecheck+test на push/PR | 001-4 | setup | dev/config |
| R-8  | CI на Node 22 (`setup-node` пин) | 001-4 | setup | dev/config |
| R-9  | MCP-скелет, только stdio-транспорт | 001-2 | Phase 1+2 | dev |
| R-10 | `onchain_ping`, zod — единый источник правды | 001-2 | Phase 2 | dev |
| R-11 | Apache-2.0 (`LICENSE` + license-поля) | 001-1 | setup | dev/config |
| R-12 | env zod-модуль, `parse({})` не бросает; `.env.example` 0600 | 001-2 | Phase 2 | dev |
| R-13 | `.gitignore` исключает `.env`/`.env.*` (верификация) | 001-4 | verify | verification-only |
| R-14 | `.gitignore` исключает state/`*.db`/`*.sqlite*` (верификация) | 001-4 | verify | verification-only |
| R-15 | Scope-guard: нет adapter/cache/DB/scheduler/HTTP-кода | 001-4 | cross-cut | verification-only |

**Exit-критерии ROADMAP/TASK §5 → задачи:**
`onchain_ping` по stdio из Claude Code → R-9, R-10 (001-2) + E2E (001-3);
CI зелёный (lint+typecheck+test, Node 22) → R-3…R-8 (001-1/2/3/4);
ADR подписан → R-1 (001-4);
ARCHITECTURE.md + TASK.md → R-2 (001-4);
секреты/состояние не протекают → R-11 (001-1), R-12 (001-2), R-13/R-14 (001-4);
не расширен скоуп → R-15 (001-4).

---

## 4. Итоговая проверка плана (Definition of Done для M0)

Локально (без сети/секретов, порядок как в CI):
```bash
corepack enable pnpm            # или: npm i -g pnpm
pnpm install --frozen-lockfile  # lockfile закоммичен
pnpm lint
pnpm format:check
pnpm typecheck                  # tsc --noEmit — 0 ошибок
pnpm test                       # vitest run — unit + stdio E2E зелёные
pnpm build                      # tsup — dist/ (после test)
```
Ручная проверка exit-критерия: подключить `packages/mcp-server` в Claude Code как локальный stdio
MCP-сервер → `onchain_ping` виден в списке tools → вызов возвращает
`{ ok: true, service: "onchain-intel-mcp-server", version: "0.1.0", ts: <epoch-ms> }`.

Финальный гейт (только по команде оркестратора): commit + push в
`MatrixFounder/onchain-analytics` → GitHub Actions зелёный (Node v22.x.x в логе).
