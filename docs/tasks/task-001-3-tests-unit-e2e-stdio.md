# Task 001-3 — Тесты: unit + stdio E2E

| Поле | Значение |
|---|---|
| **Родительская задача** | [TASK-001 `m0-discovery-skeleton`](../TASK.md) |
| **Тип** | Dev / test (Stub-First: Phase 1 red → Phase 2 green) |
| **R-IDs** | **R-6** (плюс делает проверяемыми R-9, R-10, R-12) |
| **Зависимости** | 001-2 (src-модули существуют и импортируются; `src/index.ts` монтирует транспорт) |
| **Разблокирует** | 001-4 |

## Цель
Сделать exit-критерий M0 «`onchain_ping` отвечает по stdio» **проверяемым в CI**, а не вручную.
Поставить три теста в `packages/mcp-server/test/` по [ARCHITECTURE.md §3.2 «Тест-сьют», §10.2](../ARCHITECTURE.md).
**Автоматизированный stdio E2E обязателен** (reviewer-нота 5).

## Контекст: файлы `packages/mcp-server/test/`
- `env.test.ts` — unit: `EnvSchema.parse({})` **не бросает** (закрывает контракт R-12); граничный
  кейс — невалидное значение падает с понятной ошибкой.
- `ping.test.ts` — unit: прямой вызов `pingHandler(input, { version })` (без поднятия сервера);
  `PingOutputSchema.parse(result)` проходит; `result.ok === true`,
  `result.service === 'onchain-intel-mcp-server'`, `typeof result.ts === 'number'`,
  `result.version === '<version из ctx>'`.
- `e2e.stdio.test.ts` — **E2E**: спавнит `src/index.ts` дочерним процессом через `tsx` (не `dist/`
  — порядок CI `test` → `build`, нота 4), подключает SDK-шные `Client` + `StdioClientTransport`,
  вызывает `tools/list` (ожидает `onchain_ping` в списке) и `tools/call onchain_ping`, проверяет
  форму ответа, затем закрывает транспорт / убивает процесс.

## Reviewer-заметки (обязательно)
- **E2E-детерминизм по форме, не по значению** (нота 3): `ts` — это `Date.now()`, проверять как
  `number`, не на равенство; `ok`/`service`/`version` — точные литералы/строка.
- **E2E — регресс-guard stdout-дисциплины** (ARCHITECTURE §7.3): если что-то пишет мусор в stdout,
  JSON-RPC framing ломается и тест падает/виснет → предусмотреть таймаут на E2E, чтобы «зависание»
  превращалось в явный fail.

## Phase 1 — Тесты (red / против стабов)  `[STUB CREATION]`
Написать все три файла. Если 001-2 Phase 2 ещё не финализирована — тесты идут **red** (это ожидаемо
по TDD). E2E-харнесс (спавн `tsx src/index.ts` + `Client`/`StdioClientTransport` + таймаут + teardown)
пишется здесь.
- **Verification Phase 1:** `pnpm test` запускается (vitest стартует), падающие тесты указывают на
  недостающую логику — не на ошибки харнесса.

## Phase 2 — Зелёный сьют  `[LOGIC IMPLEMENTATION]`
На реализованной логике 001-2 весь сьют зелёный:
- `env.test.ts` зелёный (`parse({})` не бросает).
- `ping.test.ts` зелёный (форма/литералы/`PingOutputSchema.parse`).
- `e2e.stdio.test.ts` зелёный (`onchain_ping` в `tools/list`; `tools/call` → валидная форма;
  транспорт корректно закрывается, дочерний процесс убит).

## Acceptance (команды)
```bash
pnpm test                      # vitest run — все тесты зелёные (R-6)
pnpm --filter @onchain-intel/mcp-server test -- --reporter=verbose | grep -Ei 'e2e|stdio'  # виден E2E
```
- **[R-6]** `pnpm test` запускает vitest, ≥1 зелёный тест; фактически — три файла (unit env, unit
  ping, stdio E2E), все зелёные. E2E подтверждает R-9 (коннект по stdio) и R-10 (`onchain_ping`
  отвечает валидной формой); `env.test.ts` подтверждает R-12 (`parse({})`).

## Явно вне рамок (R-15)
Никаких сетевых/интеграционных тестов против провайдеров (их нет в M0), никаких fixtures/Polly.js
(D11 — это M1+). Только локальный in-process/child-process сьют без сети и секретов.
