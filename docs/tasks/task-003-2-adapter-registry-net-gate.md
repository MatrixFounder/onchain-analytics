# Task 003-2 — `ProviderAdapter` + `CapabilityRegistry` + `providers.config.ts` + SSRF-гейт + rate-limiter

| Поле                    | Значение                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                               |
| **Тип**                 | Dev (Stub-First: Phase 1 интерфейсы/стабы → Phase 2 логика)                          |
| **R-IDs**               | **R-3**, **R-4**, **R-25**, **R-26**                                                 |
| **Зависимости**         | 003-1 (`ChainSchema`, канонические типы)                                             |
| **Разблокирует**        | 003-3, 003-4, 003-5                                                                  |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §2.1, §3.2 (adapters/registry/net), §5.3, §9.1 |

## Цель

Построить горячо-заменяемый доступ к провайдерам за стабильным внутренним интерфейсом (D4): интерфейс
`ProviderAdapter`, `CapabilityRegistry` с маршрутизацией по `(capability, chain)`, декларативный
`providers.config.ts` (9 адаптеров), единственную точку исходящего HTTP `safeFetch` (SSRF-гейт) и
per-provider token-bucket rate-limiter. Реальные адаптеры и кеш подключаются позже (003-3/003-4/003-5);
здесь — контур + пустые/стаб-адаптеры.

## Контекст: файлы (`packages/core/src/`)

- `adapters/types.ts` — `ProviderAdapter`, `CapabilityDescriptor`, `AdapterRegistration`, `CapabilityRoute`.
- `adapters/registry.ts` — `CapabilityRegistry` (`resolve(capability, chain, args)`),
  `CapabilityUnavailableError`.
- `adapters/cache-store.ts` — **интерфейс** `CacheStore` (`get`/`set` по `(provider,capability,argsHash)`);
  реализацию (lru+sqlite) поставляет 003-3. Registry принимает `CacheStore` инъекцией (фабрика, не singleton).
- `providers.config.ts` — `routes: CapabilityRoute[]` + `adapterRegistrations: AdapterRegistration[]`
  (ровно 9, по ARCHITECTURE §3.2 — id/hosts/rateLimit/requiresEnv).
- `net/safe-fetch.ts` — `assertAllowedHost(hostname, allowlist)`, `safeFetch(url, opts, allowlist)`.
- `net/rate-limit.ts` — `throttle(providerId, cfg: TokenBucketConfig)`.
- `net/args-hash.ts` — `canonicalize(value)` + `deriveArgsHash(capability, args)` (sha256(hex), canonical
  key-order; **никогда** `process.env` — только нормализованный tool-input; ARCHITECTURE §7.2).
- Тесты: `test/registry.test.ts`, `test/safe-fetch.test.ts`, `test/rate-limit.test.ts`, `test/args-hash.test.ts`.

Правки: `src/index.ts` — реэкспорт `CapabilityRegistry`, типов, `routes`/`adapterRegistrations`,
`safeFetch`/`assertAllowedHost`/`throttle`.

## Reviewer-заметки (обязательно применить)

- **`resolve()` реализует `isAvailable() === false` → skip-to-next** (согласование §3.2 docstring ↔ §9.1):
  для каждого `adapterId` в `route.adapterIds` по порядку — если `adapter.isAvailable?()` вернул
  `{ok:false}` **или** `fetch()`/`normalize()` бросил → **переход к следующему** `adapterId`, не падение.
  Если перебрали всех → `throw CapabilityUnavailableError({ capability, chain, tried: [{adapterId, reason}] })`.
  (Это ядро R-11 hot-swap и R-24 explicit-degradation; сам fallback-**тест** — в 003-5.)
- **Anti-corruption layer:** `resolve()` наружу отдаёт только `normalize()`-результат (канонический тип),
  сырой provider-DTO не покидает адаптер.
- **SSRF per-adapter, не глобальный** (R-25): `safeFetch` принимает allowlist **конкретного** адаптера
  (из его `AdapterRegistration.hosts`), не объединённый список. Редирект — `redirect:'manual'`, проверка
  hostname каждого хопа (макс. 3) через `assertAllowedHost` **до** следования редиректу.
- **`deriveArgsHash` — canonical key-order** (minor ревью цикл 1): рекурсивно сортировать ключи объектов
  **до** `JSON.stringify`, иначе `{chain,address}` и `{address,chain}` дают разные хеши → ложный cache-miss.
- **rate-limit — in-memory, per-provider** (M1 — один процесс, персистентность не нужна); значения — из
  `adapterRegistrations[].rateLimit`, консервативные стартовые, подкручиваются правкой конфига (R-4).
- **Registry/CacheStore — фабрики, не module-singletons** (тестируемость, будущая многоинстансность §8).

