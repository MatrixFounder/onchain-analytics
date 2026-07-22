# Task 003-5 — live-адаптеры batch B: rpc-evm + rpc-solana + platform-explorer(+history) + dash-platform stub + dune config-stub + pg-history

| Поле                    | Значение                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                                                                                          |
| **Тип**                 | Dev (Stub-First: Phase 1 адаптеры-скелеты/fallback-тест red → Phase 2 логика/green)                                                                             |
| **R-IDs**               | **R-8**, **R-9**, **R-10**, **R-11**, **R-12**                                                                                                                  |
| **Зависимости**         | 003-2 (iface/config/safeFetch), 003-3 (реальный кеш для сквозного `resolve()`), 003-4 (скелет `scripts/record-fixture.mjs` — здесь расширяется живыми вызовами) |
| **Разблокирует**        | 003-6, 003-7                                                                                                                                                    |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §2.1, §3.2 (dash/dune/pg решения), §5.3, §9.1, §11                                                                        |

## Цель

Завершить набор из 9 адаптеров: два live keyless RPC (баланс нативного ETH/SOL — backend для
`onchain_wallet_balances`, OQ-1 решён), live `platform-explorer` (Dash, единственный live-источник +
history), `dash-platform` (interface+fixture-контракт, `isAvailable()===false`), `dune`
(interface/config-stub), опциональный read-only `pg-history` (клиент **`pg`**). Плюс `registry.fallback.test.ts`
— доказательство горячей замены (R-11) на реальной M1-конфигурации.

## Контекст: файлы (`packages/core/`)

- `src/adapters/rpc-evm/index.ts` — `wallet.balances.native` (ethereum); JSON-RPC `eth_getBalance` через
  `safeFetch`; hosts: `ethereum-rpc.publicnode.com` (primary), `eth.drpc.org` (fallback); `normalize()`
  → `Wallet` (`balances:[{assetType:'native', symbol:'ETH', decimals:18, amountRaw, amountNum?}]`).
- `src/adapters/rpc-solana/index.ts` — `wallet.balances.native` (solana); JSON-RPC `getBalance`; host
  `api.mainnet-beta.solana.com`; `normalize()` → `Wallet` (`SOL`, decimals 9, lamports как `amountRaw`).
- `src/adapters/platform-explorer/index.ts` — REST keyless; `privacy.shielded_pool`+`platform.*` (live) +
  собственный history-метод (`*.history`); host `platform-explorer.pshenmic.dev`; `normalize()` → `Snapshot`/`Snapshot[]`.
- `src/adapters/dash-platform/index.ts` — interface + fixture-контракт (F-3): `capabilities()` объявлены;
  `normalize()` реализован+тестируется на **вручную собранной** фикстуре; `fetch()` — stub
  (`NotImplementedInM1Error`); `isAvailable()` **безусловно** `{ok:false, reason:'dash-platform live
transport deferred — see backlog, use platform-explorer'}`. **`@grpc/*` НЕ импортировать.** Нет `proto/`.
- `src/adapters/dune/index.ts` — interface/config-stub: `capabilities()` = `token.holders`;
  `fetch()`/`normalize()` НЕ реализованы; `isAvailable()` безусловно `{ok:false, reason:'dune query
authoring deferred to M2'}`; **нет** фикстуры/теста.
- `src/pg/read-client.ts` — ленивый `pg.Pool` (только при `ONCHAIN_PG_URL` + вызове history);
  `search_path=onchain` через `options:'-c search_path=onchain'`; **только `SELECT`**.
- `src/adapters/pg-history/index.ts` — `ProviderAdapter` поверх `read-client`: `privacy.shielded_pool.history`/
  `platform.metrics.history`; `isAvailable()` = `{ok:false, reason:'needs ONCHAIN_PG_URL'}` без DSN;
  `normalize()` → `Snapshot[]`.
- `test/rpc-evm.contract.test.ts`, `rpc-solana.contract.test.ts`, `platform-explorer.contract.test.ts`,
  `dash-platform.contract.test.ts`, `pg-history.contract.test.ts` (мок pg-клиента), `registry.fallback.test.ts`.
- `test/fixtures/{rpc-evm,rpc-solana,platform-explorer,dash-platform}/*.json` (+ evidence для live-трёх).

