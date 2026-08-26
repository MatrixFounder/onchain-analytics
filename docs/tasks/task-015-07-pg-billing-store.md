# Задача 015.07: реализация `BillingStore` на оси Postgres — две ветви режима, арифметика `numeric`, `sumSettled`

## Связь со сценариями

- UC-1 — клиент списывается на границе тула независимо от исхода кеша
- UC-2 — ретрай с тем же `client_request_id` не списывает дважды

<!-- contract:goal -->

## Цель задачи

Заменить стаб `BillingStore` реализацией над Postgres так, чтобы резерв, списание, возврат и
учётный агрегат работали на авторитетной оси хранилища.

**Why ось Postgres отдельной задачей от оси SQLite.** Ветвь `metered` на Postgres — транзакция из
двух операторов над двумя таблицами; на SQLite тот же путь идёт синхронно внутри
`db.transaction(fn).immediate()`. Одна задача на два движка правила бы одну границу дважды.

**Why только строки Postgres авторитетны.** R-7.3 — учётный запрос читает эту ось и никакую другую.
Агрегат `sumSettled` существует здесь и отказывает на оси SQLite (задача 015-04).

<!-- contract:changes -->

## Описание изменений

### Изменения в существующих файлах

**Файл `packages/mcp-server/src/engine/billing-store.ts`:**

- Заменить стаб задачи 015-04 функцией `createBillingStore(engine: EngineStore, profiles:
AccessProfileReader): BillingStore` по образцу `createRequestTraceStore`
  (`packages/mcp-server/src/engine/request-trace-store.ts:235` —
  `export function createRequestTraceStore(engine: EngineStore): RequestTraceStore {`)
- Реализовать `reserve`, `settle`, `refund`, `sumSettled` по `system-architecture.md` §3.5.1 и
  `data-model.md` §4.6.1
- Все имена таблиц брать через `engine.qualify(...)`, ни одного литерала `onchain.client_usage`

**Файл `packages/mcp-server/src/engine/pg-engine-store.ts`:**

- Расширить сообщение `UnknownEngineTableError` (`packages/mcp-server/src/engine/pg-engine-store.ts:28`
  — `the twelve tables of data-model.md §4.4 are`) до тринадцати таблиц
- Тип `EngineTable` (`packages/mcp-server/src/engine/pg-engine-store.ts:23` —
  `export type EngineTable = (typeof STATE_TABLES)[number];`) принимает `client_usage` после того,
  как задача 015-03 внесла имя в `STATE_TABLES` (`packages/core/src/pg/state-client.ts:87` —
  `export const STATE_TABLES = [`); имя этой задачей не вносится

**Why правка сообщения обязательна.** Сообщение перечисляет таблицы поимённо и после тринадцатой
называет неверное число. Класс тот же, что MINOR-6 раунда 2: ложное утверждение вплотную к новому
полю.

### Ветвь `credits_mode='unlimited'` — один оператор

```sql
INSERT INTO onchain.client_usage
  (id, principal_id, access_profile_id, client_request_id, tool, capability,
   price_raw, state, reserved_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $8, $8)
ON CONFLICT (principal_id, client_request_id) DO NOTHING
RETURNING id, state;
```

Пустой `RETURNING` означает, что строка по этому `client_request_id` уже существует. Реализация
читает её и возвращает `BillingReservation` с признаком `existing`, а второй строки не пишет.

**Why признак берётся из `RETURNING`, а не из отдельного `SELECT`.** Отдельное чтение — второй
круговой рейс, между которым и вставкой помещается конкурент. Форма повторяет уже применённую в
`request_trace` (`packages/mcp-server/src/engine/request-trace-store.ts:247` —
`ON CONFLICT (principal_id, client_request_id, received_at) DO NOTHING`).

### Ветвь `credits_mode='metered'` — одна транзакция из двух операторов

Порядок внутри `engine.transaction(...)`
(`packages/mcp-server/src/engine/pg-engine-store.ts:61` —
`transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T>;`):

1. Тот же условный `INSERT`. Пустой `RETURNING` — существующая строка отвечает на этот
   `client_request_id`; баланс не трогается, транзакция завершается чтением.
2. Только при вставленной новой строке — дебет баланса:

   ```sql
   UPDATE onchain.access_profiles
      SET credits_balance_raw = (credits_balance_raw::numeric - $2::numeric)::text
    WHERE id = $1 AND credits_balance_raw::numeric >= $2::numeric
   RETURNING credits_balance_raw;
   ```

3. Пустой `RETURNING` на шаге 2 — недостаток баланса: `ROLLBACK`, отказ классом
   `ClientCreditsExhaustedError`, обе таблицы не изменены.
4. `COMMIT`.

**Why идемпотентность стоит первой.** Ретрай, чей первый заход уже списал баланс, на обратном
порядке списал бы второй раз. Порядок «сначала ключ, потом деньги» — прямое требование
`system-architecture.md` §3.5.1.

