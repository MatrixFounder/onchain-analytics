# Задача 015.17: наблюдаемость исчерпания на четырёх маршрутах Blockscout

## Связь со сценариями

- UC-3 — счётчик вызовов Blockscout переводит `entity.labels` на платный Nansen
- UC-4 — счётчик вызовов Blockscout жёстко отказывает на `token.holders`

<!-- contract:goal -->

## Цель задачи

Показать исчерпание суточного потолка blockscout на всех четырёх маршрутах так, чтобы оператор
читал его в уже построенных каналах наблюдаемости.

**Why отдельная задача после включения гейта.** Задача 015-15 ставит гейт рядом с `throttle()` и
отвечает за отказ на одном вызове. Четыре маршрута ведут себя по-разному после этого отказа, и это
свойство маршрутов, а не гейта.

**Why нового канала не заводится.** `request_trace.escalated_to_paid`, событие
`source.escalated_to_paid` и событие `tool.refused` уже построены T-014. Отдельный канал под
исчерпание раздвоил бы место, куда смотрит оператор.

<!-- contract:changes -->

## Описание изменений

### Четыре маршрута и их поведение

| Способность          | Маршрут                     | Координата                                  | Исход при исчерпании        |
| :------------------- | :-------------------------- | :------------------------------------------ | :-------------------------- |
| `entity.labels`      | `['blockscout', 'nansen']`  | `packages/core/src/providers.config.ts:172` | эскалация на платный nansen |
| `token.holders`      | `['blockscout']`            | `packages/core/src/providers.config.ts:149` | отказ маршрута              |
| `chain.transactions` | `['blockscout']`            | `packages/core/src/providers.config.ts:75`  | отказ маршрута              |
| `gas.price`          | `['rpc-evm', 'blockscout']` | `packages/core/src/providers.config.ts:74`  | снятие бесплатного фолбэка  |

**Why гейт стоит на уровне провайдера и покрывает все четыре без маршрутной настройки.**
`checkAndReserve` вызывается с `provider = 'blockscout'` на каждом из них. Потолок объявлен один
раз на регистрации (задача 015-12).

### Изменения в существующих файлах

**Файл `packages/core/src/adapters/blockscout/index.ts`:**

- Бросок `ProviderCallCeilingExceededError` из точки гейта
  (`packages/core/src/adapters/blockscout/index.ts:425` —
  `await throttle('blockscout', rateLimit, weight, deadlineAtMs);`) проходит наружу немодифицированным
- Ни один из четырёх маршрутов броска не проглатывает и не подменяет его пустым результатом

**Why бросок не превращается в пустой ответ.** Пустой ответ на `entity.labels` уже разбирается
политикой `someElementHasAny` и тоже уводит маршрут на nansen
(`packages/core/src/providers.config.ts:174` — `policy: { kind: 'someElementHasAny', fields:
['name', 'tags', 'labels'] }`). Свернув исчерпание в пустой ответ, мы потеряли бы различие между
«вендор ответил пусто» и «мы к вендору не пошли» — второе прямо оплачено прецедентом L-10.

**Файл `packages/mcp-server/src/tools/escalation.ts`:**

- Обновить блок про отклонённое прочтение R-28.1
  (`packages/mcp-server/src/tools/escalation.ts:9` —
  `— "the free source was EXHAUSTED" — was rejected because we cannot observe it`, `:10` —
  ``key meters credits at the VENDOR, this engine keeps no counter for it, and `ADR-003` assigns that``,
  `:11` — `counter to T-015.`): счётчик, назначенный T-015, введён задачами 015-12…015-15
- Условие `detectEscalation`
  (`packages/mcp-server/src/tools/escalation.ts:48` —
  `export function detectEscalation(walks: readonly CapabilityWalk[]): Escalation | null {`)
  остаётся прежним: вход бесплатного источника, затем вход платного

**Why условие не переписывается на «исчерпан».** Классификация идёт по `tier`, а не по наличию
квитанции расхода (`packages/mcp-server/src/tools/escalation.ts:19` —
``**Why the classification is `tier` and never the presence of a spend receipt.**``). Маршрут
`gas.price` состоит из двух бесплатных адаптеров, и вывод платности из расхода пометил бы его
эскалацией без единого платного участника.

**Why комментарий всё же правится.** Он утверждает, что счётчика нет, и после этого этапа
утверждение ложно. Класс тот же, что MINOR-6 раунда 2: ложное утверждение вплотную к новому
механизму.

### Маршрут `entity.labels` — эскалация

Бросок из `blockscout.fetch()` ловится существующим поцикловым перехватом, обход идёт на `nansen`.
Наблюдаемость — два уже построенных места:

- колонка `request_trace.escalated_to_paid`
  (`packages/mcp-server/src/tools/request-trace-row.ts:194` —
  `escalatedToPaid: detectEscalation(input.walks) === null ? 0 : 1,`)
- событие `source.escalated_to_paid`
  (`packages/mcp-server/src/tools/registry.ts:589` —
  `await ctx.diagnostics?.emit('source.escalated_to_paid', {`)

### Маршруты `token.holders` и `chain.transactions` — отказ

Следующего адаптера у маршрута нет. Обход исчерпывается, вызов завершается
`CapabilityUnavailableError`, несущим текст отказа гейта в перечне `tried`.

**Why текст, а не имя класса.** `resolve-capability.ts` записывает в `refusal_class` имя того
класса, который дошёл до него, и на одноадаптерном маршруте это всегда `CapabilityUnavailableError`
(`system-architecture.md` §3.5.3). Различие «потолок вызовов» против «насыщение бакета» несёт
только текст, и проверяется он по значению.

