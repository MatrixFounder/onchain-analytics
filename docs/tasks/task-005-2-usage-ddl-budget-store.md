# Task 005-2 — [R-34/R-35] таблица `usage` + `BudgetStore` + `SqliteBudgetStore`

| Поле                    | Значение                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                    |
| **Тип**                 | Dev (Stub-First: Phase 1 DDL + интерфейс + стаб-стор → Phase 2 SQLite-реализация)         |
| **R-IDs**               | **R-34**, **R-35**                                                                        |
| **Зависимости**         | 005-1 (`nansen` в `adapterRegistrations` — иначе первый `INSERT INTO usage` падает по FK) |
| **Разблокирует**        | 005-3 (гейт вызывает `checkAndReserve`), 005-6 (`_meta.budget` читает `getUsage`)         |
| **Источники**           | data-model §4.2 + system-architecture §3.2 + DB-SCHEMA §1 — см. ниже                      |
| **Живые кредиты**       | **0** — чистая работа с SQLite, сети нет                                                  |

## Источники

- [data-model.md](../architectures/data-model.md) §4.2 — DDL + upsert.
- [system-architecture.md](../architectures/system-architecture.md) §3.2 «M2-дополнение:
  `BudgetStore`».
- DB-SCHEMA-CONCEPT §1 — portable-конвенции.

## Цель

Дать движку **provider-agnostic леджер кредитов**: `usage`-таблицу в той же кеш-БД (без миграции
`providers`/`cache_entries`) и `BudgetStore` с атомарным check-and-reserve. Стор ничего не знает
про Nansen — он принимает уже готовый bucket-relative `ceiling` и сравнивает его с
`usage.credits_used(bucket) + cost`.

## Контекст: файлы

**Новые:**

- `packages/core/src/cache/budget-store.ts` — `interface BudgetStore`, `SqliteBudgetStore`,
  `SqliteBudgetStoreOptions`, `createBudgetStore()` (фабрика — тот же принцип, что `createCacheStore`).
- `packages/core/src/cache/day-bucket.ts` — `dayBucketMs(ts: number): number` =
  `Math.floor(ts / 86_400_000) * 86_400_000` (один экспорт, используется и гейтом, и tool-хендлерами).
- `packages/core/test/budget-store.test.ts`.

**Правки:**

- `packages/core/src/cache/ddl.ts` — `usage`-таблица дописывается в тот же `CACHE_DDL` (место уже
  подготовлено forward-compat комментарием с M1; комментарий обновляется с «M2 — вне скоупа» на
  фактическое описание).
- `packages/core/src/index.ts` — экспорт `type BudgetStore`, `createBudgetStore`, `dayBucketMs`.

## DDL (буквально из [data-model.md](../architectures/data-model.md) §4.2)

```sql
CREATE TABLE IF NOT EXISTS usage (
  provider     TEXT NOT NULL REFERENCES providers(id),
  day          INTEGER NOT NULL,           -- epoch-ms UTC bucket start: floor(ts/86400000)*86400000
  credits_used INTEGER NOT NULL DEFAULT 0, -- АДДИТИВНЫЙ счётчик, never overwritten
  updated_at   INTEGER NOT NULL,           -- epoch-ms UTC, только наблюдаемость
  PRIMARY KEY (provider, day)
);
```

Обе фазы записи (резервация и реконсиляция) — **один и тот же** SQL:

```sql
INSERT INTO usage (provider, day, credits_used, updated_at)
VALUES (@provider, @day, @delta, @now)
ON CONFLICT (provider, day) DO UPDATE SET
  credits_used = MAX(0, credits_used + excluded.credits_used),
  updated_at   = excluded.updated_at;
```

## Интерфейс (буквально из [system-architecture.md](../architectures/system-architecture.md) §3.2)

```ts
export interface BudgetStore {
  checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  recordDelta(provider: string, dayBucketMs: number, signedDelta: number): Promise<void>;
  getUsage(provider: string, dayBucketMs: number): Promise<number>;
}
```

## Reviewer-заметки (обязательно применить)

- **`day` — `INTEGER` epoch-ms bucket, НЕ строковая дата.** ADR-001 D6 называет колонку «day», но
  буквальная строка-дата противоречит канону DB-SCHEMA §1.2. Только `TEXT`/`INTEGER`/`REAL`.
