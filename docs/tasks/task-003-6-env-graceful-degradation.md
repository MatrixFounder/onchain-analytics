# Task 003-6 — расширение `EnvSchema` (4 опц. ключа) + явная graceful degradation

| Поле                    | Значение                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                                           |
| **Тип**                 | Dev (Stub-First: Phase 1 схема-стаб/тест red → Phase 2 логика/green)                                             |
| **R-IDs**               | **R-23**, **R-24**                                                                                               |
| **Зависимости**         | 003-2 (`CapabilityUnavailableError`), 003-5 (адаптеры с `isAvailable()`-reason)                                  |
| **Разблокирует**        | 003-7                                                                                                            |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §3.2 (env), §9.1, §10.3, §11; M0 `packages/mcp-server/.AGENTS.md` (env.ts) |

## Цель

Расширить `EnvSchema` четырьмя **опциональными** ключами (пустой env остаётся валидным, UC-1) и
обеспечить, что вызов способности при отсутствующем опц. ключе/DSN деградирует **явно и понятно**
(структурированная причина с указанием какого ключа не хватает, без утечки значения) — не молча, не крэш.

## Контекст: файлы

- `packages/mcp-server/src/env.ts` — расширить `EnvSchema`: `COINGECKO_API_KEY?`, `DUNE_API_KEY?`,
  `ONCHAIN_PG_URL?` (`z.string().url().optional()`), `DATA_DIR?` (`z.string().optional()`). Каждый ключ
  обёрнут в тот же `z.preprocess(v => v===''?undefined:v, ...)`-идиом, что M0 применил к `LOG_LEVEL`
  (пустая строка в shell == отсутствие ключа).
- `packages/mcp-server/test/env.test.ts` — расширить: `parse({})` не бросает; каждый новый ключ optional;
  `ONCHAIN_PG_URL` принимает реальный `postgres://…`-DSN; невалидный URL — понятная ошибка без значения.
- `packages/core` — деградация уже реализована в `isAvailable()` (003-5) и `CapabilityUnavailableError`
  (003-2); здесь — сквозная проверка (integration-тест в core или mcp-server), что отсутствие ключа/DSN
  даёт структурированную причину.

## Reviewer-заметки (обязательно применить)

- **Все 4 ключа опциональны** (R-23): `EnvSchema.parse({})` продолжает НЕ бросать (M0-контракт, R-12
  наследуется). Секреты **никогда** не логируются и **не** входят в cache-key (ARCHITECTURE §7.2).
- **`ONCHAIN_PG_URL` — `z.string().url()`** (§11 dev-time чек): подтвердить, что WHATWG URL-парсинг
  принимает реальную Supabase connection-string со спецсимволами в пароле (percent-encoded), не отклоняет.
- **Деградация — через `isAvailable()`-reason + `CapabilityUnavailableError`** (R-24): tool-handler
  ловит `CapabilityUnavailableError` → `{isError:true, content:[{type:'text', text:<reason без секрета>}]}`
  (это провязывается в 003-7; здесь фиксируем контракт причины). Причина называет **какого** ключа/DSN не
  хватает (`needs ONCHAIN_PG_URL`, `dune query authoring deferred to M2`, …), но НЕ значение.
- **`DATA_DIR`** — если задан, кеш (003-3) кладётся туда; если нет — `~/.onchain-intel` (уже в 003-3).
- **M0 env.ts-паттерн:** `loadEnv` остаётся чистой fail-fast-функцией (stderr только имена ключей на
  невалидном значении, D10), `process.exit` — в `index.ts`.

## Phase 1 — Схема-стаб + тест red `[STUB CREATION]`

1. `env.ts` — добавить 4 ключа в `EnvSchema` (декларации).
2. `env.test.ts` — добавить кейсы (red/против стабов).
3. **Verification Phase 1:** `pnpm --filter @onchain-intel/mcp-server exec tsc --noEmit` — 0 ошибок.

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. Финализировать `EnvSchema` (preprocess-обёртка на каждый ключ; `ONCHAIN_PG_URL` — `.url()`).
2. **Dev-time чек `ONCHAIN_PG_URL` (§11, runnable):**

```bash
pnpm --filter @onchain-intel/mcp-server exec tsx -e "import('zod').then(({z})=>{const s=z.string().url();for(const u of ['postgres://user:p%40ss@host:5432/db','postgresql://u:pw@127.0.0.1:5432/postgres']){const r=s.safeParse(u);console.log(u, r.success)} })"
# ожидается: обе строки → true (WHATWG URL принимает postgres://). Если false — эскалировать: заменить
# на z.string() с ручной проверкой префикса (зафиксировать решение в .AGENTS.md).
```

3. `env.test.ts` — `parse({})` не бросает; каждый ключ optional; `ONCHAIN_PG_URL` принимает валидный
   DSN, отвергает мусор с ошибкой, где НЕТ значения; секрет не логируется.
4. Интеграционный кейс деградации (в core или mcp-server): `resolve()`/tool без `ONCHAIN_PG_URL` для
   history-способности → структурированная причина `needs ONCHAIN_PG_URL` (не крэш, не `undefined`).

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/mcp-server exec vitest run test/env.test.ts     # R-23: parse({}) + optional + url
pnpm --filter @onchain-intel/mcp-server test                                 # весь mcp-server-сьют зелёный
# R-23: 4 ключа опциональны, parse({}) не бросает:
pnpm --filter @onchain-intel/mcp-server exec tsx -e "import('./src/env.ts').then(m=>{m.EnvSchema.parse({});console.log('empty-env-ok')}).catch(e=>{console.error(e);process.exit(1)})"   # tsx (не сырой node) — стрипает типы .ts
grep -nE "COINGECKO_API_KEY|DUNE_API_KEY|ONCHAIN_PG_URL|DATA_DIR" packages/mcp-server/src/env.ts   # 4 ключа
# R-24: причина называет ключ, не значение (секрет не логируется):
grep -RnE "needs ONCHAIN_PG_URL|which key|reason" packages/core/src/adapters packages/core/src/adapters/registry.ts
grep -RnE "console\.(log|error)\(.*(process\.env|API_KEY|PG_URL)" packages/core/src packages/mcp-server/src && echo "REVIEW: secret may be logged" || echo "no-secret-log-ok"
```

- **[R-23]** `EnvSchema` + 4 опц. ключа; `EnvSchema.parse({})` не бросает; секреты не логируются, не в
  cache-key.
- **[R-24]** вызов способности без нужного ключа/DSN → структурированная ошибка/предупреждение с
  указанием какого ключа не хватает, без утечки значения.

> Обязательных ключей не вводить (guard R-27 — пустой env = рабочая система, UC-1). Никаких платных
> интеграций/write-путей.
