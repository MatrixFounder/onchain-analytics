# TASK-002 — Синхронизация документации после M0 (`m0-docs-sync`)

## 0. Meta Information

| Поле       | Значение                                           |
| ---------- | -------------------------------------------------- |
| **ID**     | TASK-002                                           |
| **Slug**   | `m0-docs-sync`                                     |
| **Дата**   | 2026-07-22                                         |
| **Статус** | Done                                               |
| **Режим**  | `/update-docs` (04-update-docs.md), после TASK-001 |

## 1. Контекст / цель

M0 (TASK-001 `m0-discovery-skeleton`) выполнен: коммиты `07cf9f2`, `8816799`, `c81f2b8`,
`16c9ae1`; CI зелёный на GitHub; 21 тест; `onchain_ping` отвечает живым вызовом из Claude
Code (`{"ok":true,"service":"onchain-intel-mcp-server","version":"0.1.0"}`). Документация
должна быть приведена в соответствие фактическому состоянию кода.

## 2. Скоуп

- Ротация TASK-001/PLAN-001 в архивы (`docs/tasks/`, `docs/plans/`) — выполнено этим workflow.
- `docs/ARCHITECTURE.md` — точечные правки под пост-адверсариальное состояние:
  smoke-dist гейт, `tsconfig.build.json`, hardening CI (permissions / SHA-пины /
  timeout-minutes), repo-wide lint/format гейт, актуальное число тестов (21).
- `docs/onchain-analytics/ROADMAP.md` — отметить M0 выполненным (exit-критерии закрыты,
  дата, коммиты), актуализировать Now/Next.
- Проверка актуальности `.AGENTS.md` (packages/mcp-server).

## 3. Вне скоупа

Любые изменения кода; M1-работы; правки остальных SoT-доков (ADR-001, DB-SCHEMA-CONCEPT).

## 4. Requirements (RTM)

| ID  | Requirement                                                     | Acceptance Criteria                                                                                                                |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | TASK-001/PLAN-001 ротированы в архивы в lockstep                | `docs/tasks/task-001-m0-discovery-skeleton.md` + `docs/plans/plan-001-m0-discovery-skeleton.md` существуют; корневых TASK/PLAN нет |
| R-2 | ARCHITECTURE.md соответствует коду после адверсариальных фиксов | §3.2/§6.4/§10.2 упоминают smoke-dist, tsconfig.build.json, CI hardening, 21 тест                                                   |
| R-3 | ROADMAP.md отражает завершение M0                               | Секция M0 помечена выполненной с датой и evidence; Now/Next актуальны                                                              |
| R-4 | `.AGENTS.md` пакета актуален                                    | Файлы/скрипты/тесты в `.AGENTS.md` соответствуют дереву                                                                            |