- **`credits_used` — `INTEGER`, а не `value_raw TEXT`.** Это малый внутренний счётчик движка в
  пределах безопасного JS-number, не canonical-наблюдение произвольной точности — исключение из
  правила `value_raw` задокументировано в R-34 и не является нарушением канона.
- **Аддитивный upsert, НЕ overwrite** (в отличие от `cache_entries.set()`): blanket
  `DO UPDATE SET credits_used = excluded.credits_used` потерял бы резервацию.
- **`MAX(0, …)` — belt-and-braces:** `@delta` знаковая (реконсиляция может дать отрицательную), но
  колонка обязана оставаться неотрицательной по построению.
- **`db.transaction(fn).immediate()` — `IMMEDIATE`, не `DEFERRED`.** С `DEFERRED` конкурентная запись
  другого процесса между read и upgrade-to-write даёт `SQLITE_BUSY_SNAPSHOT` **немедленно**, мимо
  busy-handler (WAL-специфика, не гипотетическая). Тело `fn` — **строго синхронное**, ни одного
  `await`: вся atomicity-гарантия держится на этом (сигнатура снаружи `Promise<…>` — ради
  единообразия с `CacheStore` и будущего Postgres-бэкенда D7).
- **`new Database(path, { timeout: 5000 })`** — не дефолтный 0мс: `DATA_DIR` по умолчанию общий на
  машину, несколько stdio-сессий Claude Code = несколько writer-соединений к одному файлу.
- **`PRAGMA foreign_keys=ON` — на ЭТОМ соединении** (прагма connection-scoped, не персистится в
  файле; CLAUDE.md/DB-SCHEMA §1.6 требуют «каждое» соединение). Плюс `journal_mode=WAL`, как у
  `SqliteCacheStore`.
- **Self-sufficient bootstrap:** конструктор выполняет `db.exec(CACHE_DDL)` и **сам** upsert-ит
  `providers` из `options.providers ?? adapterRegistrations` **до** любой записи в `usage`. Полагаться
  на порядок конструирования («сначала `SqliteCacheStore`») — временная связанность, которую ни один
  тест не поймает, а первая же изолированная `SqliteBudgetStore({dbPath:':memory:'})` встретит как
  непонятную FK-ошибку, похожую на баг бюджета.
- **Отказ `checkAndReserve` НИЧЕГО не пишет** — это не «откат», а «нет записи»: `usage` остаётся
  побитово тем же (проверяется тестом до/после).
- **`recordDelta` не гейтует** — безусловная аддитивная запись; вызывающий уже прошёл `checkAndReserve`.
- **`BudgetStore` не знает про якоря/`usageAtObserve`/`NansenAccountSnapshot`** — принимает готовый
  скаляр `ceiling`. Метода «прочитать потолок» здесь нет **намеренно** (принятое сужение R-35, PLAN
  §0.2 п.11) — потолок Nansen-специфичен и живёт в `NansenAccountState` (005-3).
- **В тестах — `:memory:` или `mkdtempSync`**, никогда домашний каталог разработчика.

## Phase 1 — DDL + интерфейс + стаб `[STUB CREATION]`

1. `ddl.ts` — `usage` дописана в `CACHE_DDL` (это декларация, не логика — финальный вид сразу).
2. `budget-store.ts` — интерфейс + `SqliteBudgetStore` со стаб-телами (`checkAndReserve` →
   `{ok:true}`, `getUsage` → `0`, `recordDelta` → no-op) + `createBudgetStore`.
3. `day-bucket.ts` — реальная функция (одна строка, логики нечего стабить).
4. Тесты red.
5. **Verification Phase 1:**

```bash
pnpm --filter @onchain-intel/core exec tsc --noEmit
pnpm --filter @onchain-intel/core test        # существующий сьют (включая cache.test.ts) зелёный
```

## Phase 2 — логика `[LOGIC IMPLEMENTATION]`

1. Конструктор: открытие с `timeout`, прагмы, `db.exec(CACHE_DDL)`, bootstrap `providers`,
   `prepare()` трёх statement'ов (переиспользуемые, как в `SqliteCacheStore`).