**Why отказ ничего не пишет.** Тот же контракт уже несёт `checkAndReserve`
(`packages/core/src/cache/budget-store.ts:50` — ``NOTHING is written — `usage` is left
bit-for-bit``). Пара «резерв и его отмена» записала бы обязательство, которого не возникало.

### Арифметика баланса

- Сравнение и вычитание на Postgres идут через `numeric`, никогда через `float` или
  `double precision`
- На стороне JS величина остаётся строкой; любое вычисление над ней ведётся `BigInt`, никогда
  `Number` (CLAUDE.md, «BigInt, never Number»)
- `price_raw` и `credits_balance_raw` — обе `TEXT`, поэтому резерв сравнивает два целых, записанных
  строкой

**Why приведение к `numeric` обязательно.** Текстовое сравнение читает `'9' > '10'` как истину.
Приведение делает сравнение числовым, и лексикографическая ошибка становится невыразимой.

### MINOR-7 раунда 2: неразрешимое сравнение отказывает

`credits_balance_raw` объявлена `TEXT` без ограничения формата
(`packages/core/src/cache/ddl.ts:155` — `credits_balance_raw   TEXT,`), а `numeric` в Postgres
принимает `'NaN'` и сортирует его выше всех значений. Условие `>=` тогда истинно при любой цене.

Реализация отказывает, а не разрешает расход, когда сравнение не даёт ответа:

- перед транзакцией проверяется, что `priceRaw` — целое без знака в десятичной записи;
- значение баланса, не разбираемое как целое, даёт отказ с названием профиля и без расхода;
- вторая половина правки — CHECK формата в миграции T-015 (задача 015-03).

**Why это правило, а не молчаливый пропуск.** Тот же fail-closed уже применён к вендорскому гейту
(`packages/core/src/cache/budget-store.ts:312` — `FAIL CLOSED when the comparison below cannot
decide`, и `:315` — ``a `>` test must not authorise spend when it has no answer``). Клиентский гейт
унаследовал тип колонки и обязан унаследовать оговорку.

### Чтение режима принципала

`credits_mode` читается через существующий `AccessProfileReader`
(`packages/mcp-server/src/auth/access-profile.ts:72` — `export interface AccessProfileReader {`),
поле `creditsMode` объявлено на `AccessProfile`
(`packages/mcp-server/src/auth/access-profile.ts:44` — `export interface AccessProfile {`).
Отдельного пути к таблице профилей реализация не заводит.

**Why дебет при этом — собственный оператор.** `AccessProfileReader` — асинхронный поставщик за
интерфейсом, атомарности с конкурентной записью он не обещает. R-6.1 читается как «режим идёт через
читателя», а не «атомарная запись идёт через читателя» (`data-model.md` §4.6.1). Сужение записано
архитектурой, здесь оно исполняется.

**Why отсутствующее поле не читается как безлимит.** Режим объявлен явно, и связь режима со
значением закрыта ограничением схемы (`packages/core/src/cache/ddl.ts:171` —
`CHECK ((credits_mode = 'metered') = (credits_balance_raw IS NOT NULL))`). Прецедент L-10: уверенный
ноль вместо отказа.

### Учётный агрегат `sumSettled`

```sql
SELECT COALESCE(SUM(price_raw::numeric), 0)::text
  FROM onchain.client_usage
 WHERE state = 'settled' AND terminal_at >= $1 AND terminal_at < $2;
```

Читает только Postgres. Индекс `idx_client_usage_terminal` уже объявлен задачей 015-02, нового
индекса задача не вводит.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

Новый файл `packages/mcp-server/test/billing-store-pg.test.ts`.

1. **TC-UNIT-01:** ветвь `unlimited` — один оператор, вторая вставка строки не создаёт
   - Входные данные: два `reserve()` с одним `(principalId, clientRequestId)`
   - Ожидаемый результат: одна строка; второй вызов возвращает `existing: true`
2. **TC-UNIT-02:** ветвь `metered` при достаточном балансе списывает цену строки и ничего сверх
   - Входные данные: баланс `'100'`, цена `'1'`
   - Ожидаемый результат: `credits_balance_raw` равен `'99'`; строка `client_usage` в состоянии
     `reserved`
3. **TC-UNIT-03:** ветвь `metered` при недостатке баланса откатывает обе таблицы
   - Входные данные: баланс `'0'`, цена `'1'`
   - Ожидаемый результат: отказ классом `ClientCreditsExhaustedError`; `client_usage` пуста;
     `credits_balance_raw` не изменён
   - Падает при мутации: вынос `INSERT` наружу транзакции