## Phase 1 — Интерфейсы и стабы `[STUB CREATION]`

1. `adapters/types.ts` — интерфейсы по ARCHITECTURE §3.2 (`ProviderAdapter` с `id/capabilities/costOf/
fetch/normalize/isAvailable?`; `CapabilityDescriptor{id, chains?}`; `AdapterRegistration{id, hosts,
rateLimit, requiresEnv}`; `CapabilityRoute{capability, chains?, adapterIds}`).
2. `providers.config.ts` — полные `routes` + `adapterRegistrations` (9 адаптеров) **копируются по
   ARCHITECTURE §3.2** (значения hosts/rateLimit/requiresEnv/routes — оттуда буквально).
3. `adapters/cache-store.ts` — интерфейс `CacheStore` + no-op-стаб `PassthroughCacheStore` (всегда miss) —
   чтобы `resolve()` компилировался/тестировался до 003-3.
4. `adapters/registry.ts` — `CapabilityRegistry` с `resolve()`-стабом (бросает `NotImplemented` или
   возвращает фиксированную форму), `CapabilityUnavailableError`.
5. `net/*` — сигнатуры `safeFetch`/`assertAllowedHost`/`throttle`/`deriveArgsHash` со стаб-телами.
6. Тесты red (или против стабов).
7. **Verification Phase 1:** `pnpm --filter @onchain-intel/core exec tsc --noEmit` — 0 ошибок.

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. `registry.resolve()` — маршрутизация по `(capability, chain)`: найти route, где `capability`
   совпадает и (`chains` не задан **или** `chain ∈ chains`); идти по `adapterIds` со skip-to-next
   (см. reviewer-заметку); при кеш-хите (через `CacheStore`) — вернуть `{result, source, cache:'hit',
ageMs}`, иначе `fetch→normalize→cache.set→{cache:'miss'}`. Registry принимает `Map<id, ProviderAdapter>`
   - `CacheStore` в конструкторе.
2. `assertAllowedHost` — бросает `SsrfBlockedError`, если `hostname ∉ allowlist`. `safeFetch` — проверка
   URL-хоста + ручная редирект-цепочка.
3. `throttle` — token-bucket: capacity/refillPerSec per-provider, ждёт/отклоняет при исчерпании.
4. `deriveArgsHash` — `canonicalize` + `sha256Hex(JSON.stringify({capability, args}))`.
5. Тесты: маршрут выбирает адаптер по приоритету/сети; skip-to-next при `isAvailable===false`
   (мок-адаптеры); SSRF отклоняет вне-allowlist хост **до** сети (мок `fetch`); throttle задерживает при
   превышении; `deriveArgsHash` стабилен к порядку ключей.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit                          # R-3/R-4: типизация чиста
pnpm --filter @onchain-intel/core exec vitest run test/registry.test.ts      # R-4: маршрутизация + skip-to-next
pnpm --filter @onchain-intel/core exec vitest run test/safe-fetch.test.ts    # R-25: SSRF отклоняет до сети
pnpm --filter @onchain-intel/core exec vitest run test/rate-limit.test.ts    # R-26: throttle
pnpm --filter @onchain-intel/core exec vitest run test/args-hash.test.ts     # canonical key-order
pnpm --filter @onchain-intel/core test                                       # весь core-сьют зелёный
# R-4: 9 адаптеров и routes задекларированы в одном файле:
grep -cE "id: '(coingecko|dexscreener|defillama|dune|rpc-evm|rpc-solana|dash-platform|platform-explorer|pg-history)'" packages/core/src/providers.config.ts   # ожидается 9
# R-25: единственная точка HTTP — safeFetch; сырых fetch/http вне net/ быть не должно (guard, растёт в 003-4/5):
grep -RnE "\bfetch\(|http\.request|https\.request" packages/core/src/adapters && echo "REVIEW: raw fetch in adapters (must use safeFetch)" || echo "no-raw-fetch-ok"
```

- **[R-3]** `ProviderAdapter` типизирован без `any`-протечек в `adapters/types.ts`.
- **[R-4]** `providers.config.ts` (routes+9 регистраций) + `resolve()` выбирает провайдера по
  capability+сети+доступности; смена приоритета = правка конфига.
- **[R-25]** `safeFetch`/`assertAllowedHost` (per-adapter allowlist + редирект-проверка); вне-allowlist
  отклонён до сети; unit-тест.
- **[R-26]** token-bucket `throttle` per-provider из конфига; тест на превышение.

> Живых сетевых вызовов здесь нет (адаптеры — стабы; реальный `fetch` через `safeFetch` появится в
> 003-4/003-5). Никакого кеш-хранилища (только интерфейс), никаких tools, никаких платных/write/scheduler
> путей (guard R-27).
