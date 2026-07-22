# Task 003-4 — live-адаптеры batch A: coingecko + dexscreener + defillama + фикстуры + golden-тесты

| Поле                    | Значение                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                |
| **Тип**                 | Dev (Stub-First: Phase 1 адаптеры-стабы/пустые тесты → Phase 2 фикстуры+нормализация) |
| **R-IDs**               | **R-5**, **R-6**, **R-7**, **R-21**, **R-22**                                         |
| **Зависимости**         | 003-2 (`ProviderAdapter`, `providers.config.ts`, `safeFetch`)                         |
| **Разблокирует**        | 003-7 (fixtureRegistry для e2e.inprocess)                                             |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §3.2 (9 адаптеров, тест-сьют), §5.3, §11        |

## Цель

Реализовать три keyless/free live-адаптера (CoinGecko, DexScreener, DeFiLlama) поверх `safeFetch`,
записать по фикстуре на адаптер **ручным** dev-скриптом (живой вызов ОДИН раз, с probe-evidence), и
покрыть `normalize()` golden-тестами, которые в CI гоняются **без сети** (D11).

## Контекст: файлы (`packages/core/`)

- `src/adapters/coingecko/index.ts` — `capabilities()` = `token.price`+`token.metadata`; REST
  `/coins/{platform}/contract/{address}` (platform: `ethereum`|`solana`); опц. `COINGECKO_API_KEY`
  (header, из env — читается внутри `fetch()`, НЕ в кеш-ключ); `normalize()` → `Token`.
- `src/adapters/dexscreener/index.ts` — `capabilities()` = `pairs.new`+`pool.info`; keyless; `normalize()`
  → `Pool[]`. **Точный endpoint для `pairs.new`/`pool.info` подтверждается при записи фикстуры** (§11).
- `src/adapters/defillama/index.ts` — `capabilities()` = `protocol.tvl`; keyless; REST `/protocol/{slug}`,
  срез `chainTvls[chain]`; `normalize()` → `{protocol, chain, tvlUsd, totalTvlUsd, source, fetchedAt}`.
- `scripts/record-fixture.mjs` — ручной dev-скрипт (вне CI): один живой вызов → фикстура + evidence.
- `test/fixtures/<adapter>/*.json` (+ `<name>.evidence.md`) — закоммичены.
- `test/coingecko.contract.test.ts`, `dexscreener.contract.test.ts`, `defillama.contract.test.ts`.

Правки: `src/index.ts` — реэкспорт адаптеров (если нужен публичный доступ); адаптеры регистрируются в
Registry через `providers.config.ts` (id уже объявлены в 003-2).

## Reviewer-заметки (обязательно применить)

- **Провайдер-DTO не протекает** (D4 anti-corruption): `normalize()` — единственный выход; сырой JSON
  провайдера наружу не идёт; `fetch()` возвращает `unknown`, сужается внутри `normalize()`.
- **`fetch()` идёт ТОЛЬКО через `safeFetch`** (R-25) с `hosts` **своего** адаптера из
  `adapterRegistrations` — не сырой `globalThis.fetch`.
- **`normalizeAddress` перед кеш-ключом** (003-1): CoinGecko `address` нормализуется (EIP-55/base58) до
  построения args-хеша.
- **`COINGECKO_API_KEY` — опционален**, demo/free работает без него; ключ читается внутри `fetch()`,
  **никогда** не логируется и не входит в `deriveArgsHash` (ARCHITECTURE §7.2).
- **Probe-evidence (R-22, vendor-drift):** `record-fixture.mjs` при записи фиксирует РЕАЛЬНЫЙ endpoint,
  список полей ответа, HTTP-статус и **дату** в `<name>.evidence.md` — не предположение. Это разрешает
  §11-неопределённость по DexScreener-endpoint фактом, а не догадкой.
- **CI без сети (R-21):** golden-тесты читают `test/fixtures/`, не ходят в сеть; `record-fixture.mjs`
  **не** импортируется тестами и **не** в CI. Ни один секрет не нужен CI (только dev-скрипту).
- **DexScreener shape-trap (n8n-урок, применимо):** не угадывать форму ответа (top-level array vs объект)
  — зафиксировать реальную форму в фикстуре и evidence при записи.

## Phase 1 — Адаптеры-стабы + скелет скрипта `[STUB CREATION]`