4. **TC-UNIT-04:** ретрай под `metered` не списывает баланс во второй раз
   - Входные данные: два `reserve()` с одним `clientRequestId`, баланс `'100'`, цена `'1'`
   - Ожидаемый результат: `credits_balance_raw` равен `'99'` после обоих вызовов
   - Падает при мутации: перестановка дебета перед вставкой
5. **TC-UNIT-05:** под `unlimited` резерв не отклоняется по балансу никогда
   - Входные данные: профиль `unlimited` с `credits_balance_raw = NULL`
   - Ожидаемый результат: резерв успешен; оператор дебета не исполняется
6. **TC-UNIT-06:** сравнение баланса, не дающее ответа, отказывает
   - Входные данные: `credits_balance_raw = 'NaN'`, цена `'1'`
   - Ожидаемый результат: отказ; `client_usage` пуста; баланс не изменён
   - Падает при мутации: снятие проверки разбора значения
7. **TC-UNIT-07:** цена вне десятичной записи целого отвергается до транзакции
   - Входные данные: `priceRaw = '1.5'` и `priceRaw = '-1'`
   - Ожидаемый результат: оба отвергнуты; ни одного оператора не отправлено
8. **TC-UNIT-08:** арифметика точна за пределом 2^53
   - Входные данные: баланс `'9007199254740993'`, цена `'1'`
   - Ожидаемый результат: `credits_balance_raw` равен `'9007199254740992'`
   - Падает при мутации: разбор баланса через `Number`
9. **TC-UNIT-09:** `sumSettled` читает только Postgres
   - Входные данные: строки `settled` на обеих осях за один период
   - Ожидаемый результат: сумма равна сумме строк Postgres; строки SQLite в неё не входят
10. **TC-UNIT-10:** `sumSettled` за период с кеш-хитом не равна вендорскому расходу за тот же период
    - Входные данные: серия вызовов, часть которых обслужена кешем
    - Ожидаемый результат: сумма `settled` больше суммы `usage`/`usage_window` за тот же период
11. **TC-UNIT-11:** каждое имя таблицы проходит через `engine.qualify`
    - Входные данные: перехваченные тексты операторов
    - Ожидаемый результат: ни одного вхождения `client_usage` без префикса `onchain.`
    - Падает при мутации: литерал имени таблицы в шаблоне

### Регрессионные тесты

- `pnpm --filter @onchain-intel/mcp-server test` — `engine-store-contracts.test.ts` и
  `request-trace-store.test.ts` остаются зелёными
- `pnpm --filter @onchain-intel/core test` — `pg-store-parity.test.ts` зелёный в редакции задачи
  015-03: сверка перечня читает объединение миграций 002 и 004
- `pnpm typecheck`, `pnpm test`

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] AC-4 — сумма `settled` за период с кеш-хитом не равна сумме `usage` и `usage_window` за тот
      же период
- [ ] AC-13 — резерв под `metered` с исчерпанным балансом отклоняется классом
      `ClientCreditsExhaustedError`; под `unlimited` не отклоняется никогда
- [ ] AC-15 — учётный агрегат `sumSettled` читает только Postgres
- [ ] Ветвь `unlimited` — один оператор `INSERT … ON CONFLICT DO NOTHING`
- [ ] Ветвь `metered` — одна транзакция из двух операторов; при недостатке баланса откат оставляет
      обе таблицы нетронутыми
- [ ] Арифметика баланса идёт через `numeric` на Postgres и `BigInt` на JS-стороне, никогда через
      `Number`
- [ ] MINOR-7 раунда 2 — сравнение баланса, не дающее ответа, отказывает вместо разрешения расхода
- [ ] `credits_mode` читается через существующий `AccessProfileReader`; отдельного пути к таблице
      профилей нет

## Примечания

Зависимости: 015-03 (миграция и `STATE_TABLES`), 015-04 (интерфейс и класс отказа), 015-05
(прайс-лист, источник `priceRaw`).

Ветвь `metered` в фазе 0 не исполняется: сеяный профиль `phase0-unlimited` несёт
`credits_mode='unlimited'` (`packages/core/src/cache/ddl.ts:318` — `credits_mode,
credits_balance_raw`). Ветвь проверяется тестом, а не продуктивным трафиком — это её единственный
исполнитель до первого платящего клиента.

Задача несёт риск превышения оценки вдвое (`docs/PLAN.md` § Оценка этапа): арифметика на `numeric`
и гонка двух резервов на одном профиле. Гонку разрешает уникальный индекс ключа и блокировка строки
профиля, а не код обработчика.

Окно реплея (`ReplayWindowExpiredError`, R-5.6/R-5.7) принадлежит задаче 015-08 и здесь не
реализуется.

`settle` и `refund` объявлены здесь как условный `UPDATE … WHERE state = 'reserved'`. Их
размещение относительно `withTrace` и условие кредитования баланса принадлежат задаче 015-10
(MAJOR-B и MAJOR-C раунда 2).
