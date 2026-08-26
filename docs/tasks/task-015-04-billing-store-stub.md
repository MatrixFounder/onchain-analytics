# Задача 015.04: интерфейс `BillingStore`, классы отказа и носитель класса в неуспешной ветви `[STUB]`

## Связь со сценариями

- UC-1 — клиент списывается на границе тула независимо от исхода кеша
- UC-2 — ретрай с тем же `client_request_id` не списывает дважды
- UC-5 — фаза 0 работает на оси SQLite без Postgres

<!-- contract:goal -->

## Цель задачи

Объявить контракт `BillingStore` и три класса отказа до того, как две оси хранилища начнут его
реализовывать.

**Why контракт раньше реализаций.** Задачи 015-06 и 015-07 пишут один и тот же леджер на двух
движках. Контракт, выведенный из первой реализации, переписывается на второй — прецедент T-014,
задача 014-02.

**Why класс отказа объявляется здесь.** Псевдокод перехвата читает `reserved.errorClass`
(`system-architecture.md:4116`), а объявленная неуспешная ветвь несёт только `reason`
(`system-architecture.md:3984`). Поле объявляется там, где его читает потребитель, — иначе первый
`tsc` останавливает разработку на ошибке компиляции (MAJOR-D раунда 2).

<!-- contract:changes -->

## Описание изменений

### Новые файлы

- `packages/mcp-server/src/engine/billing-store.ts` — форма резервации, интерфейс, стаб
- `packages/mcp-server/src/engine/billing-errors.ts` — три класса отказа плюс класс отказа чтения
- `packages/mcp-server/test/billing-store-contract.test.ts` — тест контракта на стабе

### Изменения в существующих файлах

**Файл `packages/mcp-server/src/engine/index.ts`:**

- Реэкспортировать `BillingStore`, `BillingReservation`, `BillingReserveResult`,
  `BillingRefusalClass`, `createBillingStoreStub`, `BillingStoreStub`
- Реэкспортировать четыре класса из `billing-errors.ts`
- Дополнить заголовочный комментарий третьим репозиторием операционной стороны

**Why пакет `mcp-server`.** `client_usage` несёт `principal_id` и `access_profile_id`, поэтому
таблица принадлежит семье `request_trace`/`diagnostics` (`data-model.md:1712-1719`). `packages/core`
нового экспорта не получает (`system-architecture.md:4030-4033`).

**Файл `docs/architectures/system-architecture.md`, §3.5.1** (документная половина MAJOR-D раунда 2):

- Возвращаемый тип `reserve()` получает поле класса отказа
  (`docs/architectures/system-architecture.md:3984` — подстрока `{ ok: false; reason: string }`)
- Имя поля в тексте корпуса — `refusalClass`, то же, что в этом файле задачи

**Why текст корпуса правится задачей, объявляющей контракт.** Ревью плана нашло, что поведенческая
половина MAJOR-D поглощена, а текст §3.5.1 сохраняет контракт без носителя класса отказа. Одно
утверждение об одной форме принадлежит одному владельцу.

Корпус ведётся по-английски; правка вносится на языке своего корпуса (ARCHITECTURE §7.3).

### Четыре метода

| Метод                                  | Возвращает                      | Смысл                                              |
| :------------------------------------- | :------------------------------ | :------------------------------------------------- |
| `reserve(input)`                       | `Promise<BillingReserveResult>` | идемпотентная вставка строки `reserved`            |
| `settle(rowId)`                        | `Promise<void>`                 | условный переход `reserved → settled`              |
| `refund(rowId, reason)`                | `Promise<void>`                 | условный переход `reserved → refunded`             |
| `sumSettled(periodFromMs, periodToMs)` | `Promise<string>`               | сумма `price_raw` строк `settled` за период (AC-4) |

Формы взяты из `system-architecture.md` §3.5.1 (`:3957-3995`) дословно.

Вход `reserve` несёт шесть полей: `principalId`, `accessProfileId`, `clientRequestId`, `tool`,
`capability`, `priceRaw` (`system-architecture.md:3977-3984`).

**Why `accessProfileId` допускает пустое значение.** У локального принципала профиля доступа нет
(R-7.5, `data-model.md:1729`).

**Why `priceRaw` — строка.** Цена хранится как `TEXT` по канону `DB-SCHEMA-CONCEPT` §1 п.7
(R-4.5). Резерв сравнивает две строки-целых, а не строку и число.

### Форма резервации

```ts
// PLANNED — packages/mcp-server/src/engine/billing-store.ts
export interface BillingReservation {
  readonly rowId: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  /** `true`, когда строка по этому ключу уже существовала (R-5.2, UC-2). */
  readonly existing: boolean;
}
```

Поле `existing` объявлено обязательным и без слова «Present only when» в докстринге.

