# Задача 014.14: `ctx.principal` в `ToolContext` `[STUB]`

## Связь со сценариями

- UC-1 — n8n вызывает способность по сети

<!-- contract:goal -->

## Цель задачи

Ввести тип `Principal` пятью полями, объявить `ctx.principal` в `ToolContext` и добавить принципала
в `needs` каждого тула. Стаб отдаёт константного принципала транспорта `stdio`.

**Why форма раньше перехвата.** Задача 014-15 размещает резолв в обёртке `defineTool`, задача 014-30
пишет оттуда же строку следа. Обе читают поля принципала, поэтому состав полей закрепляется до них.

<!-- contract:changes -->

## Описание изменений

### Новые файлы

- `packages/mcp-server/src/auth/principal.ts` — тип `Principal`, тип `PrincipalResolver` и константа
  принципала транспорта `stdio`

### Изменения в существующих файлах

**Файл `packages/mcp-server/src/tools/registry.ts`:**

- Добавить ключ `principal` в `ToolContext`

**Файл `packages/mcp-server/src/server.ts`:**

- Добавить `principals?: PrincipalResolver` в `CreateServerDeps`

**Файл `packages/mcp-server/src/tools/tool-specs.ts`:**

- Пересмотреть объявления `needs` на присутствие принципала

### Форма принципала

Объявление воспроизводится из `system-architecture.md` §3.4.3 без изменений:

```ts
// PLANNED — packages/mcp-server/src/auth/principal.ts
export interface Principal {
  readonly principalId: string; // api_tokens.id, or 'local' on the stdio transport
  readonly userId: string | null; // users.id; null on stdio
  readonly role: 'admin' | 'user'; // R-15.3 — decides `_meta.budget` visibility
  readonly accessProfileId: string | null; // R-13.1 — the settings the token works within
  readonly transport: 'stdio' | 'http'; // R-27.1 — written to request_trace.transport
}
```

| Поле              | Значение                                                         | Пусто |
| :---------------- | :--------------------------------------------------------------- | :---- |
| `principalId`     | `api_tokens.id`, либо `local` на транспорте `stdio`              | нет   |
| `userId`          | `users.id`; пусто на `stdio`                                     | да    |
| `role`            | `admin` или `user`; решает видимость `_meta.budget` (R-15.3)     | нет   |
| `accessProfileId` | профиль доступа, в рамках которого работает токен (R-13.1)       | да    |
| `transport`       | `stdio` или `http`; пишется в `request_trace.transport` (R-27.1) | нет   |

**Why поле названо `principalId`, а не `id`.** Значение пишется в колонку того же имени —
`request_trace.principal_id TEXT NOT NULL` (`data-model.md` §4.5.7). Одно имя на всю границу
снимает переименование.

**Why `transport` — поле, а не вывод.** `request_trace.transport` объявлен `TEXT NOT NULL`, поэтому
значение нужно в момент записи следа. Строка следа пишется тогда, когда сессия могла уже закрыться,
а принципал на `stdio` не принадлежит сессии.

**Why `userId` и `accessProfileId` допускают пустое значение.** На `stdio` токена нет, поэтому нет
ни строки пользователя, ни профиля доступа. Роль при этом определена.

**Why в типе нет самого секрета.** `AuthInfo` несёт `AuthInfo.token: string`. У `Principal` такого
поля нет, и отображение — единственное место чтения секрета. R-5.3 запрещает принципала на stderr,
R-5.4 запрещает его в `_meta`; тип, неспособный держать секрет, делает обе половины механическими.

### Константа принципала транспорта `stdio`

```ts
{ principalId: 'local', userId: null, role: 'admin', accessProfileId: null, transport: 'stdio' }
```

**Why роль выведена, а не выбрана.** UC-3 шаг 3 требует `_meta.budget` в локальном профиле
(`docs/TASK.md:442`), а R-6.1 отдаёт это поле роли `admin`.

**Why принципал существует и без сети.** Код, ветвящийся на «принципал есть или нет», получает
необязательное поле и теряет проверку компилятором. Константа делает ключ обязательным.

### Подпись резолвера и точка внедрения

```ts
export type PrincipalResolver = (authInfo: AuthInfo | undefined) => Principal;
```

Подпись объявлена архитектурой (`system-architecture.md` §3.4.3) вместе с точкой внедрения:
`CreateServerDeps` получает `principals?: PrincipalResolver`, умолчание — константа принципала
`stdio`.

