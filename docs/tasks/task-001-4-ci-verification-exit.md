# Task 001-4 — CI-гейт + verification-only + M0 exit-criteria

| Поле | Значение |
|---|---|
| **Родительская задача** | [TASK-001 `m0-discovery-skeleton`](../TASK.md) |
| **Тип** | Config + verification (single-phase) |
| **R-IDs** | **R-7**, **R-8** (CI) · **R-1**, **R-2**, **R-13**, **R-14** (verification-only) · **R-15** (scope-guard) |
| **Зависимости** | 001-3 (локально зелёный сьют), 001-1 (корневые скрипты для CI) |
| **Разблокирует** | финальный M0 exit + commit-гейт |

## Цель
Добавить CI-гейт GitHub Actions (lint + typecheck + test на Node 22) и закрыть все
verification-only пункты (R-1, R-2, R-13, R-14) + сквозной scope-guard (R-15). Затем — финальная
проверка exit-критериев M0. Строго по [ARCHITECTURE.md §10.2](../ARCHITECTURE.md).

## Контекст: файлы
- `.github/workflows/ci.yml` — единственный workflow. Триггеры `push` + `pull_request`. Шаги
  (порядок из ARCHITECTURE §10.2; `test` **до** `build`, нота 4):
  ```
  checkout → corepack enable (pnpm) → actions/setup-node node-version '22' (cache pnpm)
    → pnpm install --frozen-lockfile
    → pnpm lint → pnpm format:check → pnpm typecheck → pnpm test → pnpm build
  ```
  Всё без сети/секретов (пустой env валиден — R-12; платных ключей нет — R-15).

## CI (R-7, R-8)
- **[R-7]** `.github/workflows/ci.yml` существует, триггеры `push`/`pull_request`, содержит шаги
  lint + typecheck + test.
- **[R-8]** `actions/setup-node` пиннит `node-version: '22'` (или `'22.x'`/LTS-алиас 22-й линии).

## Verification-only (правок в код/конфиги не вносить, если проверка прошла)
- **[R-1]** ADR-001 = Accepted. Проверить заголовок:
  ```bash
  grep -nE 'Статус:\**\s*Accepted' docs/onchain-analytics/ADR-001-tech-stack.md
  grep -n 'Accepted:.*2026-07-20.*Sergey' docs/onchain-analytics/ADR-001-tech-stack.md
  ```
  В ADR ничего не менять; факт уже отражён ссылками в TASK.md/ARCHITECTURE.md.
- **[R-2]** `docs/ARCHITECTURE.md` и `docs/TASK.md` существуют (продукт этого прогона), ARCHITECTURE
  ссылается на TASK-001 и ADR-001:
  ```bash
  test -f docs/ARCHITECTURE.md && test -f docs/TASK.md && echo files-ok
  grep -n 'TASK.md' docs/ARCHITECTURE.md && grep -n 'ADR-001' docs/ARCHITECTURE.md
  ```
- **[R-13]** `.gitignore` исключает `.env`/`.env.*`, оставляя `!.env.example`:
  ```bash
  grep -nE '^\.env$|^\.env\.\*$|^!\.env\.example$' .gitignore
  ```
  Правок не вносить, если строки на месте (ожидаемо ~47–50).
- **[R-14]** `.gitignore` исключает state/`*.db`/`*.sqlite*`/WAL:
  ```bash
  grep -nE '/DATA_DIR/|\*\.db|\*\.sqlite|\*-wal|\*-shm' .gitignore
  ```
  M0 не добавляет БД-кода и артефактов состояния.

## Scope-guard (R-15) — сквозная проверка
- **[R-15]** Ревью diff'а всей ветки M0: изменения ограничены — корневые манифесты монорепо,
  `packages/mcp-server` (сервер + `onchain_ping` + env), `.github/workflows/ci.yml`,
  lint/format/test-конфиги, `LICENSE`, `.env.example`. Ни строки adapter/provider/cache/scheduler/
  DB-migration/HTTP-транспорт кода:
  ```bash
  # структурный guard: в src нет HTTP/провайдер/DB-паттернов
  ! grep -RniE 'Streamable|SSEServerTransport|drizzle|better-sqlite3|croner|nansen|dune|coingecko|providers\.config' packages/mcp-server/src
  # изменения не выходят за разрешённые пути
  git status --porcelain | grep -vE '^\?\?|(^|/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig|eslint|\.prettierrc|LICENSE|\.env\.example|\.github/workflows/ci\.yml|packages/mcp-server/|docs/)' && echo "REVIEW: unexpected path" || echo scope-ok
  ```

## Финальный гейт — M0 exit-criteria
Локально (порядок как в CI, без сети/секретов):
```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```
Ручная проверка: подключить `packages/mcp-server` в Claude Code как stdio MCP-сервер → `onchain_ping`
в списке tools → вызов возвращает
`{ ok: true, service: "onchain-intel-mcp-server", version: "0.1.0", ts: <epoch-ms> }`.

**Коммит/пуш — ТОЛЬКО по явной команде оркестратора** (dev-задачи ничего не коммитят). После
разрешения: commit + push в `MatrixFounder/onchain-analytics` → прогон GitHub Actions зелёный, в
логе видно `Node v22.x.x` (закрывает акцептанс R-7/R-8 на remote).

## Acceptance (сводно)
- **[R-7]/[R-8]** workflow присутствует, корректные триггеры и Node-22 пин; на remote (после
  разрешённого пуша) джобы lint+typecheck+test зелёные.
- **[R-1]/[R-2]/[R-13]/[R-14]** grep-проверки выше проходят; никаких новых правок в ADR/.gitignore.
- **[R-15]** scope-guard grep'ы проходят; diff в разрешённых путях.