### Маршрут `gas.price` — снятие бесплатного фолбэка

`rpc-evm` идёт первым, blockscout — вторым. Второй достигается на сетях без курируемого RPC.
Отказ гейта снимает бесплатный фолбэк для этих сетей и ни для каких других.

**Why платной эскалации здесь нет.** Третьего адаптера маршрут не называет
(`packages/core/src/providers.config.ts:74` —
`{ capability: 'gas.price', adapterIds: ['rpc-evm', 'blockscout'] },`). Отсутствие платного
участника — свойство маршрута, а не следствие настройки.

### Общий канал наблюдаемости

Отказ тула на любом из четырёх маршрутов даёт строку `diagnostics` события `tool.refused`
(`packages/mcp-server/src/tools/registry.ts:704` —
`(await ctx.diagnostics?.emit('tool.refused', {`). Событие входит в закрытый словарь из восьми
(`packages/mcp-server/src/engine/diagnostics-store.ts:51` — `'source.escalated_to_paid',`,
`:52` — `'tool.refused',`), новых значений задача не вводит.

**Why канал тот же, что у отсутствия объявленного потолка.** R-10.3 требует наблюдать исчерпание
там же, где наблюдается его отсутствие (R-9.6). Второе даёт отказ гейта старта (задача 015-12),
первое — строку `diagnostics`. Оба видны оператору без отдельного инструмента.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

Новый файл `packages/mcp-server/test/blockscout-exhaustion.test.ts`.

1. **TC-UNIT-01:** исчерпание на `entity.labels` уводит маршрут на nansen
   - Входные данные: суточный счётчик blockscout на объявленном потолке; вызов `entity.labels`
   - Ожидаемый результат: `nansen` входит в обход; ответ получен
2. **TC-UNIT-02:** та же цепочка отмечена в следе и в диагностике
   - Ожидаемый результат: `request_trace.escalated_to_paid` равен `1`; одна строка `diagnostics`
     события `source.escalated_to_paid` с `from = 'blockscout'`, `to = 'nansen'`
   - Падает при мутации: подавление броска гейта до перехвата обхода
3. **TC-UNIT-03:** исчерпание на `token.holders` завершает маршрут отказом
   - Входные данные: счётчик на потолке; вызов `token.holders`
   - Ожидаемый результат: `CapabilityUnavailableError`; следующего адаптера в `tried` нет
4. **TC-UNIT-04:** то же на `chain.transactions`
   - Ожидаемый результат: `CapabilityUnavailableError`; единственный адаптер в `tried` —
     `blockscout`
5. **TC-UNIT-05:** текст отказа гейта не пересекается с текстом насыщения бакета
   - Входные данные: два отказа — гейт вызовов и токен-бакет
   - Ожидаемый результат: тексты не имеют общей подстроки-признака; проверка идёт по значению
   - Падает при мутации: подстановка текста лимитера в отказ гейта
6. **TC-UNIT-06:** исчерпание на `gas.price` снимает бесплатный фолбэк
   - Входные данные: сеть без курируемого RPC; счётчик на потолке
   - Ожидаемый результат: отказ маршрута; ни одного платного адаптера в `tried`
7. **TC-UNIT-07:** платной эскалации на `gas.price` не возникает
   - Ожидаемый результат: `request_trace.escalated_to_paid` равен `0`; строки
     `source.escalated_to_paid` нет
   - Падает при мутации: вывод платности из наличия квитанции расхода
8. **TC-UNIT-08:** отказ на каждом из четырёх маршрутов даёт строку `tool.refused`
   - Ожидаемый результат: по одной строке `diagnostics` на каждый отказ; словарь событий не
     расширен

### Регрессионные тесты

- `pnpm --filter @onchain-intel/mcp-server test` — тесты эскалации и следа запроса остаются
  зелёными
- `pnpm --filter @onchain-intel/core test` — тесты адаптера blockscout остаются зелёными
- `pnpm typecheck`, `pnpm test`

<!-- contract:acceptance -->

## Критерии приёмки

- [ ] AC-23 — эскалация на `nansen` по `entity.labels` при исчерпании видна в
      `request_trace.escalated_to_paid` и в событии `source.escalated_to_paid`
- [ ] Исчерпание на `token.holders` и `chain.transactions` завершает маршрут отказом без
      следующего адаптера
- [ ] Исчерпание на `gas.price` снимает бесплатный фолбэк для сетей без курируемого RPC; платной
      эскалации на этом маршруте нет
- [ ] Исчерпание наблюдаемо тем же каналом, что и отсутствие объявленного потолка

## Примечания

Зависимость: 015-15 (гейт вызван в адаптере рядом с `throttle()`). Класс отказа
`ProviderCallCeilingExceededError` объявлен задачей 015-13.

Живой прогон этих маршрутов на сниженном пороге принадлежит задачам 015-29 и 015-30. Эта задача
проверяется сьютой на фикстурах: R-21 запрещает сеть в CI.

Открытые дефекты `L-12` (HTTP 500 на `base`), `L-20` (превышение дедлайна на `token.holders`) и
`L-27` (непомеченный класс отказа лимитера) дают отказ той же формы. Признак различения объявлен
методикой 015-01 и применяется в 015-30, а не здесь.

Правка `packages/core/src/adapters/blockscout/index.ts` ограничена прохождением броска наружу.
Значение `rateLimit` и его пометка не трогаются — граница AC-42 (задача 015-12).
