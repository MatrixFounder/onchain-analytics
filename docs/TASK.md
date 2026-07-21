# TASK-001 — M0: Discovery & каркас (`onchain-intel`)

## 0. Мета-информация

| Поле                       | Значение                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **ID**                     | TASK-001                                                                                                                 |
| **Slug**                   | `m0-discovery-skeleton`                                                                                                  |
| **Дата создания**          | 2026-07-21                                                                                                               |
| **Статус**                 | Draft (готов к Architecture-фазе)                                                                                        |
| **Источник задачи**        | Пользователь → «выполни M0 блок задач из `docs/onchain-analytics/ROADMAP.md`»                                            |
| **Roadmap-ref**            | [ROADMAP.md](onchain-analytics/ROADMAP.md) §«M0 — Discovery & каркас»                                                    |
| **ADR-ref**                | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md), решения D1–D3, D10–D12 (Accepted, sign-off 2026-07-20) |
| **Целевой репозиторий CI** | `github.com/MatrixFounder/onchain-analytics`                                                                             |

---

## 1. Контекст и цель

`onchain-intel` — движок ончейн-аналитики (провайдер-адаптеры → нормализация → кеш/бюджет →
snapshotter/signals → собственный агрегирующий MCP-сервер). Стек уже зафиксирован в
**ADR-001 (Accepted 2026-07-20)** — 12 решений D1–D12, Open Questions закрыты sign-off'ом. M0 —
это не «придумать стек», а **поднять минимальный работающий скелет** под уже принятые решения:
pnpm-монорепо, TS strict, MCP-сервер с одним dummy-tool на stdio, CI-гейт, каркас секретов.

**Важно (установленные факты, не пересматриваются в этой задаче):**

1. ADR-001 уже **Accepted** (sign-off 2026-07-20, Sergey). Пункт M0 «Принять ADR-001» в этой
   задаче — только **верификация** статуса (R-1), не новая работа.
2. Мини-снапшоттер Dash Platform (pre-M0, вне гейта sign-off) **уже поставлен** — n8n-workflows +
   Supabase Postgres в dev VM, закоммичено. Это отдельная, уже готовая система → **вне рамок**
   этой задачи (см. §3).
3. Пункт M0 «`docs/ARCHITECTURE.md` + `docs/TASK.md` через agentic-пайплайн» закрывается **этим
   самым прогоном пайплайна** (данный `docs/TASK.md` + `docs/ARCHITECTURE.md`, который создаст
   Architect-фаза) — это не отдельная инженерная работа, а сам факт прохождения Analysis/Architecture
   фаз (R-2).
4. Реальный инженерный объём этой задачи — пункты ниже: pnpm-монорепо, ESLint/Prettier/vitest,
   CI, MCP-скелет с `onchain_ping`, каркас секретов.

**Раскладка монорепо (предложение Analyst, минимальное по D12):** ADR-001 §D12 описывает
**целевую** (будущую) раскладку `packages/{core,adapters,mcp-server,signals,cli}`, но явно
разрешает начать «одним пакетом и резать по швам по мере роста». Anti-goals ROADMAP запрещают
изобретать пакеты сверх скоупа M0 (нет DB-слоя, кеша, планировщика, провайдеров в M0). Поэтому
M0 поднимает **один пакет** — `packages/mcp-server/` (сам MCP-сервер + его env-модуль + dummy-tool)
— плюс корневые конфиги монорепо (`pnpm-workspace.yaml`, root `package.json`, общий
`tsconfig.base.json`, ESLint/Prettier/CI). Остальные пакеты (`core`, `adapters`, `signals`, `cli`)
появляются в M1+ по мере роста функциональности.

---

## 2. В рамках задачи (In Scope)

- Верификация статуса ADR-001 = Accepted (без новой работы над стеком).
- `docs/ARCHITECTURE.md` + `docs/TASK.md` как продукт agentic-пайплайна (этот прогон).
- pnpm-монорепо: `pnpm-workspace.yaml`, корневой `package.json`, `packages/mcp-server/`.
- TypeScript strict (`strict: true`, `noUncheckedIndexedAccess: true`), сборка через **tsup**,
  dev-запуск через **tsx**; `engines.node >= 22` (D1/D2; локальная машина на Node v24 — это ок,
  `engines` лишь декларирует минимальную версию).
