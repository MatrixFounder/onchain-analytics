# Task 001-1 — Монорепо + toolchain scaffold

| Поле                    | Значение                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-001 `m0-discovery-skeleton`](../TASK.md)                                         |
| **Тип**                 | Config / setup (single-phase — по decision-tree конфигурация не делится на stub/logic) |
| **R-IDs**               | **R-3**, **R-5**, **R-11**                                                             |
| **Зависимости**         | нет (корневой scaffold)                                                                |
| **Разблокирует**        | 001-2, 001-4                                                                           |

## Цель

Поднять каркас pnpm-монорепо и общий toolchain (TS strict-конфиг, ESLint/Prettier, vitest-раннер,
tsup/tsx), лицензию Apache-2.0 и `.env.example`. Кода приложения здесь нет — только корневые
конфиги и манифесты, на которые опираются все последующие задачи. Раскладка строго по
[ARCHITECTURE.md §6.4](../ARCHITECTURE.md).

## Контекст: файлы, которые создаются

- `pnpm-workspace.yaml` — `packages: ["packages/*"]`.
- `package.json` (root) — `private: true`, `"license": "Apache-2.0"`, `engines.node: ">=22"`,
  scripts делегируют в пакеты: `lint`/`format:check`/`typecheck`/`test`/`build` → `pnpm -r <script>`.
- `tsconfig.base.json` — `strict: true`, `noUncheckedIndexedAccess: true`, `module`/
  `moduleResolution: NodeNext`, `target: ES2023`, `skipLibCheck`, `esModuleInterop`, `declaration`.
- ESLint flat config (`eslint.config.js`) + `.prettierrc` — разделяемые из корня.
- Корневой vitest-конфиг (или per-package в 001-3) — раннер объявлен, тестов пока может не быть.
- `LICENSE` — полный текст Apache License 2.0.
- `.env.example` — комментарий про права `0600` для будущих секретов (D10), **значений нет**.
- `packages/mcp-server/package.json` — `name: "@onchain-intel/mcp-server"`, `version: "0.1.0"`,
  `private: true`, `"license": "Apache-2.0"`, `type: "module"`, `engines.node: ">=22"`,
  `bin: { "onchain-intel-mcp-server": "dist/index.js" }`, scripts (`build: tsup`, `dev: tsx
src/index.ts`, `lint: eslint .`, `format:check: prettier --check .`, `typecheck: tsc --noEmit`,
  `test: vitest run`).
- `packages/mcp-server/tsconfig.json` — `extends: "../../tsconfig.base.json"`.
- `packages/mcp-server/tsup.config.ts` — `entry: src/index.ts`, `format: esm`, `target: node22`.

## Шаги

1. Включить pnpm: `corepack enable pnpm` (fallback `npm i -g pnpm`). Зафиксировать версию pnpm в
   `packageManager` корневого `package.json`.
2. Создать корневые манифесты и конфиги (список выше).
3. Установить зависимости через `pnpm add` (в `packages/mcp-server`), чтобы **реальные пиннутые
   версии** попали в `package.json` вместо плейсхолдеров `"^*"` из ARCHITECTURE §6.4 (reviewer-нота
   2). Минимум: runtime — `@modelcontextprotocol/sdk`, `zod`; dev — `typescript`, `tsup`, `tsx`,
   `vitest`, `eslint`, `prettier` (+ eslint/ts-плагины по необходимости). Lockfile
   (`pnpm-lock.yaml`) коммитится (коммит — в 001-4, только по команде оркестратора).
4. Создать пустой каркас `packages/mcp-server/src/` не требуется здесь — src-файлы создаёт 001-2;
   этой задаче достаточно, чтобы `pnpm install` и `pnpm lint`/`format:check` проходили на текущем
   наборе (lint по `packages/**/*.ts` на пустом наборе проходит тривиально).

## Stub-First

Single-phase config-задача (по `planning-decision-tree` §1: setup → одна задача). Стабов нет; «зелёное»
состояние = установка и корневые скрипты проходят.

## Acceptance (команды)

```bash
corepack enable pnpm || npm i -g pnpm
pnpm install                 # 0 ошибок; создан pnpm-lock.yaml
node -e "require('./packages/mcp-server/package.json').engines.node"   # => ">=22"
pnpm lint                    # 0 ошибок (пустой/минимальный набор ts)
pnpm format:check            # 0 ошибок
grep -q 'Apache License' LICENSE && echo LICENSE-ok
grep -q '"license": "Apache-2.0"' package.json packages/mcp-server/package.json && echo license-fields-ok
grep -qi '0600' .env.example && echo envexample-ok
```

- **[R-3]** `pnpm install` без ошибок; `packages/mcp-server/package.json` объявляет `engines.node
">=22"`; ни одного `"^*"`-плейсхолдера не осталось (реальные версии + lockfile).
- **[R-5]** `pnpm lint` и `pnpm format:check` проходят; конфиги ESLint и Prettier присутствуют.
- **[R-11]** `LICENSE` = полный Apache-2.0; `license`-поле = `"Apache-2.0"` в обоих `package.json`.

## Явно вне рамок (scope-guard R-15)

Никаких `src/`-модулей приложения (это 001-2), никакого CI (001-4), никакого adapter/cache/DB/
scheduler/HTTP-кода. Никаких доп. пакетов монорепо (`core`/`adapters`/`signals`/`cli`).