1. Три `adapters/<id>/index.ts` — реализуют `ProviderAdapter`: `id`, `capabilities()` (реальные дескрипторы),
   `costOf()` (0 credits — free), `fetch()`/`normalize()` — стабы (`fetch` бросает `NotImplemented`,
   `normalize` возвращает форму по фикстуре-заглушке), `isAvailable?()` (coingecko всегда ok; ds/dl ok).
2. `scripts/record-fixture.mjs` — скелет CLI (`node scripts/record-fixture.mjs <adapter> [args]`), пока
   без живого вызова.
3. Пустые `*.contract.test.ts` (red).
4. **Verification Phase 1:** `pnpm --filter @onchain-intel/core exec tsc --noEmit` — 0 ошибок.

## Phase 2 — Фикстуры + нормализация `[LOGIC IMPLEMENTATION]`

1. Реализовать `fetch()` через `safeFetch` + `normalize()` для трёх адаптеров.
2. **Запись фикстур (РУЧНОЙ шаг, требует сети, ОДИН раз на адаптер, НЕ в CI):**

```bash
# требует сети; запускается разработчиком локально; секреты НЕ нужны (все три keyless/free)
node packages/core/scripts/record-fixture.mjs coingecko ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
node packages/core/scripts/record-fixture.mjs coingecko solana EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
node packages/core/scripts/record-fixture.mjs dexscreener ethereum
node packages/core/scripts/record-fixture.mjs dexscreener solana
node packages/core/scripts/record-fixture.mjs defillama ethereum uniswap
node packages/core/scripts/record-fixture.mjs defillama solana raydium
# → пишет test/fixtures/<adapter>/*.json + <name>.evidence.md (endpoint/поля/статус/дата)
```

3. `*.contract.test.ts` — golden: загрузить фикстуру → `adapter.normalize(cap, raw)` → сверить с
   ожидаемым каноническим объектом (`Token`/`Pool[]`/tvl-объект), для обеих сетей (ethereum+solana).
4. Убедиться, что тесты проходят **без** записи новых фикстур (используют закоммиченные).

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/coingecko.contract.test.ts    # R-5
pnpm --filter @onchain-intel/core exec vitest run test/dexscreener.contract.test.ts  # R-6
pnpm --filter @onchain-intel/core exec vitest run test/defillama.contract.test.ts    # R-7
pnpm --filter @onchain-intel/core test                                               # весь сьют зелёный (R-21)
# R-21: фикстуры лежат в repo; тесты не импортируют record-fixture / сырой fetch:
ls packages/core/test/fixtures/coingecko packages/core/test/fixtures/dexscreener packages/core/test/fixtures/defillama
grep -RnE "record-fixture|globalThis\.fetch|\bnode-fetch\b" packages/core/test && echo "REVIEW: test touches network path" || echo "no-network-in-tests-ok"
# R-22: evidence зафиксирован (дата/endpoint/поля), скрипт вне CI:
grep -RniE "recorded_at|endpoint|status" packages/core/test/fixtures/*/*.evidence.md | head
grep -RnE "record-fixture" .github/workflows/ci.yml && echo "REVIEW: record-fixture in CI (must NOT be)" || echo "record-fixture-not-in-CI-ok"
# R-5/R-6/R-7: capabilities объявлены:
grep -rnE "token\.price|token\.metadata" packages/core/src/adapters/coingecko
grep -rnE "pairs\.new|pool\.info" packages/core/src/adapters/dexscreener
grep -rnE "protocol\.tvl" packages/core/src/adapters/defillama
```

- **[R-5]** `coingecko`: `capabilities()` включает `token.price`/`token.metadata`; работает без ключа;
  contract-тест на фикстуре зелёный.
- **[R-6]** `dexscreener`: `capabilities()` включает `pairs.new`/`pool.info`; contract-тест без ключа
  зелёный; endpoint подтверждён evidence.
- **[R-7]** `defillama`: `capabilities()` включает `protocol.tvl`; contract-тест без ключа зелёный.
- **[R-21]** `pnpm test` без исходящих сетевых вызовов; фикстуры в repo; детерминизм.
- **[R-22]** `record-fixture.mjs` вне CI; фиксирует фактические поля/endpoint/дату (probe-evidence).

> Никаких платных ключей, write-путей (guard R-27). `record-fixture.mjs` — единственное место с живой
> сетью, и оно вне CI.