- ESLint + Prettier, настроенные с lint/format-скриптами.
- **vitest** как test runner, минимум один зелёный тест.
- CI-гейт: GitHub Actions workflow в существующем remote (`MatrixFounder/onchain-analytics`),
  запускающий lint + typecheck + test на push/PR, на **Node 22**.
- Скелет MCP-сервера на официальном `@modelcontextprotocol/sdk`, **только stdio-транспорт**
  (D3: «stdio-first под Claude Code» уже принято; публичный HTTP — позже).
- Один dummy-tool `onchain_ping` (workflow-ориентированное имя, `onchain_*`), схема — **zod**
  (единый источник правды: валидация ↔ MCP-схема, D3/D5).
- Лицензия пакета(ов) — **Apache-2.0** (D12).
- Каркас секретов: `.env.example` (документирующий конвенцию 0600, D10) + zod-модуль валидации
  env, который **успешно валидирует пустой env** (в M0 нет обязательных секретов — «лестница
  затрат» ROADMAP: M0–M1 = $0, ключи не нужны).

## 3. Вне рамок (Out of Scope) — явно

- **Snapshotter Dash Platform** — уже поставлен (n8n + Supabase Postgres в dev VM), не трогаем.
- **Провайдер-адаптеры** (Nansen / Dune / CoinGecko / DexScreener / Bitquery / DAPI / …) — M1+ (D4).
- **Кеш** (SQLite + LRU, TTL по типам, credit-budget guard) — M1/M2 (D6).
- **БД/состояние приложения** (watchlists, job-log, `drizzle-orm`-миграции, схема `onchain`) — M1+ (D7).
  М0 не создаёт никакого DB-кода; конвенция `DATA_DIR` уже покрыта `.gitignore` — только верификация.
- **Планировщик** (`croner` in-process или n8n на выделенном сервере) — M1+ (D8).
- **Платные ключи/провайдеры** (Nansen $49, Bitquery Commercial и т.п.) — M2+; в M0 бюджет $0.
- **Публичный HTTP/Streamable-HTTP MCP-транспорт** — позже, за абстракцией транспорта (D3/D12);
  M0 — только stdio.
- Любые дополнительные пакеты монорепо сверх `packages/mcp-server` (`core`, `adapters`, `signals`,
  `cli`) — вводятся в M1+ по мере роста, не сейчас (anti-goal ROADMAP).

---

## 4. Requirements Traceability Matrix (RTM)

