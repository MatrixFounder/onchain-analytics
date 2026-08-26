# Задача 015.02: SQLite-DDL — таблица `client_usage` и аддитивная колонка `usage.calls_made`

## Связь со сценариями

- UC-5 — фаза 0 работает на оси SQLite без Postgres
- UC-2 — ретрай с тем же `client_request_id` не списывает дважды

<!-- contract:goal -->

## Цель задачи

Объявить `client_usage` и колонку `usage.calls_made` на оси SQLite так, чтобы обе появлялись при
открытии `DATA_DIR` без Postgres.

**Why форма раньше писателей.** Леджер пишут задачи 015-06 и 015-07 на двух движках. Форма,
объявленная после первого писателя, переписывается на втором (прецедент T-014, задача 014-02).

**Why колонка вводится здесь.** Суточного счётчика вызовов в схеме нет (`docs/TASK.md` R-9.3).
Задачи 015-13…015-15 читают колонку, которой без этой задачи не существует.

<!-- contract:changes -->

## Описание изменений

### Изменения в существующих файлах

**Файл `packages/core/src/cache/ddl.ts`:**

- Добавить `CREATE TABLE IF NOT EXISTS client_usage (…)` в строку `CACHE_DDL`
  (`packages/core/src/cache/ddl.ts:48` — `export const CACHE_DDL`) по форме `data-model.md`
  §4.6.1
- Добавить три индекса `idx_client_usage_principal`, `idx_client_usage_terminal`,
  `idx_client_usage_reserved` следом за объявлением таблицы
- Добавить `calls_made INTEGER NOT NULL DEFAULT 0` и `CHECK (calls_made >= 0)` в объявление `usage`
  (`packages/core/src/cache/ddl.ts:68` — `CREATE TABLE IF NOT EXISTS usage (`)
- Добавить экспорт `USAGE_COLUMNS` по образцу `USAGE_WINDOW_COLUMNS`
  (`packages/core/src/cache/ddl.ts:344` — `export const USAGE_WINDOW_COLUMNS`) с одной записью
  `ALTER TABLE usage ADD COLUMN calls_made INTEGER NOT NULL DEFAULT 0`

**Why `client_usage` объявляется в `packages/core`, хотя её store живёт в `packages/mcp-server`.**
Строка `CACHE_DDL` уже несёт восемь таблиц семейства идентичности T-014
(`packages/core/src/cache/ddl.ts:118` — `-- ══ T-014 (task 014-36) — the eight engine tables`),
включая `request_trace` (`packages/core/src/cache/ddl.ts:239` —
`CREATE TABLE IF NOT EXISTS request_trace (`). Границу пакетов проводит `data-model.md` §4.6 по
писателю, а не по тексту DDL: писателя вводит задача 015-06.

**Why колонка объявляется дважды — в `CREATE TABLE` и в `ALTER`.** `CREATE TABLE IF NOT EXISTS`
ничего не делает с файлом, где таблица уже есть. Тот же двойной путь уже применён к
`usage_window.calls_made` (`packages/core/src/cache/ddl.ts:107` —
`CREATE TABLE IF NOT EXISTS usage_window (`).

**Why `CHECK (calls_made >= 0)` стоит только на пути `CREATE TABLE`.** `ALTER TABLE ADD COLUMN` в
SQLite ограничений таблицы не добавляет. Расхождение унаследовано от `usage_window` и записывается
комментарием рядом с записью `USAGE_COLUMNS`, а не заводится заново.

**Файл `packages/core/src/cache/budget-store.ts`:**

- Добавить приватный метод `migrateUsage(): void` по образцу `migrateUsageWindow()`
  (`packages/core/src/cache/budget-store.ts:258` — `private migrateUsageWindow(): void {`):
  чтение `PRAGMA table_info(usage)`, применение недостающих записей `USAGE_COLUMNS`
- Вызвать `this.migrateUsage()` рядом с существующим вызовом
  (`packages/core/src/cache/budget-store.ts:183` — `this.migrateUsageWindow();`), после
  `this.db.exec(CACHE_DDL)` (`packages/core/src/cache/budget-store.ts:182`)
- Импорт `USAGE_COLUMNS` добавить к существующему импорту
  (`packages/core/src/cache/budget-store.ts:6` — `import { CACHE_DDL, USAGE_WINDOW_COLUMNS }`)

### Состав `client_usage`

Тринадцать колонок, из них девять объявлены `NOT NULL`.