Правки: `packages/core/package.json` — deps `pg@^8`; devDep `@types/pg@^8`. `src/index.ts` — реэкспорт.

## Reviewer-заметки (обязательно применить)

- **OQ-1 РЕШЁН (§0 п.5 PLAN):** backend `wallet.balances.native` = `rpc-evm`+`rpc-solana`, только
  `assetType:'native'`. Живой пробник подтвердил: `ethereum-rpc.publicnode.com` ✓, `eth.drpc.org` ✓,
  `api.mainnet-beta.solana.com` ✓. **`llamarpc`/`cloudflare-eth` — DOWN, НЕ добавлять в hosts.**
- **Второй Solana RPC fallback — НЕ в M1** (§11): `rpc-solana` стартует с одним host (одиночная точка +
  retry, не hot-swap) — второй кандидат требует отдельного живого пробника, вне M1.
- **`amountRaw` — точное целое строкой** (DB-SCHEMA §1.7): wei/lamports превышают 2^53; `amountNum` —
  lossy-проекция, никогда не источник истины. Не парсить wei в JS number.
- **`dash-platform` — ГАРАНТИРОВАННО `isAvailable()===false`** (F-3): это НЕ «если evonode недоступен»,
  а всегда → Registry всегда маршрутизирует Dash-способности на `platform-explorer`. Это реальный,
  постоянно активный fallback-путь (доказывает R-11 настоящим прогоном, не симуляцией).
- **НЕ писать токен `@grpc` дословно в комментариях исходников** (scope-грепы 003-8/003-5 сужены до
  import/require-строк, но комментарий вида `// @grpc … отложен` дал бы ложное срабатывание при более
  широком скане). Пояснять решение F-3 словами («живой gRPC-транспорт отложен в backlog»), без
  literal-токена запрещённой зависимости.
- **`dune` config-stub принят как обновлённый scope R-8** (§0 п.6 PLAN, ARCHITECTURE §11) — Planner
  принял, к Analyst не эскалирует. Ни один из 4 Must-tools от `token.holders` не зависит → пустой `.env`
  остаётся функциональным (UC-1).
- **`pg-history` — обычный `ProviderAdapter`, не side-channel** (F-2): зарегистрирован в `providers`
  (FK), `read-client` используется ТОЛЬКО им. **Клиент = `pg`** (node-postgres, ARCHITECTURE §6.1/§3.2),
  **НЕ** postgres.js. Только `SELECT`, ни одного `INSERT/UPDATE/DELETE` в коде движка (R-12/R-27).
- **`pg-history` тест — мок pg-клиента с фикс. строками**, не живая БД (CI без сети/DSN, R-21).
- **`registry.fallback.test.ts` — реальная M1-конфигурация**, не мок недоступности: `dash-platform.
isAvailable()` детерминированно `false` → `platform-explorer` отвечает (через `resolve()` со сквозным
  кешем из 003-3).

## Phase 1 — Адаптеры-скелеты + fallback-тест red `[STUB CREATION]`

1. Все `adapters/<id>/index.ts` — реализуют `ProviderAdapter`; `fetch()`/`normalize()` — стабы;
   `isAvailable()` уже финальный для `dash-platform`/`dune`/`pg-history` (это контракт, не логика).
2. `pg/read-client.ts` — сигнатура + стаб (не подключается).
3. `registry.fallback.test.ts` + `*.contract.test.ts` — red/против стабов.
4. **Verification Phase 1:** `pnpm --filter @onchain-intel/core exec tsc --noEmit` — 0 ошибок; grep-guard
   `@grpc/` отсутствует (см. Acceptance).

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. `rpc-evm`/`rpc-solana` — реальные JSON-RPC-вызовы через `safeFetch`; `normalize()` → `Wallet`.
2. **Запись фикстур (РУЧНОЙ, требует сети, ОДИН раз/адаптер, НЕ в CI):**

```bash
# требует сети; локально; все keyless (секреты НЕ нужны)
node packages/core/scripts/record-fixture.mjs rpc-evm ethereum 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
node packages/core/scripts/record-fixture.mjs rpc-solana solana EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
node packages/core/scripts/record-fixture.mjs platform-explorer dash        # live + history эндпоинты
# dash-platform фикстура собирается ВРУЧНУЮ (форма из addendum getShieldedPoolState/getTotalCreditsInPlatform),
# НЕ через record-fixture (живого gRPC в M1 нет) — кладётся в test/fixtures/dash-platform/*.json
```

