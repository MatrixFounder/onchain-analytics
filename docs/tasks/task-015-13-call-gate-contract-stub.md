# Задача 015.13: контракт суточного гейта — параметр `dailyCalls`, модуль `call-gate`, класс отказа `[STUB]`

## Связь со сценариями

- UC-3 — счётчик вызовов переводит `entity.labels` на платный Nansen
- UC-4 — счётчик вызовов жёстко отказывает на `token.holders`

<!-- contract:goal -->

## Цель задачи

Зафиксировать сигнатуру суточного гейта вызовов, его модуль и его класс отказа до того, как счётчик
начнёт читаться.

**Why форма раньше счётчика.** Гейт пишут три задачи: 015-14 читает и увеличивает `usage.calls_made`,
015-15 включает вызов в адаптер, 015-17 разводит наблюдаемость по четырём маршрутам. Сигнатура,
согласованная после первого писателя, переписывается остальными двумя.

**Why класс отказа объявляется здесь.** R-11.4 требует именованный класс, а не безымянное исключение
лимитера. Прецедент L-27: непомеченный класс отказа лимитера стоил отдельного разбора именно потому,
что не был назван.

<!-- contract:changes -->

## Описание изменений

### Новые файлы

- `packages/core/src/adapters/blockscout/call-gate.ts` — `createCallGate`, стаб `ensureCallBudget`,
  класс `ProviderCallCeilingExceededError`
- `packages/core/test/call-gate-contract.test.ts` — тесты первого прохода

### Изменения в существующих файлах

**Файл `packages/core/src/cache/budget-store.ts`:**

- Интерфейс `BudgetStore.checkAndReserve` получает шестой параметр
  `dailyCalls?: { ceiling: number }`
- `SqliteBudgetStore.checkAndReserve` (`:300`) принимает параметр и на этом проходе его не читает

**Файл `packages/core/src/pg/budget-store.ts`:**

- `PgBudgetStore.checkAndReserve` (`:210`) принимает тот же параметр на тех же условиях

**Why обе реализации правятся сразу.** `PgBudgetStore` объявлен как `implements BudgetStore`
(`packages/core/src/pg/budget-store.ts:145`). Расширенный интерфейс без правки второй реализации не
компилируется.

**Файл `docs/architectures/system-architecture-billing.md`, §3.5.4** (документная половина этой задачи):

- Объявление `createCallGate` получает поле `provider: string`
  (`docs/architectures/system-architecture-billing.md:436-443` — блок `export function createCallGate(deps:
{`)
- `ensureCallBudget` принимает один параметр
  (`docs/architectures/system-architecture-billing.md:444` — подстрока
  `ensureCallBudget(now: () => number)`)
- Комментарий тела читает провайдера из `deps.provider`, а не из параметра вызова
  (`docs/architectures/system-architecture-billing.md:446-454` — подстроки `for THIS provider` и
  `checkAndReserve(deps.provider,`)
- Названо, что отказ на объявлении `'none'` — отказ КОНСТРУКЦИИ, потому что провайдер известен
  конструктору

**Why владелец — эта задача, а не 015-15.** Блок `:4376-4395` — объявление контракта, и объявляет
его здесь. Прецедент внутри того же плана: текст корпуса, утверждающий форму `reserve()`, правит
задача 015-04 — та, что форму объявляет, — а точку чтения правит задача 015-09. Задача 015-15
владеет текстом ТОЧКИ ВЫЗОВА (`:4397-4400`, `Called once per network attempt`), и его правка m-8 не
затронула: вызов как стоял рядом с `throttle()`, так и стоит.

**Why правка обязательна.** Сигнатура `:4378-4386` отменена правкой m-8 ревью плана: провайдер
переехал в конструктор. Разработчик, читающий §3.5.4 как источник истины, напишет
`ensureCallBudget(provider, now)` — форму, которая против поставленного кода не компилируется.

Корпус ведётся по-английски; правка вносится на языке своего корпуса (ARCHITECTURE §7.3).