| ID   | Requirement                                                                                                                                                                             | Priority | Acceptance Criteria / Verification                                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | Верифицировать, что ADR-001 имеет статус **Accepted** (sign-off 2026-07-20, Sergey); новой работы над стеком не требуется.                                                              | Must     | Заголовок `docs/onchain-analytics/ADR-001-tech-stack.md` содержит `Статус: Accepted`, `Accepted: 2026-07-20 (Sergey)`; факт зафиксирован ссылкой в `docs/TASK.md`/`docs/ARCHITECTURE.md`, никаких правок в ADR не вносится.                                                                                                           |
| R-2  | `docs/ARCHITECTURE.md` и `docs/TASK.md` для `onchain-intel` созданы через agentic-пайплайн (Analysis+Architecture фазы этого прогона).                                                  | Must     | После Architecture-фазы `docs/ARCHITECTURE.md` существует, ссылается на данный TASK.md и на ADR-001 (D1–D12); это НЕ отдельная задача разработки, а результат самого прогона.                                                                                                                                                         |
| R-3  | pnpm-монорепо: `pnpm-workspace.yaml` + корневой `package.json` + пакет `packages/mcp-server/` с `engines.node >= 22`.                                                                   | Must     | `pnpm install` в корне репозитория завершается без ошибок; `packages/mcp-server/package.json` присутствует и объявляет `engines.node: ">=22"`.                                                                                                                                                                                        |
| R-4  | TypeScript strict-конфиг (`strict: true`, `noUncheckedIndexedAccess: true`), сборка `tsup`, dev-запуск `tsx`.                                                                           | Must     | Общий `tsconfig.base.json` (или per-package `tsconfig.json`) содержит оба флага; typecheck-скрипт (`tsc --noEmit`) проходит с 0 ошибок на скелете; `tsup` собирает `dist/`; `tsx` запускает dev-entry без ошибок трансформации.                                                                                                       |
| R-5  | ESLint + Prettier настроены, есть lint/format-скрипты.                                                                                                                                  | Must     | `pnpm lint` проходит с 0 ошибками по `packages/**/*.ts`; конфиг Prettier присутствует, `pnpm format:check` (или эквивалент) проходит.                                                                                                                                                                                                 |
| R-6  | **vitest** — test runner, минимум один зелёный тест.                                                                                                                                    | Must     | `pnpm test` запускает vitest; минимум 1 тест (например, контракт zod-схемы `onchain_ping` или sanity-тест env-модуля) проходит зелёным.                                                                                                                                                                                               |
| R-7  | CI-гейт: GitHub Actions workflow в `MatrixFounder/onchain-analytics`, запускает lint + typecheck + test на push/PR.                                                                     | Must     | `.github/workflows/ci.yml` существует, триггеры `push`/`pull_request`; прогон на remote показывает зелёные джобы lint+typecheck+test.                                                                                                                                                                                                 |
| R-8  | CI выполняется на **Node 22** (соответствие D1 — Node 22 LTS цель, даже если локальная машина использует более новую версию).                                                           | Must     | Шаг `actions/setup-node` в workflow пиннит `node-version: '22'` (или `'22.x'`/LTS-алиас, разрешающий 22-ю линию); в логе CI видно `Node v22.x.x`.                                                                                                                                                                                     |
| R-9  | Скелет MCP-сервера на официальном `@modelcontextprotocol/sdk`, **только stdio-транспорт** (без HTTP/SSE-кода в M0).                                                                     | Must     | `packages/mcp-server` создаёт `Server` из SDK и подключает `StdioServerTransport`; ручной запуск (`tsx`/`node dist/index.js`) под stdio MCP-клиентом (Claude Code / MCP inspector) успешно коннектится; в коде отсутствует какая-либо HTTP/Streamable-транспортная обвязка.                                                           |
| R-10 | Dummy-tool `onchain_ping` зарегистрирован, workflow-ориентированное имя (`onchain_*`, D3), input/output-схема — **zod** как единственный источник правды (валидация ↔ MCP tool-schema). | Must     | Инструмент называется ровно `onchain_ping`; input- и output-схемы объявлены через zod и используются и для рантайм-валидации, и для генерации MCP tool-schema (без дублирования вручную); вызов из Claude Code по stdio возвращает детерминированный ответ (например, `{ pong: true, ts: <epoch-ms> }`).                              |
| R-11 | Лицензия — **Apache-2.0** (D12).                                                                                                                                                        | Must     | Корневой `LICENSE`-файл содержит полный текст Apache License 2.0; корневой `package.json` и `packages/mcp-server/package.json` указывают `"license": "Apache-2.0"`.                                                                                                                                                                   |
| R-12 | Каркас секретов: zod-модуль валидации env, успешно валидирующий **пустой env** (в M0 нет обязательных секретов); `.env.example` документирует конвенцию 0600 (D10).                     | Must     | Env-модуль (например `packages/mcp-server/src/env.ts`) парсит `process.env` через zod-схему при старте; юнит-тест подтверждает, что схема успешно парсит `{}` (пустой объект) — обязательных ключей в M0 нет (лестница затрат: M0–M1 = $0); `.env.example` присутствует и содержит комментарий про права `0600` для будущих секретов. |
| R-13 | Верификация: `.env`/`.env.*` уже исключены из git (D10) — секреты никогда не коммитятся.                                                                                                | Should   | `.gitignore` уже содержит `.env`, `.env.*`, `!.env.example` (подтверждено, строки 47–50 текущего `.gitignore`) — задача только проверяет это, новых правок `.gitignore` не требуется, если не найден пробел.                                                                                                                          |
| R-14 | Верификация: артефакты состояния (`DATA_DIR`, `*.db`/`*.sqlite*`) уже исключены из git — в M0 нет DB-кода, поэтому это чисто проверочный пункт.                                         | Should   | `.gitignore` уже содержит `/DATA_DIR/`, `*.db`, `*.sqlite`, `*.sqlite3`, `*-wal`, `*-shm` (подтверждено, строки 61–67 текущего `.gitignore`); M0 не добавляет БД-код и не создаёт новых артефактов состояния.                                                                                                                         |
| R-15 | Guard от scope creep: diff этой задачи не должен содержать код адаптеров/кеша/БД/планировщика/платных ключей/HTTP-транспорта.                                                           | Should   | Ревью PR подтверждает, что изменения ограничены: корневые манифесты монорепо, `packages/mcp-server` (сервер + `onchain_ping` + env-модуль), CI workflow, lint/format/test-конфиги, `LICENSE`, `.env.example` — без единой строки adapter/provider/cache/scheduler/DB-migration кода.                                                  |