2. `checkAndReserve` — `db.transaction(fn).immediate()`: SELECT текущего `credits_used` → сравнение
   `used + cost <= ceiling` → при успехе аддитивный upsert `@delta = cost`, при неуспехе — return
   `{ok:false, reason}` **без записи**.
3. `recordDelta` / `getUsage`.
4. Тесты (см. ниже).

## Test Cases

1. **TC-UNIT-01 (R-34, аддитивность):** два `recordDelta(+5)` подряд в тот же бакет → `getUsage === 10`
   (не `5` — доказывает, что upsert аддитивный, а не замещающий).
2. **TC-UNIT-02 (R-34, знаковая дельта):** `recordDelta(+10)` затем `recordDelta(-4)` → `6`.
3. **TC-UNIT-03 (R-34, зажим):** `recordDelta(+3)` затем `recordDelta(-10)` → `0`, не отрицательное.
4. **TC-UNIT-04 (R-34, разные бакеты/провайдеры независимы):** запись в `day=D1` не влияет на `D2`.
5. **TC-UNIT-05 (R-37-подготовка, отказ ничего не пишет):** `checkAndReserve(cost=150, ceiling=100)`
   → `{ok:false}` **и** `getUsage` до/после идентичен.
6. **TC-UNIT-06 (R-35, FK):** `pragma foreign_keys` на соединении стора === 1; `recordDelta` с
   **незарегистрированным** провайдером падает по FK (доказывает, что прагма реально действует).
7. **TC-UNIT-07 (R-35, self-bootstrap):** `new SqliteBudgetStore({dbPath: ':memory:'})` **в
   одиночку**, без `SqliteCacheStore`, успешно пишет `usage` для `'nansen'`.
8. **TC-UNIT-08 (R-35, атомарность):** два конкурентных `checkAndReserve(cost=60, ceiling=100)`,
   запущенных без `await` между ними → ровно один `{ok:true}`, `getUsage === 60`.
9. **TC-UNIT-09 (граница):** `used + cost === ceiling` → **проходит** (`<=`, не `<`).

## Acceptance (команды — RF-1-safe)

```bash
pnpm --filter @onchain-intel/core exec vitest run test/budget-store.test.ts
pnpm --filter @onchain-intel/core exec vitest run test/cache.test.ts   # cache_entries не сломан
pnpm --filter @onchain-intel/core test
# R-34: portable-типы, epoch-ms, аддитивный upsert:
grep -niE "\b(DATETIME|TIMESTAMP|AUTOINCREMENT|BLOB|BOOLEAN)\b" packages/core/src/cache/ddl.ts && echo "REVIEW: non-portable type" || echo "portable-types-ok"
grep -nE "MAX\(0, credits_used \+ excluded\.credits_used\)" packages/core/src/cache/budget-store.ts packages/core/src/cache/ddl.ts
# R-35: IMMEDIATE-транзакция + busy-timeout + FK-прагма:
grep -nE "\.immediate\(\)" packages/core/src/cache/budget-store.ts
grep -nE "timeout: 5000" packages/core/src/cache/budget-store.ts
grep -nE "PRAGMA foreign_keys\s*=\s*ON" packages/core/src/cache/budget-store.ts
# тело транзакции синхронно — ни одного await внутри:
grep -nE "transaction\(" -A 20 packages/core/src/cache/budget-store.ts | grep -n "await" && echo "REVIEW: await inside transaction body" || echo "sync-transaction-ok"
```

- **[R-34]** `usage` в том же `CACHE_DDL`, portable-типы, `day` — epoch-ms bucket, `credits_used` —
  `INTEGER`, аддитивный upsert с `MAX(0,…)`; `providers`/`cache_entries` не мигрируют.
- **[R-35]** `BudgetStore` (3 метода) + `SqliteBudgetStore` (своё соединение, `timeout`, FK-прагма,
  self-bootstrap, `immediate()`-транзакция, синхронное тело); отказ ничего не пишет; инжектируем.

## Notes

> Формула потолка (`effectiveCeiling`), `costOf()`, `/account` — **не здесь** (005-3). Этот модуль
> обязан остаться Nansen-агностичным: единственное упоминание `'nansen'` допустимо только в тестах
> как строковый id провайдера.
