# Task 003-7 — 4 MCP-tools + `e2e.inprocess.test.ts` (InMemoryTransport) + spawn-e2e → `tools/list===5`

| Поле                    | Значение                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                             |
| **Тип**                 | Dev (Stub-First: Phase 1 tool-стабы/e2e red → Phase 2 registry-wiring/green)                       |
| **R-IDs**               | **R-16**, **R-17**, **R-18**, **R-19**, **R-20**                                                   |
| **Зависимости**         | 003-4 + 003-5 (фикстуры для fixtureRegistry), 003-6 (env)                                          |
| **Разблокирует**        | 003-8                                                                                              |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §2.1 (MCP), §3.2 (тест-сьют F-1), §5.1/§5.2; M0 `.AGENTS.md` |

## Цель

Добавить 4 MCP-tools (`onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`,
`onchain_protocol_tvl`) — zod in/out как единственный источник правды, registry-routed; сделать
`registry` инъектируемым в `createServer`; покрыть все 4 tool целиком через **новый** in-process
E2E-сьют (`InMemoryTransport` + fixtureRegistry, 0 сети); расширить spawn-E2E до `tools/list===5` без
вызова новых tool через spawn (F-1). `onchain_ping` не трогать (R-20).

## Контекст: файлы (`packages/mcp-server/`)

- `src/tools/get-token.ts` — `GetTokenInputSchema` (`chain: z.enum(['ethereum','solana'])`, `address` +
  `superRefine`→`isValidAddress`), output `Token`; `getTokenHandler(input, ctx:{registry})`,
  `registerGetTokenTool`. Способность: `token.metadata`(+`token.price`) → `coingecko`.
- `src/tools/wallet-balances.ts` — `WalletBalancesInputSchema` (ARCHITECTURE §5.1, `chain` enum + address
  superRefine), output `Wallet`; backend `wallet.balances.native` → `rpc-evm`/`rpc-solana` (OQ-1).
- `src/tools/new-pairs.ts` — `NewPairsInputSchema` (`chain` enum, `limit?: z.number().int().positive().optional()`),
  output `{chain, pairs: Pool[], source, fetchedAt}`; способность `pairs.new` → `dexscreener`.
- `src/tools/protocol-tvl.ts` — `ProtocolTvlInputSchema` (`chain` enum, `protocolSlug: z.string().min(1)`),
  output tvl-объект; способность `protocol.tvl` → `defillama`.
- `src/server.ts` — `createServer(deps:{env, version, registry?})` — `registry` инъектируем; по умолчанию —
  реальная сборка из `@onchain-intel/core` (`providers.config.ts` + `adapterRegistrations`), строится один
  раз в `index.ts`; регистрирует все 5 tool (ping + 4).
- `src/index.ts` — построить реальный `registry` + передать в `createServer` (единственная точка).
- `test/e2e.inprocess.test.ts` — **НОВЫЙ** (F-1): `InMemoryTransport.createLinkedPair()` + `Client` +
  `createServer({env, version, registry: fixtureRegistry})` в одном процессе; гоняет 4 tool через
  MCP-протокол; 0 сети.
- `test/e2e.stdio.test.ts` — расширить `tools/list` до **5** (по имени), `onchain_ping` end-to-end как в
  M0; **новые tool через spawn НЕ вызывать** (F-1).
- `test/tools/*.test.ts` — unit на pure-хендлеры + input-схемы.

Правки: `package.json` — `@onchain-intel/core` уже как `workspace:*` (003-1).

## Reviewer-заметки (обязательно применить)

- **ВСЕ 4 input-схемы: `chain: z.enum(['ethereum','solana'])`** (не полный `ChainSchema`; ARCHITECTURE
  §5.1 Major-2) — `dash` в 4 tools не принимается (dash покрыт только contract-тестами Registry). Адрес —
  `superRefine`→`isValidAddress(chain, address)` → невалидный вход = MCP tool-error, не крэш процесса.
- **F-1 разделение spawn/in-process:** инъекция `registry` работает ТОЛЬКО in-process — недостижима через
  границу спавненного процесса. Поэтому: 4 tool целиком гоняет `e2e.inprocess.test.ts` (fixtureRegistry,
  0 сети); `e2e.stdio.test.ts` (spawn) проверяет только `tools/list===5` + `onchain_ping` (вызов реального
  registry под spawn = живая сеть = нарушение R-21).
- **`fixtureRegistry`** — реализация публичного контракта `CapabilityRegistry.resolve()`, собранная из
  `packages/core/test/fixtures/` (батчи A/B из 003-4/003-5). Не мокать глобальный `fetch` — инжектировать
  другую реализацию контракта на границе `createServer`.
