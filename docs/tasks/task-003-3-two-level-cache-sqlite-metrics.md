# Task 003-3 — двухуровневый кеш (`lru-cache` + `better-sqlite3` в `DATA_DIR`) + hit/miss-метрики

| Поле                    | Значение                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-003 `m1-read-layer`](../TASK.md)                                                    |
| **Тип**                 | Dev (Stub-First: Phase 1 DDL/сигнатуры/стабы → Phase 2 логика)                            |
| **R-IDs**               | **R-13**, **R-14**, **R-15**                                                              |
| **Зависимости**         | 003-2 (`CacheStore`-интерфейс, `adapterRegistrations` для bootstrap)                      |
| **Разблокирует**        | 003-5 (сквозной `resolve()` для fallback-теста)                                           |
| **Источники**           | [ARCHITECTURE.md](../ARCHITECTURE.md) §3.2 (cache), §4.2/§4.3 (DDL), DB-SCHEMA-CONCEPT §1 |

## Цель

Реализовать `CacheStore` из 003-2 как двухуровневый кеш: `lru-cache` (hot, in-process) перед
`better-sqlite3` (persistent, `DATA_DIR`), схема кеш-БД строго по DB-SCHEMA-CONCEPT §1, спроектирована
под будущую `usage`-таблицу без миграции. Плюс hit/miss-счётчики, видимые в stderr и в `_meta.cache`.

## Контекст: файлы (`packages/core/src/cache/`)

- `ddl.ts` (или `schema.sql` как строка) — DDL `providers` + `cache_entries` + индекс (ARCHITECTURE §3.2).
- `sqlite-store.ts` — `SqliteCacheStore implements CacheStore`: открытие соединения (`PRAGMA
foreign_keys=ON`, `journal_mode=WAL`), bootstrap `providers` (upsert всех 9 регистраций), get/set с
  upsert-семантикой + TTL.
- `lru.ts` — hot-слой (`lru-cache`, TTL в `set`).
- `two-level-store.ts` — композиция: `get` → lru → sqlite → miss; `set` → оба уровня.
- `ttl.ts` — `ttlFor(capability): number` (таблица TTL ARCHITECTURE §3.2).
- `stats.ts` — `Map<capability,{hit,miss}>` + `getCacheStats()` + инкремент из Registry.
- `data-dir.ts` — резолв `DATA_DIR` (env или `path.join(os.homedir(), '.onchain-intel')`).
- Тесты: `test/cache.test.ts`, `test/cache-stats.test.ts`.

Правки:

- **`pnpm-workspace.yaml`** — добавить `better-sqlite3: true` в существующий блок `allowBuilds` (рядом с
  `esbuild: true`), иначе pnpm 11 блокирует нативный build-скрипт.
- `packages/core/package.json` — deps `better-sqlite3@^11`, `lru-cache@^11`, `ulid@^2`; devDep
  `@types/better-sqlite3@^7`.
- `packages/core/src/adapters/registry.ts` — заменить `PassthroughCacheStore` на инъекцию реального
  `TwoLevelStore`; инкрементировать stats на каждом `resolve()`.
- `src/index.ts` — реэкспорт `getCacheStats`, фабрики стора.

## Reviewer-заметки (обязательно применить)

- **DDL — только `TEXT/INTEGER/REAL`** (DB-SCHEMA §1.1): время — epoch-ms `INTEGER` (`created_at`/
  `expires_at`); `id` — **ULID `TEXT`**, генерит приложение (`ulid`), не autoincrement; `value_json` —
  JSON как `TEXT` (парсинг app-side); `args_hash` — sha256(hex), **никогда** секретов.
- **Запись — upsert, не append-only** (кеш = пересчитываемая проекция, ветка `aggregates` DB-SCHEMA §1.5):
  `INSERT ... ON CONFLICT (provider,capability,args_hash) DO UPDATE SET value_json/created_at/expires_at`.
  Blanket `DO NOTHING` тут молча пинил бы stale — запрещено.
- **`providers` upsert-ится ДО первой записи `cache_entries`** — bootstrap из **всех 9**
  `adapterRegistrations` (включая `pg-history`, F-2), иначе FK `cache_entries.provider → providers(id)`
  нарушается для любого адаптера.
- **`PRAGMA foreign_keys=ON` при КАЖДОМ открытии соединения** (SQLite не проверяет FK по умолчанию,
  DB-SCHEMA §1.6).
- **`DATA_DIR` по умолчанию — `os.homedir()/.onchain-intel`**, НЕ `process.cwd()`-relative (MCP-сервер
  стартует Claude Code с произвольным cwd; ARCHITECTURE §3.2). Файл — `${DATA_DIR}/cache.sqlite3`.
  В тестах — `:memory:` или временный каталог (`mkdtempSync`), не трогать домашний каталог разработчика.