**Why параметр — `AuthInfo | undefined`, а не запрос.** Обёртка получает `extra.authInfo` от SDK, и
ничто ниже транспорта не должно держать объект запроса. `undefined` — случай stdio.

**Why резолвер возвращает, а не бросает при отсутствии принципала.** К моменту работы обёртки шаг 2
порядка допуска уже отверг всякий запрос без валидного токена.

**Why отображение синхронное.** Проверка предъявленного токена и чтение `api_tokens` выполняются в
`verifyAccessToken` до вызова `transport.handleRequest` (хоп 1). Резолверу остаётся отображение
полей уже проверенной записи.

**Why зависимость необязательная.** Умолчание — константа `stdio`, поэтому локальный запуск и тесты
работают без резолвера. Сегодня `CreateServerDeps` объявлен четырьмя полями — `env`, `version`,
`registry?`, `budgetStore?` (`packages/mcp-server/src/server.ts:30`); поле добавляется пятым.

### Объявление в `needs`

`project()` (`packages/mcp-server/src/tools/registry.ts:186`) сужает контекст по списку `needs`.
Ключ `principal` подчиняется тому же правилу: тул, не объявивший его, получает объект без ключа.

Сегодня `toolSpecs` содержит 20 записей. Задача 014-32 добавляет `onchain_pool_info`, после чего их 21. Тест обходит реестр, число тулов в нём не зашито.

**Why счёт не зашит.** Зашитое число даёт зелёный тест на реестре, из которого тул выпал, и красный
тест на каждом добавлении тула. Обход реестра снимает оба случая.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

1. **TC-UNIT-01:** константа принципала `stdio` несёт пять объявленных значений
   - Входные данные: экспортированная константа
   - Ожидаемый результат: `principalId = 'local'`, `userId = null`, `role = 'admin'`,
     `accessProfileId = null`, `transport = 'stdio'`
2. **TC-UNIT-02:** `ctx.principal` присутствует в каждом вызове тула
   - Входные данные: обход `toolSpecs`, вызов каждого тула на инертном реестре
   - Ожидаемый результат: обработчик получает объект с ключом `principal`
3. **TC-UNIT-03:** принципал объявлен в `needs` каждой записи `toolSpecs`
   - Входные данные: реестр целиком, счёт не зашит
   - Ожидаемый результат: `needs` каждой записи содержит `'principal'`
4. **TC-UNIT-04:** тул, не объявивший `principal` в `needs`, получает контекст без этого ключа
   - Входные данные: тестовая спецификация с пустым `needs`
   - Ожидаемый результат: `Object.hasOwn(ctx, 'principal') === false`
5. **TC-UNIT-05:** `createServer` без `deps.principals` отдаёт принципала `stdio`
   - Входные данные: `createServer({ env, version })`
   - Ожидаемый результат: `ctx.principal.transport === 'stdio'`, `ctx.principal.role === 'admin'`
6. **TC-UNIT-06:** объект принципала без поля `transport` не компилируется
   - Входные данные: литерал из четырёх полей под `@ts-expect-error`
   - Ожидаемый результат: `pnpm typecheck` зелёный; снятие директивы делает его красным

### Регрессионные тесты

- Снимок `tools/list` не изменился: принципал не является аргументом тула
- `pnpm typecheck`, `pnpm test`

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] Тип `Principal` объявлен пятью полями по `system-architecture.md` §3.4.3
- [ ] Файл `packages/mcp-server/src/auth/principal.ts` создан
- [ ] Константа принципала `stdio` совпадает со значением, объявленным в архитектуре
- [ ] `ToolContext` несёт ключ `principal`, `CreateServerDeps` несёт `principals?`
- [ ] Принципал объявлен в `needs` каждой записи `toolSpecs`, счёт тулов не зашит
- [ ] AC-19 закрыт в части формы
- [ ] Снимок `tools/list` без правок

## Примечания

Точка перехвата вводится задачей 014-15: резолв размещается в обёртке `defineTool`
(`packages/mcp-server/src/tools/registry.ts:289`). На этой задаче принципал присутствует и ни на что
не влияет.

Долг перед архитектурой: `system-architecture.md` §3.4.3 называет тип `PrincipalResolver` и его
умолчание, но подписи функции не объявляет. Подпись выше выведена из хопов 1 и 4 того же раздела и
подлежит внесению в архитектуру перед закрытием задачи.