**Why обязательное, а не опциональное.** Объявленная форма (`system-architecture.md:3965`) требует
поле, докстринг (`:3964`) описывает его как присутствующее лишь иногда — два прочтения одной
строки (MINOR-4 раунда 1). Опциональное поле дало бы потребителю третье значение `undefined`,
которому смысла в этом контракте не назначено.

### Неуспешная ветвь `reserve()` несёт класс отказа

```ts
// PLANNED — packages/mcp-server/src/engine/billing-store.ts
export type BillingRefusalClass =
  'ClientCreditsExhaustedError' | 'BillingStoreUnavailableError' | 'ReplayWindowExpiredError';

export type BillingReserveResult =
  | { ok: true; reservation: BillingReservation }
  | { ok: false; reason: string; refusalClass: BillingRefusalClass };
```

Поле названо `refusalClass` — тем же именем, под которым его читает обёртка тула
(`packages/mcp-server/src/tools/registry.ts:646`) и несёт `ToolOutcome`
(`packages/mcp-server/src/tools/registry.ts:176`).

**Why поле обязательное.** Прецедент — `ResolveFailure.refusalClass`
(`packages/mcp-server/src/tools/resolve-capability.ts:200`, `refusalClass: string;`). Поле там
обязательно потому, что колонка `request_trace.refusal_class` объявлена `NOT NULL` через
CHECK-ограничение. Здесь действует то же основание.

**Why значений три, а не два.** `ReplayWindowExpiredError` — третье значение того же поля
(`system-architecture.md:4165-4176`), а не отдельный носитель.

**Why тип-объединение, а не `string`.** Обёртка 015-09 обязана читать значение, а не подставлять
литерал. Объединение делает четвёртое значение ошибкой компиляции, а не строкой в леджере.

### Оба класса возвращаются значением, а не бросаются

Докстринг `reserve()` объявляет это одной фразой: `ClientCreditsExhaustedError` и
`BillingStoreUnavailableError` попадают в вызывающего через `{ ok: false, refusalClass }`.

**Why это записано, а не подразумевается.** При броске не отработали бы ни строка следа, ни событие
`tool.refused` — та самая тишина, которую сняло закрытие BLOCKING-3 раунда 1
(`system-architecture.md:4102-4106`).

**Why классы всё-таки объявляются как `class … extends Error`.** Их имена — значения колонки
`request_trace.refusal_class`, и объявление класса держит имя в одном месте с его текстом
(`system-architecture.md:4092-4099`).

### Четвёртый класс: отказ чтения вне оси Postgres

```ts
// PLANNED — packages/mcp-server/src/engine/billing-errors.ts
export class LedgerReadNotAuthoritativeError extends Error {
  /* R-7.3, AC-15 — sumSettled обслуживается только осью Postgres */
}
```

`sumSettled` объявлен обязательным методом интерфейса и существует только на оси Postgres
(`system-architecture.md:3991-3993`). Реализация оси SQLite бросает этот класс.

**Why бросок, а не `'0'`.** Уверенный ноль — законное отрицание, которым оплачен L-10: читатель
AC-4 не отличил бы «нечего суммировать» от «эта ось не авторитетна» (MINOR-5 раунда 2).

**Why класс не входит в `BillingRefusalClass`.** Он не отказ обслуживания запроса, а отказ
учётного чтения. В `request_trace.refusal_class` он не попадает никогда.

### Стаб

```ts
// PLANNED — packages/mcp-server/src/engine/billing-store.ts
export interface BillingStoreStub extends BillingStore {
  readonly rows: readonly BillingLedgerRow[];
}
export function createBillingStoreStub(options?: {
  now?: () => number;
  sumSettledAxis?: 'postgres' | 'sqlite';
}): BillingStoreStub;
```

Стаб держит строки в памяти и соблюдает ровно два наблюдаемых свойства таблицы: ключ
`(principalId, clientRequestId)` и условность перехода `WHERE state = 'reserved'`.

**Why стаб соблюдает ключ.** Стаб, принимающий всё, моделировал бы таблицу без уникального
индекса, и каждый потребитель писался бы против леджера, считающего дважды. Тот же довод уже
записан у стаба следа (`packages/mcp-server/src/engine/request-trace-store.ts:182-185`).

**Why стаб выставляет `rows`.** Хранилище, эффект которого нельзя прочитать, проверяется только по
возвращённому значению. Это оставило бы неутверждённым, что записана та строка, которую передали
(`request-trace-store.ts:187-189`).

**Why у стаба есть параметр оси для `sumSettled`.** Без него отказ оси SQLite нечем предъявить до
появления реализаций 015-06 и 015-07.

### Чего задача не делает

