# Task 003-1 — `packages/core` scaffold + канонические типы + chain/address normalization

| Поле                    | Значение                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                       |
| **Тип**                 | Dev (Stub-First: Phase 1 структура/стабы → Phase 2 логика)                   |
| **R-IDs**               | **R-1**, **R-2**                                                             |
| **Зависимости**         | — (root M1; расширяет M0 `packages/mcp-server`)                              |
| **Разблокирует**        | 003-2 (→ всё остальное)                                                      |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §3.2 (types, §4.1 address), §5.2, §6.4 |

## Цель

Создать НОВЫЙ библиотечный пакет `@onchain-intel/core` (OQ-3, ARCHITECTURE §3.1) с канонической
zod-типизацией домена (D5) и модулем chain/address-нормализации, подключить его к `mcp-server` через
`workspace:*`. Пакет собирается **plain `tsc -p tsconfig.build.json`** (без tsup — обходит dts-баг M0).

## Контекст: файлы

Новые (`packages/core/`):

- `package.json` — `@onchain-intel/core`, `private`, Apache-2.0, `type:"module"`, `engines.node:">=22"`,
  `main:./dist/index.js`, `types:./dist/index.d.ts`; scripts: `build:"tsc -p tsconfig.build.json"`,
  `lint:"eslint ."`, `format:check:"prettier --check ."`, `typecheck:"tsc --noEmit"`, `test:"vitest run"`.
  deps: `zod@^4.4.3` (Phase 1 достаточно). devDeps: `typescript@^6.0.3` (тот же пин, что mcp-server),
  `vitest@^4.1.10`, `@types/node@^22`, `tsx@^4` (established runner из M0 — для TS-aware smoke-импорта в
  verification; сырой `node -e` не стрипает типы `.ts` надёжно). (Остальные deps — `better-sqlite3`/`lru-cache`/`ulid`/
  `@noble/hashes`/`bs58`/`pg`/`@types/pg`/`@types/better-sqlite3` — добавляют задачи 003-3/003-5 по мере
  надобности; здесь ставим **только** `@noble/hashes@^1` и `bs58@^6` для address.ts.)
- `tsconfig.json` — `extends ../../tsconfig.base.json`, `outDir:dist`, `include:["src","test"]`,
  **`types:["node"]`** (M0-квирк: без него `tsc` не резолвит `process`/`console` в этом toolchain).
  **Без явного `rootDir`** (иначе TS6059 на `test/*.ts`).
- `tsconfig.build.json` — `extends ./tsconfig.json`, `include:["src"]`, `rootDir:"src"` (только `src/`
  эмитится; `.d.ts` не засоряется `test/`).
- `.prettierignore` — одна строка `dist` (CWD-relative lookup — тот же паттерн, что mcp-server; иначе
  `prettier --check .` в пакете флагает собранный `dist/`).
- `src/types/token.ts`, `wallet.ts`, `pool.ts`, `ohlcv.ts`, `snapshot.ts`, `chain.ts` (или один
  `src/types/index.ts` — на усмотрение, но реэкспорт из `src/index.ts` обязателен).
- `src/chain/address.ts` — `normalizeAddress(chain, raw): string`, `isValidAddress(chain, raw): boolean`.
- `src/index.ts` — публичный реэкспорт (§5.2): все zod-схемы + `normalizeAddress`/`isValidAddress`.
- `test/chain-address.test.ts`, `test/types.test.ts`.

Правки:

- `packages/mcp-server/package.json` — добавить `"@onchain-intel/core": "workspace:*"` в `dependencies`.
  (Импорт из core появится в 003-6/003-7; сейчас достаточно объявить зависимость и убедиться, что
  `pnpm install` линкует workspace.)

## Reviewer-заметки (обязательно применить)

- **`address` всегда прошёл `normalizeAddress`** до попадания в канонический тип — типы этого не
  форсируют, но конвенция фиксируется в 003-4/003-5 (адаптеры зовут `normalizeAddress` перед кеш-ключом).
- **EIP-55, не lowercase** (ADR-001 D5): EVM-канон — checksum через `keccak256` (`@noble/hashes`),
  **не** просто `.toLowerCase()`. Чистая функция байт → любой входной регистр даёт один и тот же
  результат → детерминированный кеш-ключ (ARCHITECTURE §4.1).
- **Solana — как есть** (base58 регистро-чувствителен): валидация = успешное base58-декодирование
  (`bs58`) **и** длина декодированных байт **ровно 32** (сырой ed25519-pubkey, без checksum-байтов).