- **`usage`-совместимость (R-14 acceptance):** будущая `usage(provider FK, day, credits_used)` FK-ится
  на тот же `providers`-реестр — DDL кеша это не блокирует; ревью подтверждает (комментарий в `ddl.ts`).
- **Hit/miss — в двух местах** (§3.2): stderr-строка `cache=hit|miss provider=<id> capability=<cap>
ageMs=<n>` (без args/секретов) + поле для `_meta.cache` (использует 003-7). `_meta` — **вне**
  `structuredContent`, схема выхода не растёт.

## Phase 1 — DDL/сигнатуры/стабы `[STUB CREATION]`

1. `pnpm-workspace.yaml` — `allowBuilds.better-sqlite3: true`; `pnpm install` собирает нативный addon.
2. `ddl.ts` — финальный DDL (это декларация, не логика).
3. `sqlite-store.ts`/`lru.ts`/`two-level-store.ts`/`ttl.ts`/`stats.ts`/`data-dir.ts` — сигнатуры +
   стаб-тела (`get` всегда miss, `set` no-op).
4. Тесты red.
5. **Verification Phase 1:**

```bash
pnpm install                                                                 # собирает better-sqlite3 нативно
pnpm --filter @onchain-intel/core exec node -e "const D=require('better-sqlite3'); new D(':memory:'); console.log('sqlite-native-ok')"
pnpm --filter @onchain-intel/core exec tsc --noEmit                          # 0 ошибок
```

## Phase 2 — Логика `[LOGIC IMPLEMENTATION]`

1. `SqliteCacheStore` — открытие (`foreign_keys=ON`, WAL), bootstrap `providers` (upsert 9 регистраций),
   `get` (SELECT по UNIQUE-ключу + проверка `expires_at > now`), `set` (upsert + `expires_at =
now + ttlFor(capability)*1000`).
2. `lru.ts` — TTL-встроенный `set`; `two-level-store.ts` — lru→sqlite→miss, `set` в оба.
3. `stats.ts` — инкремент hit/miss; stderr-строка на каждый `resolve()`; `getCacheStats()`.
4. `registry.resolve()` — подключить `TwoLevelStore` + инкремент stats + вернуть `cache:'hit'|'miss'`+`ageMs`.
5. Тесты: hit/miss обоих уровней (первый miss → второй hit в TTL; истёкший TTL → miss); upsert обновляет
   значение (не пинит stale); `PRAGMA foreign_keys=ON` активна; ключ стабилен к порядку args (через
   `deriveArgsHash` из 003-2); `getCacheStats()` считает корректно.

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/cache.test.ts         # R-13/R-14: hit/miss/TTL/upsert/FK
pnpm --filter @onchain-intel/core exec vitest run test/cache-stats.test.ts   # R-15: счётчики
pnpm --filter @onchain-intel/core test                                       # весь core-сьют зелёный
# R-14: DDL только portable-типы + epoch-ms + ULID + FK:
grep -nE "PRAGMA foreign_keys\s*=\s*ON" packages/core/src/cache/*.ts         # включён при открытии
grep -niE "\b(DATETIME|TIMESTAMP|AUTOINCREMENT|BLOB|BOOLEAN)\b" packages/core/src/cache/ddl.ts && echo "REVIEW: non-portable type" || echo "portable-types-ok"
grep -nE "ON CONFLICT.*DO UPDATE" packages/core/src/cache/*.ts               # upsert-семантика (не DO NOTHING)
# R-13: DATA_DIR не cwd-relative:
grep -nE "homedir\(\)" packages/core/src/cache/data-dir.ts                   # дефолт = ~/.onchain-intel
# allowBuilds для нативного addon:
grep -nE "better-sqlite3:\s*true" pnpm-workspace.yaml                        # build одобрен
```

- **[R-13]** двухуровневый кеш; ключ `(provider,capability,argsHash)`; TTL по типу; unit-тест hit/miss
  обоих уровней.
- **[R-14]** DDL только `TEXT/INTEGER/REAL`; epoch-ms; ULID; `PRAGMA foreign_keys=ON`; 9 `providers`
  upsert-ятся до записи; `usage`-совместимость подтверждена комментарием/ревью.
- **[R-15]** повторный вызов → `cache=hit`, первый → `cache=miss`; видно в stderr + `_meta.cache`
  (последнее тестируется E2E в 003-7); проверяемо тестом.

> `usage`-таблицу/budget-guard **не писать** (M2, guard R-27) — только проектируем совместимость схемы.
> Кеш **не** живёт в Postgres (кикофф-решение §1 п.2).