- Таблицу не создаёт: DDL оси SQLite — задача 015-02, миграция Postgres — 015-03.
- Прайс-лист не объявляет: задача 015-05.
- Ветвь конфликта и окно реплея не реализует: задача 015-08.
- В `ToolContext` поле не добавляет: задача 015-09.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

1. **TC-UNIT-01:** интерфейс объявляет четыре метода, и стаб реализует все четыре
   - Входные данные: стаб `createBillingStoreStub()`
   - Ожидаемый результат: `reserve`, `settle`, `refund`, `sumSettled` — функции
2. **TC-UNIT-02:** первый резерв по паре `(principalId, clientRequestId)` даёт `ok: true` и
   `existing: false`
3. **TC-UNIT-03:** повтор той же пары даёт `ok: true`, `existing: true`, и второй строки не создаёт
   - Ожидаемый результат: длина `rows` равна 1
4. **TC-UNIT-04:** неуспешная ветвь несёт `refusalClass` со значением из объявленных трёх
   - Входные данные: стаб, приведённый к отказу по каждому из трёх классов
   - Ожидаемый результат: три отказа, три разных значения `refusalClass`, поле присутствует на
     каждом; падает при возврате отказа без поля
5. **TC-UNIT-05:** оба денежных класса возвращаются значением, а не бросаются
   - Входные данные: те же два отказа
   - Ожидаемый результат: промис разрешается, а не отвергается
6. **TC-UNIT-06:** `settle` по уже терминальной строке — не ошибка и состояния не меняет
7. **TC-UNIT-07:** `refund` по уже терминальной строке — не ошибка и состояния не меняет
8. **TC-UNIT-08:** `sumSettled` на оси SQLite бросает `LedgerReadNotAuthoritativeError`
   - Входные данные: `createBillingStoreStub({ sumSettledAxis: 'sqlite' })`
   - Ожидаемый результат: бросок именованного класса; падает при возврате `'0'` (AC-15, часть)
9. **TC-UNIT-09:** `sumSettled` на оси Postgres возвращает строку, а не число
   - Ожидаемый результат: `typeof` результата равен `'string'`

### Регрессионные тесты

- `pnpm typecheck`, `pnpm test`
- Сьюта `packages/mcp-server/test/engine-store-contracts.test.ts` проходит без правок

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] Интерфейс объявляет `reserve`, `settle`, `refund`, `sumSettled` с формами из
      `system-architecture.md` §3.5.1
- [ ] MAJOR-D: неуспешная ветвь `reserve()` несёт обязательное поле `refusalClass` со значениями
      `ClientCreditsExhaustedError`, `BillingStoreUnavailableError`, `ReplayWindowExpiredError`
- [ ] MAJOR-D: докстринг объявляет, что оба класса возвращаются значением, а не бросаются
- [ ] MINOR-4: поле `existing` объявлено согласованно с докстрингом — обязательное, без оговорки
- [ ] MINOR-5: реализация `sumSettled` на оси SQLite бросает именованную ошибку, а не возвращает `'0'`
- [ ] AC-15 (часть) — тест на отказ `sumSettled` вне оси Postgres
- [ ] Тест на стабе зелёный и падает после замены стаба реализацией
- [ ] Текст `system-architecture.md` §3.5.1 называет то же поле класса отказа и под тем же именем,
      что объявляет этот файл задачи

## Примечания

Стаб заменяют задачи 015-06 (ось SQLite) и 015-07 (ось Postgres). Тест первого прохода после
замены обновляется парной задачей на фактическое значение (`tdd-stub-first` §2).

Ветвь конфликта `reserve()`, читающая окно реплея, принадлежит задаче 015-08. Здесь объявлено
только третье значение поля `refusalClass`, которое та ветвь возвращает.

План относит UC-1, UC-2 и UC-5 к задачам-реализациям (015-06, 015-07, 015-10). Здесь они названы
потому, что контракт объявляется до этих задач и связывает их.

Имя поля — `refusalClass` во всех файлах плана. В корпусе архитектуры написание `errorClass` стоит в
четырёх координатах, и они разложены по трём владельцам: `system-architecture.md:3984` (объявление
типа, §3.5.1) — эта задача, `:4116` (чтение в обёртке, §3.5.2) — задача 015-09, `:4162`, `:4172` и
`:4174` (ветвь конфликта, §3.5.2a) — задача 015-08.

Регистрация имени `client_usage` в перечне `STATE_TABLES`
(`packages/core/src/pg/state-client.ts:87` — `export const STATE_TABLES = [`) принадлежит задаче
015-03. Тип `EngineTable` читает этот перечень
(`packages/mcp-server/src/engine/pg-engine-store.ts:23` — `export type EngineTable = (typeof
STATE_TABLES)[number];`). Интерфейс имени таблицы не спеллит.