| Колонка             | Тип     | Пусто | Смысл                                                    |
| :------------------ | :------ | :---- | :------------------------------------------------------- |
| `id`                | TEXT    | нет   | ULID; объявлен `TEXT PRIMARY KEY NOT NULL`               |
| `principal_id`      | TEXT    | нет   | `api_tokens.id` либо `local` — метка, не внешний ключ    |
| `access_profile_id` | TEXT    | да    | у локального принципала профиля нет (R-7.5)              |
| `client_request_id` | TEXT    | нет   | принятое значение клиента либо выпущенное сервером       |
| `tool`              | TEXT    | нет   | имя тула — известно в точке резерва всегда               |
| `capability`        | TEXT    | да    | статически объявленная способность тула либо пусто       |
| `price_raw`         | TEXT    | нет   | применённая цена, скопированная в момент резерва         |
| `state`             | TEXT    | нет   | `reserved`, `settled` либо `refunded`                    |
| `refund_reason`     | TEXT    | да    | имя класса либо `expired`, только при `state='refunded'` |
| `reserved_at`       | INTEGER | нет   | epoch-ms UTC, пишется один раз                           |
| `terminal_at`       | INTEGER | да    | epoch-ms UTC ухода из `reserved` — якорь ретенции        |
| `created_at`        | INTEGER | нет   | epoch-ms UTC                                             |
| `updated_at`        | INTEGER | нет   | epoch-ms UTC                                             |

**Why `id` несёт слово `NOT NULL` рядом с `PRIMARY KEY`.** SQLite допускает `NULL` в колонке
`TEXT PRIMARY KEY`, Postgres — нет (`data-model.md` §4.5.2a). Тот же приём уже применён к восьми
таблицам T-014 и проверяется тестом (`packages/core/test/engine-ddl.test.ts:96` —
`spells NOT NULL beside every ULID primary key`).

**Why `price_raw` объявлен `TEXT`.** `DB-SCHEMA-CONCEPT` §1 п.7 называет кредиты случаем, требующим
строки: значение выходит за безопасные 2^53 числа JS. Ту же форму уже несёт
`access_profiles.credits_balance_raw` (`packages/core/src/cache/ddl.ts:155`).

**Why `principal_id` — метка, а не внешний ключ.** У принципала локального профиля строки токена
нет. Внешний ключ отверг бы запись на том транспорте, которому токен не нужен — то же решение уже
принято для `request_trace.principal_id`.

### Ключ дедупликации

`UNIQUE (principal_id, client_request_id)`

**Why без `received_at`.** Ключ `request_trace` — `(principal_id, client_request_id, received_at)`
(`packages/core/src/cache/ddl.ts:265` — `UNIQUE (principal_id, client_request_id, received_at)`), и
время в нём стоит нарочно: ретрай пишет вторую строку следа. Ключ той же формы в леджере списал бы
ретрай дважды (R-5.1, AC-12).

### Ограничения и индексы

Ограничения:

- `CHECK (state IN ('reserved','settled','refunded'))`
- `CHECK ((state = 'refunded') = (refund_reason IS NOT NULL))`
- `CHECK ((state = 'reserved') = (terminal_at IS NULL))`

Индексы:

- `idx_client_usage_principal (principal_id, reserved_at)` — периодный запрос по принципалу
- `idx_client_usage_terminal (terminal_at)` — ретенция 015-19 и агрегат `sumSettled` 015-07
- `idx_client_usage_reserved (state, reserved_at)` — скан фоновой сверки 015-18

**Why третье ограничение связывает `terminal_at` с уходом из `reserved`.** Запрос ретенции
фильтрует по `terminal_at` и не ветвится по `state` отдельно (`data-model.md` §4.6.1).

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

Новый файл `packages/core/test/ddl-client-usage.test.ts`.

1. **TC-UNIT-01:** таблица и три индекса появляются на свежей базе
   - Входные данные: открытие `:memory:`-базы через `SqliteBudgetStore`
   - Ожидаемый результат: `PRAGMA table_info(client_usage)` даёт тринадцать колонок; девять из них
     несут `notnull = 1`; `PRAGMA index_list(client_usage)` называет три индекса
2. **TC-UNIT-02:** дедуп-ключ объявлен без времени приёма
   - Входные данные: `PRAGMA index_list(client_usage)` и `PRAGMA index_info` уникального индекса
   - Ожидаемый результат: колонки ключа — `principal_id` и `client_request_id`; `reserved_at` и
     `created_at` в ключ не входят
   - Падает при мутации: добавление третьего компонента в `UNIQUE`