---

## 5. Acceptance / Exit Criteria (из ROADMAP §M0)

Дословные exit-критерии ROADMAP: «`onchain_ping` отвечает из Claude Code (stdio); CI зелёный; ADR
подписан» — плюс пункт задач «`docs/ARCHITECTURE.md` + `docs/TASK.md` через agentic-пайплайн»,
трассируемый отдельно.

| Exit-критерий (ROADMAP)                                        | Трассировка на требования            |
| -------------------------------------------------------------- | ------------------------------------ |
| `onchain_ping` отвечает из Claude Code по stdio                | R-9, R-10                            |
| CI зелёный (lint + typecheck + test, Node 22)                  | R-3, R-4, R-5, R-6, R-7, R-8         |
| ADR подписан                                                   | R-1 (уже верно — только верификация) |
| `docs/ARCHITECTURE.md` + `docs/TASK.md` через agentic-пайплайн | R-2 (продукт этого прогона)          |
| Секреты/состояние не протекают в репозиторий                   | R-11, R-12, R-13, R-14               |
| Не расширен скоуп сверх M0                                     | R-15                                 |

---

## 6. Use Cases

### UC-1: Разработчик поднимает окружение с нуля

- **Main flow:** клонирует репозиторий → `pnpm install` в корне → `pnpm -w build` (tsup) →
  `pnpm -w lint` → `pnpm -w test` (vitest) — всё зелёное без сети/секретов.
- **Alt flow (нет `.env`):** env-модуль стартует и валидируется на пустом окружении (R-12) —
  разработчику не нужно создавать `.env`, чтобы поднять скелет в M0.

### UC-2: Claude Code вызывает `onchain_ping` по stdio

- **Main flow:** Claude Code запускает `packages/mcp-server` как локальный stdio MCP-сервер →
  список tools содержит `onchain_ping` → вызов возвращает детерминированный ответ, tool-schema
  сгенерирована из той же zod-схемы, что валидирует вход/выход в рантайме.
- **Alt flow:** невалидный вход в `onchain_ping` (если инструмент принимает параметры) —
  отклоняется zod-валидацией до бизнес-логики, ошибка возвращается по MCP-протоколу, а не падением
  процесса.

### UC-3: PR триггерит CI

- **Main flow:** push/PR в `MatrixFounder/onchain-analytics` → GitHub Actions поднимает Node 22 →
  `pnpm install` → lint → typecheck → test → зелёный статус.
- **Alt flow:** сломанный lint/typecheck/test → CI красный, PR блокируется мержем (гейт качества
  ROADMAP «Гейты качества на каждой границе»).

---

## 7. Open Questions

Блокирующих открытых вопросов нет — ADR-001 уже закрыл ключевые развилки (TS-core, хостинг
stdio-first, D1–D12 Accepted). Не блокирует, но фиксирую как принятое решение Analyst (не вопрос
пользователю): единственный пакет M0 — `packages/mcp-server/`; остальные пакеты целевой раскладки
D12 (`core`, `adapters`, `signals`, `cli`) сознательно не создаются в M0 (anti-goal ROADMAP —
не изобретать пакеты сверх скоупа) и появятся в M1+ по мере роста функциональности.
