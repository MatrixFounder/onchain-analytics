# Task 001-2 — MCP-скелет + env-модуль + `onchain_ping`

| Поле                    | Значение                                               |
| ----------------------- | ------------------------------------------------------ |
| **Родительская задача** | [TASK-001 `m0-discovery-skeleton`](../TASK.md)         |
| **Тип**                 | Dev (Stub-First: Phase 1 стабы → Phase 2 логика)       |
| **R-IDs**               | **R-4**, **R-9**, **R-10**, **R-12**                   |
| **Зависимости**         | 001-1 (workspace, tsconfig, установленные зависимости) |
| **Разблокирует**        | 001-3                                                  |

## Цель

Реализовать единственный пакет M0 — `@onchain-intel/mcp-server`: скелет MCP-сервера на официальном
`@modelcontextprotocol/sdk` **только на stdio**, env-модуль на zod (валидирует пустой env) и
dummy-tool `onchain_ping` с zod как единственным источником правды. Строго по
[ARCHITECTURE.md §3.2, §5.2, §4.1](../ARCHITECTURE.md).

## Контекст: файлы `packages/mcp-server/src/`

- `index.ts` — bin-entry. **Единственное** место, монтирующее `StdioServerTransport`. Читает
  `version` из `package.json` один раз, вызывает `loadEnv()`, `createServer({ env, version })`,
  `server.connect(new StdioServerTransport())`.
- `server.ts` — `createServer(deps: { env, version }): McpServer` — transport-agnostic фабрика
  (D3): создаёт сервер + регистрирует tools, транспорт **не** создаёт.
- `env.ts` — `EnvSchema` (zod, все поля optional в M0), `loadEnv(raw?): Env` (fail-fast).
- `tools/ping.ts` — `PingInputSchema`, `PingOutputSchema`, `pingHandler(input, ctx: { version })`
  (pure), `registerPingTool(server, ctx: { version })`.

## Reviewer-заметки (обязательно применить)

- **`version` прокидывается явно** (нота 1): `createServer({ env, version })`,
  `registerPingTool(server, { version })`, `pingHandler(input, { version })`. Не хардкодить версию
  строкой в коде — читать из `package.json` в `index.ts`.
- **`PingOutput = { ok: literal true, service: 'onchain-intel-mcp-server', version: string,
ts: number }`** (нота 3) — намеренно богаче необязательного примера R-10.
- **Имя SDK-метода** регистрации tool (`server.tool()` vs `server.registerTool()`) зависит от
  версии SDK — не хардкодить из головы: сверить по установленному `@modelcontextprotocol/sdk`
  (ARCHITECTURE §11, «vendor drift»). Схема zod передаётся так, чтобы служить и рантайм-валидацией,
  и источником MCP tool-schema (без ручного дублирования JSON-Schema).
- **stdout-дисциплина** (ARCHITECTURE §7.3): в stdout — только MCP-протокол; любой диагностический
  вывод → `stderr`. Нарушение ломает JSON-RPC framing и естественно фейлит E2E из 001-3.

## Phase 1 — Структура и стабы `[STUB CREATION]`

Создать все четыре `src/`-файла с полными сигнатурами и стаб-телами:

- `env.ts`: `EnvSchema` объявлена (пусть даже пустой `z.object({}).partial()` для старта);
  `loadEnv` возвращает `EnvSchema.parse(raw ?? process.env)`.
- `tools/ping.ts`: `PingInputSchema = z.object({}).strict()`; `PingOutputSchema` с четырьмя полями;
  `pingHandler` — стаб, возвращающий детерминированную форму `{ ok: true, service: '...',
version: ctx.version, ts: Date.now() }`; `registerPingTool` — стаб-тело (может быть пустым/TODO).
- `server.ts`: `createServer` возвращает инстанс `McpServer` (без регистрации tools — TODO).
- `index.ts`: минимальный wiring-скелет (может быть без реального `connect`, но импортируемо).
- **Verification Phase 1:** `pnpm typecheck` (`tsc --noEmit`) — 0 ошибок; все модули импортируются
  (`tsx -e "import('./packages/mcp-server/src/server.ts')"` без ошибок трансформации).

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

- `env.ts`: финализировать `EnvSchema` (все поля optional; например `LOG_LEVEL?`), `loadEnv`
  fail-fast с понятным сообщением в stderr на невалидном значении.
- `tools/ping.ts`: `pingHandler` возвращает валидируемый `PingOutputSchema.parse(...)`;
  `registerPingTool` регистрирует инструмент **ровно** `onchain_ping`, передавая zod-схему как
  источник tool-schema.
- `server.ts`: `createServer` вызывает `registerPingTool(server, { version })`.
- `index.ts`: `loadEnv()` → `createServer({ env, version })` →
  `server.connect(new StdioServerTransport())`; диагностика только в stderr.
- **Никакого** HTTP/SSE/Streamable-транспорта, adapter/cache/DB/scheduler-кода (R-15).

## Acceptance (команды)

```bash
pnpm typecheck                 # tsc --noEmit — 0 ошибок (R-4)
pnpm build                     # tsup собирает packages/mcp-server/dist/ (R-4)
timeout 3 pnpm --filter @onchain-intel/mcp-server dev </dev/null   # tsx стартует, ждёт stdin (R-4/R-9)
grep -R --include='*.ts' -nE 'Streamable|SSEServerTransport|http\.createServer|express' packages/mcp-server/src && echo "FAIL: HTTP found" || echo "stdio-only-ok"  # R-9
grep -Rn "onchain_ping" packages/mcp-server/src/tools/ping.ts   # R-10 — точное имя
```

- **[R-4]** оба strict-флага в `tsconfig.base.json`; `tsc --noEmit` 0 ошибок; `tsup` собирает
  `dist/`; `tsx` стартует dev-entry без ошибок трансформации.
- **[R-9]** `Server` из SDK + `StdioServerTransport`; grep не находит HTTP/SSE-обвязки.
- **[R-10]** инструмент = `onchain_ping`; input/output — zod, единый источник правды; ответ
  детерминирован по форме `{ ok, service, version, ts }`.
- **[R-12]** `EnvSchema.parse({})` не бросает (полная проверка — unit-тестом в 001-3); `loadEnv`
  fail-fast.

> Полная проверка «`onchain_ping` отвечает по stdio» и «`parse({})` не бросает» выполняется
> автотестами в **001-3** (unit + stdio E2E) — здесь достаточно, что модули собираются, стартуют и
> экспортируют нужные сигнатуры.