3. **TC-UNIT-03:** `state` принимает три значения и отвергает четвёртое
   - Входные данные: `INSERT` со значением `'pending'`
   - Ожидаемый результат: ограничение отвергает вставку
4. **TC-UNIT-04:** `refund_reason` заполнен тогда и только тогда, когда `state = 'refunded'`
   - Входные данные: две строки — `refunded` без причины и `settled` с причиной
   - Ожидаемый результат: обе отвергнуты
5. **TC-UNIT-05:** `terminal_at` пуст тогда и только тогда, когда `state = 'reserved'`
   - Входные данные: две строки — `reserved` с `terminal_at` и `settled` без него
   - Ожидаемый результат: обе отвергнуты
6. **TC-UNIT-06:** `price_raw` хранится как `TEXT` и читается байт-в-байт
   - Входные данные: значение `'9007199254740993'`
   - Ожидаемый результат: чтение возвращает ту же строку; `typeof` результата — строка
   - Падает при мутации: объявление колонки `INTEGER`
7. **TC-UNIT-07:** колонка `usage.calls_made` появляется на свежей базе с умолчанием `0`
   - Входные данные: `PRAGMA table_info(usage)`
   - Ожидаемый результат: колонка есть, `dflt_value` равен `0`, `notnull = 1`
8. **TC-UNIT-08:** миграция колонки идемпотентна при повторном открытии файла
   - Входные данные: файловая база, открытая дважды подряд
   - Ожидаемый результат: второе открытие ошибки не даёт; число колонок `usage` не растёт
   - Падает при мутации: снятие проверки `PRAGMA table_info` перед `ALTER`
9. **TC-UNIT-09:** база, созданная до колонки, получает её без бэкфилла
   - Входные данные: файл с одной строкой `usage`, записанной до миграции
   - Ожидаемый результат: после открытия строка несёт `calls_made = 0`, `credits_used` не изменён

### Регрессионные тесты

- `pnpm --filter @onchain-intel/core test` — `engine-ddl.test.ts`, `budget-store.test.ts`,
  `budget-velocity.test.ts` остаются зелёными
- `pnpm typecheck`, `pnpm test`

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] AC-3 (ось SQLite) — DDL-гейт: `client_usage` отделена от `usage` и `usage_window`,
      `price_raw` объявлен `TEXT`
- [ ] AC-12 (ось SQLite) — дедуп-ключ `(principal_id, client_request_id)` не содержит времени приёма
- [ ] AC-14 (часть) — таблица создаётся при открытии `DATA_DIR` без Postgres
- [ ] Три `CHECK`-ограничения объявлены: множество состояний, связь `refund_reason` с `refunded`,
      связь `terminal_at` с уходом из `reserved`
- [ ] Три индекса объявлены: `(principal_id, reserved_at)`, `(terminal_at)`, `(state, reserved_at)`
- [ ] `usage.calls_made` добавляется по паттерну `USAGE_WINDOW_COLUMNS`: `PRAGMA table_info`,
      `DEFAULT 0`, без бэкфилла
- [ ] Тест на повторное открытие базы зелёный: миграция колонки идемпотентна

## Примечания

Ось Postgres — задача 015-03 (`sql/migrations/…`), она же несёт `ALTER TABLE onchain.usage ADD
COLUMN calls_made` и CHECK формата на `credits_balance_raw` (MINOR-7 раунда 2).

Задача в перечень `STATE_TABLES` (`packages/core/src/pg/state-client.ts:87` — `export const
STATE_TABLES = [`) `client_usage` не добавляет. Три файла этой правки — перечень,
`packages/core/test/sqlite-state-client.test.ts:57` (`expect(STATE_TABLES.length).toBe(12);`) и
`packages/core/test/pg-store-parity.test.ts:622` (`STATE_TABLES names exactly the tables migration
002 creates`) — принадлежат задаче 015-03.

**Why владелец там.** Сверка перечня читает `sql/migrations/004_t015_billing.sql`, а создаёт этот
файл задача 015-03.

Строку `CACHE_DDL` исполняют два открывателя: `packages/core/src/cache/budget-store.ts:182` и
`packages/core/src/sqlite/state-client.ts:101` (`opened.exec(CACHE_DDL);`). Миграция колонки
`usage` нужна только там, где `usage` пишется, то есть в `SqliteBudgetStore`.

Store над `client_usage` вводит задача 015-04 (стаб) и заменяет задача 015-06. Эта задача writer'а
не создаёт.