- **`_meta.cache`** (R-15 E2E-проверка): каждый tool-ответ несёт `_meta.cache:{status,ageMs?,provider,
capability}` — **вне** `structuredContent` (схема выхода не растёт). `e2e.inprocess` проверяет
  `status:'miss'`→`'hit'` на повторном вызове тех же аргументов.
- **`isError`-путь явный:** handler оборачивает `registry.resolve()` в try/catch; на
  `CapabilityUnavailableError` → `{isError:true, content:[{type:'text', text:<reason без секрета>}]}`
  (не полагаться на авто-`isError` SDK — тот только для zod input-валидации, M0 `.AGENTS.md`).
- **`registerTool` (не `tool()`)** + zod-схема как источник tool-schema (M0-паттерн `ping.ts`); callback
  возвращает и `content` (JSON-строка) и `structuredContent` (SDK требует при заданном `outputSchema`).
- **stdout-дисциплина** (M0 §7.3): любой лог/`_meta` — только через MCP-ответ/stderr, не сырой stdout.
- **R-20:** `ping.ts`/`PingInputSchema`/`PingOutputSchema` НЕ править; M0-тесты остаются зелёными.

## Phase 1 — Tool-стабы + e2e red `[STUB CREATION]`

1. 4 `tools/*.ts` — input/output zod-схемы (финальные) + handler-стабы (возвращают детерминированную
   форму по фикстуре-заглушке) + `registerXTool`.
2. `server.ts` — `registry?` injectable; регистрирует 5 tool.
3. `e2e.inprocess.test.ts` (InMemoryTransport + fixtureRegistry) — red/против стабов.
4. `e2e.stdio.test.ts` — обновить `tools/list` ожидание до 5.
5. **Verification Phase 1:** `pnpm --filter @onchain-intel/mcp-server exec tsc --noEmit` — 0 ошибок.

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. Каждый handler → `registry.resolve(capability, chain, args)` + try/catch (`isError`-путь) + `_meta.cache`.
2. `index.ts` — построить реальный registry из core + передать в `createServer`.
3. `fixtureRegistry` (в тесте) — из фикстур батчей A/B.
4. `e2e.inprocess.test.ts` — вызвать 4 tool на `ethereum` и `solana`; валидировать `structuredContent` по
   выходной схеме; проверить `_meta.cache` miss→hit; проверить `isError` при недоступной способности.
5. `e2e.stdio.test.ts` — `tools/list===5` (по имени); `onchain_ping` как в M0.
6. `test/tools/*.test.ts` — unit на форму input/output.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/mcp-server exec vitest run test/e2e.inprocess.test.ts   # R-16..R-19: 4 tool на 2 сетях, _meta.cache
pnpm --filter @onchain-intel/mcp-server exec vitest run test/e2e.stdio.test.ts       # R-20: tools/list===5 + ping (spawn)
pnpm --filter @onchain-intel/mcp-server test                                         # весь mcp-server-сьют зелёный (R-20 regress)
# R-16..R-19: 4 tool зарегистрированы точными именами:
grep -rhoE "onchain_(get_token|wallet_balances|new_pairs|protocol_tvl)" packages/mcp-server/src/tools | sort -u
# input chain сужен до 2 сетей во ВСЕХ 4 (Major-2):
grep -rnE "z\.enum\(\[('|\")ethereum('|\"),\s*('|\")solana('|\")\]\)" packages/mcp-server/src/tools   # 4 совпадения
# ping не тронут (R-20):
git diff --stat -- packages/mcp-server/src/tools/ping.ts | grep -q ping && echo "REVIEW: ping.ts changed (R-20 forbids)" || echo "ping-untouched-ok"
# spawn-e2e не вызывает новые tool через живой registry (F-1):
grep -nE "callTool\(\s*\{?\s*name:\s*('|\")onchain_(get_token|wallet_balances|new_pairs|protocol_tvl)" packages/mcp-server/test/e2e.stdio.test.ts && echo "REVIEW: new tool called via spawn (R-21 risk)" || echo "spawn-ping-only-ok"
```

- **[R-16]** `onchain_get_token` — zod in/out; e2e на ethereum+solana валиден.
- **[R-17]** `onchain_wallet_balances` — zod in/out (`Wallet`, native); backend rpc-evm/rpc-solana; unit
  на форму + e2e на 2 сетях.
- **[R-18]** `onchain_new_pairs` — zod in/out; contract/e2e на фикстурах DexScreener (2 сети).
- **[R-19]** `onchain_protocol_tvl` — zod in/out; contract/e2e на фикстурах DeFiLlama (2 сети).
- **[R-20]** `onchain_ping` без изменений; `tools/list===5`; M0-regression зелёный.

> Пятого tool нет (OQ-2 решён — dash/platform-метрики без tool в M1, ARCHITECTURE §2.1). Никакого
> HTTP-транспорта (stdio only, guard R-27). Никаких живых сетевых вызовов в тестах (fixtureRegistry, R-21).