3. `platform-explorer` — live state + history `normalize()` → `Snapshot`/`Snapshot[]`.
4. `dash-platform.normalize()` — golden против вручную собранной фикстуры; `fetch()` — stub; `isAvailable()===false`.
5. `dune` — оставить config-stub (никакого `fetch`/`normalize`).
6. `pg/read-client.ts` + `pg-history` — ленивый `pg.Pool`, `SELECT`-only; `normalize()` → `Snapshot[]`;
   тест на моке pg-клиента.
7. `registry.fallback.test.ts` — `resolve('privacy.shielded_pool','dash',...)` → `dash-platform` skip
   (`isAvailable false`) → `platform-explorer` отвечает; source === `platform-explorer`, без броска.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/rpc-evm.contract.test.ts          # R-17 backend
pnpm --filter @onchain-intel/core exec vitest run test/rpc-solana.contract.test.ts       # R-17 backend
pnpm --filter @onchain-intel/core exec vitest run test/platform-explorer.contract.test.ts # R-10
pnpm --filter @onchain-intel/core exec vitest run test/dash-platform.contract.test.ts     # R-9 (fixture)
pnpm --filter @onchain-intel/core exec vitest run test/pg-history.contract.test.ts        # R-12 (mock pg)
pnpm --filter @onchain-intel/core exec vitest run test/registry.fallback.test.ts          # R-11 hot-swap
pnpm --filter @onchain-intel/core test                                                    # весь сьют зелёный
# R-9/R-8: @grpc и live-gRPC НЕ в M1 — скан по import/require + по dependency (НЕ по комментариям):
grep -RnE "^[[:space:]]*(import|export)[^;]*@grpc|require\(['\"]@grpc" packages/core/src && echo "REVIEW: grpc import in M1 (must NOT be)" || echo "no-grpc-import-ok"
grep -nE "\"@grpc/(grpc-js|proto-loader)\"" packages/core/package.json && echo "REVIEW: grpc dependency in M1 (must NOT be)" || echo "no-grpc-dep-ok"
grep -RnE "reason:.*deferred" packages/core/src/adapters/dash-platform packages/core/src/adapters/dune   # безусловный false
# R-12: pg только SELECT; клиент = pg (не postgres.js):
grep -RniE "\b(INSERT|UPDATE|DELETE)\b" packages/core/src/pg packages/core/src/adapters/pg-history && echo "REVIEW: write path in pg (must NOT be)" || echo "select-only-ok"
grep -nE "\"pg\"" packages/core/package.json                                              # клиент pg (node-postgres)
grep -RnE "search_path=onchain" packages/core/src/pg/read-client.ts                       # схема onchain
# OQ-1 hosts: только подтверждённые живым пробником (нет llamarpc/cloudflare-eth):
grep -RnE "publicnode|drpc|mainnet-beta" packages/core/src/providers.config.ts
grep -RniE "llamarpc|cloudflare-eth" packages/core/src && echo "REVIEW: DOWN host used" || echo "no-down-host-ok"
```

- **[R-8]** `dune` config-stub: `token.holders` объявлен, `fetch`/`normalize`/фикстура/тест отсутствуют,
  `isAvailable()` безусловно false.
- **[R-9]** `dash-platform` interface+fixture: capabilities объявлены, `normalize()` golden-тест на
  фикстуре зелёный, `fetch()` stub, `isAvailable()===false`, без `@grpc`/write-кода.
- **[R-10]** `platform-explorer`: те же capability + собственный history; live keyless.
- **[R-11]** `registry.fallback.test.ts` доказывает DAPI→platform-explorer на реальной M1-конфигурации.
- **[R-12]** `pg-history` (`pg`, ленивый, SELECT-only, `search_path=onchain`); без DSN — явный
  `isAvailable()` reason, не крэш; зарегистрирован в `providers` (FK).

> Живой gRPC DAPI, живой Dune-запрос, ERC-20/SPL — **вне M1** (guard R-27, PLAN §5). Второй Solana RPC —
> не добавляется (§11). Фикстуры live-адаптеров пишутся `record-fixture.mjs` вне CI (R-22).