### Сигнатура

```ts
// packages/core/src/cache/budget-store.ts
checkAndReserve(
  provider: string,
  dayBucketMs: number,
  cost: number,
  ceiling: number,
  velocity?: VelocityLimit,
  dailyCalls?: { ceiling: number }, // R-9 — сравнивается с usage.calls_made в ТОЙ ЖЕ транзакции
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

**Why параметр необязательный.** Гейт применяется к провайдеру с объявленным потолком, а вызывающих
`checkAndReserve` без него больше. Обязательный параметр потребовал бы правки каждого вызова ради
значения, которого у него нет.

**Why `checkAndReserve`, а не отдельная функция** (AC-20). Внутри `checkAndReserve` не назван ни один
провайдер: вызывающий подаёт потолок так же, как уже подаёт `cost`, `ceiling` и `velocity`. Тот же код
обслуживает nansen и blockscout без провайдер-специфичной ветки.

### Почему `VelocityLimit.maxCalls` не переиспользован — MINOR-7 раунда 1

Докстринг параметра называет три различия, а не одно.

| Различие           | `VelocityLimit.maxCalls`                            | `dailyCalls.ceiling`   |
| :----------------- | :-------------------------------------------------- | :--------------------- |
| носитель счёта     | `usage_window(provider, window_start)`              | `usage(provider, day)` |
| срок жизни строки  | час (`packages/core/src/cache/budget-store.ts:144`) | суточная корзина       |
| обязательный сосед | `windowStartMs` и кредитный `ceiling` того же окна  | ни одного              |

**Why суточную сумму нельзя восстановить из минутного окна** (R-9.1). Строки `usage_window` старше
часа выпалываются (`WINDOW_RETENTION_MS = 3_600_000`,
`packages/core/src/cache/budget-store.ts:144`). Расширение `maxCalls` до суток потребовало бы отменить
эту прополку и удержать 1440 строк на провайдера в сутки.

**Why не новое поле на `VelocityLimit`.** Поле `windowStartMs` там обязательное
(`packages/core/src/cache/budget-store.ts:32`), и суточный вызывающий обязан был бы подать окно,
которого он не считает.

### Модуль гейта

```ts
// packages/core/src/adapters/blockscout/call-gate.ts
export function createCallGate(deps: {
  /** Провайдер, чей потолок читает конструктор. Носитель провайдера — конструктор, не вызов. */
  provider: string;
  budgetStore: BudgetStore;
  /** Инъекция; `process.env` внутри `core` не читается (R-13.3a). `undefined` ⇒ действует значение
   * `providers.config.ts`. Форма повторяет `NansenBudgetGateDeps.dailyCreditCap`
   * (`packages/core/src/adapters/nansen/budget-gate.ts:232-235`). */
  dailyCallCeilingOverride?: number;
}): { ensureCallBudget(now: () => number): Promise<void> };
```

Стаб этого прохода: `ensureCallBudget` возвращает разрешённый промис и `budgetStore` не вызывает.
Докстринг описывает будущую логику — чтение `dailyCallCeiling` регистрации по `deps.provider`,
применение переопределения, вызов `checkAndReserve(deps.provider, dayBucketMs(now()), 0, Infinity,
undefined, { ceiling })`.

**Why провайдер приходит в конструктор, а не в вызов.** Потолок читается один раз при построении, и
отказ на `'none'` объявлен отказом КОНСТРУКЦИИ. Параметр вызова заставил бы конструктор отказывать
за провайдера, которого он ещё не видел.

**Why это не делает гейт провайдер-специфичным** (AC-20). Ветви по имени провайдера в теле нет:
имя — данные конструктора, а оператор счёта один на nansen и blockscout.

**Why `cost = 0` и `ceiling = Infinity`.** У blockscout нет кредитного измерения, поэтому отказать
здесь может только ветвь `dailyCalls` того же оператора.

**Why конструктор отказывает на `'none'`.** Провайдер, объявивший `'none'`, потолка не имеет
(`data-model.md` §4.6.3). Гейт, построенный поверх такого объявления, сравнивал бы вызовы с
отсутствующим числом. Отказ на конструкции называет провайдера в тексте ошибки.

### Класс отказа

```ts
// packages/core/src/adapters/blockscout/call-gate.ts
export class ProviderCallCeilingExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`daily call ceiling reached: ${reason}`);
    this.name = 'ProviderCallCeilingExceededError';
  }
}
```

Действующий класс насыщения — `RateLimitRejectedError`
(`packages/core/src/net/rate-limit.ts:261`), его текст — `throttle: rejected for provider "…": …`
плюс отрисовка бакета (`:271-273`, `renderBucketState` на `:233`).

**Why различимость проверяется по значению, а не по факту броска** (AC-25). На маршруте из одного
адаптера `refusal_class` доходит до читателя как `CapabilityUnavailableError` независимо от причины
(`system-architecture.md` §3.5.3). Различает причины только текст, который попадает в
`tried[].reason` и в `outcome.reason`.

**Различимость определена как непересечение по РАЗЛИЧАЮЩИМ подстрокам, а не по всем.** Оба текста
несут имя провайдера, и полное непересечение недостижимо. Проверяются четыре подстроки:
`daily call ceiling reached` и `throttle: rejected` — каждая встречается ровно в одном из двух
текстов; `rate limit` и `bucket` — ни разу в тексте нового класса.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

1. **TC-UNIT-01:** сигнатура принимает шестой параметр объявленной формы
   - Входные данные: вызов `checkAndReserve(p, day, 0, Infinity, undefined, { ceiling: 5 })`
   - Ожидаемый результат: компилируется; обе реализации принимают вызов
2. **TC-UNIT-02:** на стабе потолок не действует — счётчик ещё не читается
   - Входные данные: `dailyCalls: { ceiling: 0 }` при любом состоянии `usage`
   - Ожидаемый результат: `{ ok: true }`
   - Примечание: это утверждение стаба; после задачи 015-14 тест обязан падать
3. **TC-UNIT-03:** `createCallGate` строится при инъекции `provider` и `budgetStore` без
   переопределения
4. **TC-UNIT-04:** `createCallGate` отказывается строиться для провайдера, объявившего `'none'`
   - Входные данные: `provider`, чья регистрация несёт `dailyCallCeiling: 'none'`
   - Ожидаемый результат: конструктор бросает; текст называет провайдера
   - Падает при мутации: чтение потолка перенесено из конструктора в `ensureCallBudget`
5. **TC-UNIT-05:** `ensureCallBudget` стаба не обращается к `budgetStore`
   - Входные данные: `budgetStore`, у которого `checkAndReserve` бросает при вызове
   - Ожидаемый результат: `ensureCallBudget` разрешается
6. **TC-UNIT-06:** текст нового класса различим по значению
   - Входные данные: `new ProviderCallCeilingExceededError('…')` и
     `new RateLimitRejectedError('blockscout', '…')`
   - Ожидаемый результат: четыре подстроки распределены по правилу выше; падает при подстановке
     текста одного класса в другой
7. **TC-UNIT-07:** MINOR-7 — докстринг параметра называет причину отказа от `VelocityLimit.maxCalls`
   - Входные данные: текст `packages/core/src/cache/budget-store.ts`
   - Ожидаемый результат: докстринг `dailyCalls` называет носитель счёта и срок жизни строки
     `usage_window`
8. **TC-UNIT-08:** `packages/core` не читает `process.env` для этого значения
   - Ожидаемый результат: `packages/mcp-server/test/settings-access.gate.test.ts:97` остаётся
     зелёным; новый модуль в перечень нарушителей не попадает

### Проверки артефактов

1. **TC-DOC-01:** §3.5.4 корпуса объявляет ту же сигнатуру, что модуль
   - Входные данные: текст `docs/architectures/system-architecture.md` между заголовком §3.5.4 и
     концом блока объявления
   - Ожидаемый результат: `deps` несёт `provider: string`; подстроки
     `ensureCallBudget(provider: string` в разделе нет; комментарий тела читает `deps.provider`
   - Падает при мутации: правка внесена в поле `deps` и не внесена в возвращаемый тип

### Регрессионные тесты

- `pnpm lint`, `pnpm typecheck`, `pnpm test`
- `packages/core/test/budget-store.test.ts` и `packages/core/test/budget-velocity.test.ts` проходят
  без правок: шестой параметр необязательный
- **`packages/core/test/adapter-registrations.test.ts`, случай `TC-DCC-07`, обновляет ЭТА задача.**
  Задача 015-12 оставила его тестом первого прохода: он утверждает, что имя `dailyCallCeiling`
  встречается ровно в двух файлах `src`. Докстринг стаба называет это имя, поэтому новый модуль
  `call-gate.ts` становится третьим файлом, и случай падает: перечень файлов насчитывает три вместо
  двух. Ожидаемое множество файлов дополняется до трёх; счёт десяти литералов в
  `providers.config.ts` остаётся прежним. Обязательство названо в
  015-12 (строка 147) и продублировано здесь: исполнитель читает свою задачу, а не соседнюю

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] `checkAndReserve` получает необязательный параметр `dailyCalls` формы `{ ceiling: number }`
- [ ] `createCallGate` объявлен с инъекцией `provider`, `budgetStore` и необязательного
      `dailyCallCeilingOverride`; `ensureCallBudget` принимает один параметр `now`;
      `process.env` в `packages/core` не читается
- [ ] `ProviderCallCeilingExceededError` объявлен с текстом, не пересекающимся по различающим
      подстрокам с текстом `RateLimitRejectedError`
- [ ] `createCallGate` отказывается конструироваться для провайдера, объявившего `'none'`
- [ ] MINOR-7 — докстринг называет причину, по которой `VelocityLimit.maxCalls` не переиспользован
- [ ] Тест на стабе зелёный и падает после замены стаба чтением счётчика
- [ ] §3.5.4 корпуса объявляет ту же сигнатуру, что модуль: `provider` в `deps`,
      `ensureCallBudget(now)` одним параметром, отказ конструкции на `'none'` названный; текст
      раздела и текст `call-gate.ts` совпадают по форме

## Примечания

Поле `AdapterRegistration.dailyCallCeiling` объявляет задача 015-12; эта задача его читает и не
объявляет.

Стаб заменяется задачами 015-14 (чтение и увеличение `usage.calls_made` в той же транзакции), 015-15
(вызов гейта рядом с `throttle()`, `packages/core/src/adapters/blockscout/index.ts:425`) и 015-17
(наблюдаемость исчерпания на четырёх маршрутах).

**TC-UNIT-02 обязано начать падать.** Утверждение «потолок 0 не отказывает» описывает стаб, а не
поведение. Парная задача 015-14 обновляет его на фактическое значение (`tdd-stub-first` §2). Стаб,
принятый как реализация, потому что тест на нём зелёный, — риск PR-4 плана.

Ключ окружения `BLOCKSCOUT_DAILY_CALL_CAP` и его класс настройки — задача 015-16. Здесь объявлена
только точка инъекции.

Текст §3.5.4 разделён между двумя владельцами: объявление (`docs/architectures/system-architecture-billing.md:434-456`)
правит эта задача, точка вызова (`docs/architectures/system-architecture-billing.md:458-461`) принадлежит
задаче 015-15 и правки не требует — правка m-8 её не касалась.

**Точку ПОСТРОЕНИЯ гейта в продуктивной сборке эта задача не заводит.** `createCallGate(...)`
вызывается в `packages/mcp-server/src/runtime.ts:202` — там же, где собирается адаптер blockscout;
владелец — задача 015-15. Здесь объявлена форма конструктора, а не его вызов.