- **`dash` в `ChainSchema` есть** (консистентность словаря), но `Wallet`/`Balance` для него в M1 не
  используются; `normalizeAddress`/`isValidAddress` для `dash` в M1 не реализуют валидацию адреса —
  этого достаточно (M1-tools `dash` на входе не принимают, ARCHITECTURE §5.1 Major-2).
- **`Snapshot` — camelCase** (`valueRaw`/`valueNum`); движок в M1 его **не пишет** (n8n пишет отдельно).
  Маппинг `valueRaw↔value_raw` на persistence-границе — примечание для M3, не код M1 (ARCHITECTURE §4.1).
- **Zero-Dependency:** не тянуть `viem`/`ethers` целиком ради одной checksum-функции — только
  `@noble/hashes` (keccak256) + `bs58`.

## Phase 1 — Структура и стабы `[STUB CREATION]`

1. Создать scaffold пакета (все config-файлы выше).
2. `src/types/*` — объявить zod-схемы **по формам ARCHITECTURE §3.2** (`ChainSchema`, `TokenSchema`,
   `BalanceSchema`, `WalletSchema`, `PoolSchema`, `OhlcvSchema`, `SnapshotSchema`) — уже с полями (это
   декларации, не логика).
3. `src/chain/address.ts` — сигнатуры `normalizeAddress`/`isValidAddress` со стаб-телами (например
   `return raw` / `return false` + `// TODO Phase 2`).
4. `src/index.ts` — реэкспорт всего.
5. `packages/mcp-server/package.json` — добавить `workspace:*`-зависимость.
6. **Verification Phase 1:**

```bash
pnpm install                                                    # линкует @onchain-intel/core в workspace
pnpm --filter @onchain-intel/core exec tsc --noEmit            # 0 ошибок на скелете
pnpm --filter @onchain-intel/core exec tsx -e "import('./src/index.ts').then(()=>console.log('import-ok')).catch(e=>{console.error(e);process.exit(1)})"   # tsx (не сырой node) — надёжно стрипает типы .ts
```

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. `address.ts` — реализовать EIP-55 checksum (keccak256) для `ethereum`; base58+len-32 валидацию для
   `solana`; `isValidAddress` возвращает `boolean`, `normalizeAddress` бросает/возвращает нормализованную
   форму (контракт — задокументировать: невалидный вход → бросок, ловится вызывающим `superRefine`/адаптером).
2. `src/types/*` — финализировать `.strict()`-схемы; убедиться, что `z.infer`-типы экспортируются.
3. `test/chain-address.test.ts` — checksum (смешанный регистр входа → один результат), base58 32-байта,
   невалидные адреса (короткий/длинный/не-base58), `dash` (не валидируется — контракт).
4. `test/types.test.ts` — каждый тип (`Token`/`Wallet`/`Balance`/`Pool`/`OHLCV`/`Snapshot`) валидирует
   пример данных (R-1/R-2), и отвергает лишнее поле (`.strict()`).

## Acceptance (команды — RF-1-safe: без `timeout`, без `test -- --flag`)

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit                        # R-1/R-2: 0 ошибок типизации
pnpm --filter @onchain-intel/core test                                     # весь core-сьют зелёный (R-1/R-2)
pnpm --filter @onchain-intel/core exec vitest run test/chain-address.test.ts   # адрес-модуль зелёный
pnpm --filter @onchain-intel/core exec vitest run test/types.test.ts           # типы зелёные
pnpm --filter @onchain-intel/core lint                                     # eslint чист на новом пакете
pnpm --filter @onchain-intel/core exec prettier --check .                  # формат чист
# провайдер-DTO не протекают (R-1): ни один tools/*.ts не импортит provider-специфику (пока tools нет —
# guard активируется в 003-7; здесь проверяем реэкспорт публичного API):
grep -nE "export \{" packages/core/src/index.ts                            # ChainSchema/Token.../normalizeAddress видны
# топология workspace (§11, первичная проверка): core собирается раньше mcp-server через pnpm -r
pnpm -r build && echo "topo-build-ok"                                      # core (tsc) → mcp-server (tsup+tsc)
```

- **[R-1]** типы `Token`/`Wallet`/`Balance`/`OHLCV`/`Pool` экспортированы из `src/index.ts`; unit-тест
  валидирует каждый; provider-DTO наружу не идут.
- **[R-2]** `Snapshot` содержит `metric,asset,ts,valueRaw(string),valueNum?,source,height?`; unit-тест на
  сериализацию/валидацию.

> Кеш/registry/адаптеры здесь **не создаются** (guard R-27) — только типы + address + scaffold.
> Точные minor/patch версий зависимостей проставляет `pnpm add` (vendor-drift), не изобретать из головы.
