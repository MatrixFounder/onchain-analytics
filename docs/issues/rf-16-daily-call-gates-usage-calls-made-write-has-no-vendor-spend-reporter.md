---
id: RF-16
type: known-issue
status: open
opened_at: 2026-08-28
category: workflow-docs
severity: SEV-3
slug: rf-16-daily-call-gates-usage-calls-made-write-has-no-vendor-spend-reporter
component: billing
evidence_paths:
  - packages/core/src/adapters/blockscout/call-gate.ts
  - packages/core/test/vendor-spend-gates.test.ts
  - packages/core/src/cache/vendor-spend.ts
  - docs/architectures/system-architecture.md
---

# RF-16 — суточный гейт вызовов пишет `usage.calls_made`, и этот момент никто не докладывает через `onVendorSpend`

**Что.** Задача 015-14 подключила `blockscout/call-gate.ts`'s `ensureCallBudget` к
`BudgetStore.checkAndReserve`. Каждый допущенный вызов увеличивает `usage.calls_made` внутри той же
транзакции, что и кредитную проверку. `vendor-spend-gates.test.ts`'s TC-GATE-01 — статический гейт
задачи 014-30 — требует, чтобы ЛЮБОЙ файл, вызывающий `checkAndReserve`/`recordDelta`, упоминал
`onVendorSpend`. Его собственный комментарий: «a new paid adapter — ADR-003 D6 extends the call
counter to any provider — would write to the ledger and report nothing». Комментарий гейта прямо
называет ADR-003 D6 — то есть предвидел ровно этот путь.

**Почему это не подвох, а реальный пробел.** `ensureCallBudget` вызывает `checkAndReserve` с
буквальным `cost: 0`. Эта строка никогда не сдвинет `usage.credits_used` — величину, на которую
рассчитана суточная сверка R-27.3. Но она сдвигает `usage.calls_made` (задача 015-14) на каждом
допущенном вызове, и это событие сегодня НИКТО не докладывает. `VendorChargeRecord.calls`
(`cache/vendor-spend.ts:99-109`) документирован как «вклад в `usage_window.calls_made`» — у него нет
поля под суточный счётчик. `onVendorSpend` — параметр per-REQUEST, спускаемый из
`mcp-server/src/tools/registry.ts:534` через `fetch()` конкретного адаптера; документированная
сигнатура `ensureCallBudget(now: () => number): Promise<void>` (`system-architecture.md` §3.5.4,
задача 015-13) такого канала не несёт.

**Почему полное решение не сделано внутри 015-14.** Проброс `onVendorSpend` вторым параметром
`ensureCallBudget` сам по себе обратно совместим — 015-15 всё ещё может звать `ensureCallBudget(now)`
без второго аргумента. Но конструирование `VendorChargeRecord` (`kind: 'charge'`) вне
`nansen/budget-gate.ts`/`nansen/reconcile.ts` ломает СТРОГИЙ список TC-GATE-02: «only the two
ledger-writing modules construct a charge receipt» (`toStrictEqual([...две строки...])`). Закрытие
пробела в одиночку означало бы одновременно: (а) добавить поле под суточный счётчик в
`VendorChargeRecord`, (б) расширить строгий список TC-GATE-02 третьим файлом, (в) провести получатель
через `registry.ts` для НЕ-nansen провайдера. Это три решения дизайна, которые не называет ни один
файл задач 015-12…015-19.

**Что сделано вместо этого.** `vendor-spend-gates.test.ts` получил узкое исключение
(`CREDIT_EXEMPT_WRITERS`) для `blockscout/call-gate.ts`, с обоснованием в тексте теста и зеркальной
заметкой в докстринге `call-gate.ts`.

**Первая редакция исключения была шире заявленного, и это измерено.** Исключение стояло на ИМЕНИ
файла, а не на свойстве, которым обосновано. Проверено мутацией 2026-08-28: второй вызов
`checkAndReserve` в том же файле на 500 кредитов, без единого упоминания `onVendorSpend`, оставил
гейт зелёным на 1699 из 1699. Оговорка «второй вызов или переменный `cost` возвращают файл под
действие правила» стояла прозой и ничем не исполнялась. Исключение переписано на предикат
`everyReserveIsFreeOfCredits`: имя лишь НОМИНИРУЕТ файл, а право на исключение он подтверждает на
каждом прогоне — все вызовы `checkAndReserve` в нём передают литеральный `0` третьим аргументом, и
`recordDelta` не вызывается вовсе. Файл без единого вызова тоже не проходит: исключение, верное
вхолостую, осталось бы в силе и после удаления тех вызовов, ради которых написано. Предикат покрыт шестью
синтетическими случаями, включая незакрытый список аргументов и вложенные запятые.

**Сам гейт удовлетворялся упоминанием в комментарии — дефект задачи 014-30, не 015-14.** Список
вызывающих собирался по строкам КОДА (`codeLines`), а наличие докладчика проверялось по СЫРОМУ тексту
файла: `readFileSync(...).includes('onVendorSpend')`. Асимметрия означала, что тринадцатый платный
адаптер проходил бы гейт, назвав `onVendorSpend` в докстринге. Измерено на дереве 2026-08-28: из трёх
файлов-вызывающих только `call-gate.ts` имел `raw=1, code=0` — то есть проходил ровно так, и потому
исключение выше было мёртвым кодом. Проверка приведена к строкам кода, симметрично сбору. Доказано
снятием номинации: файл немедленно всплывает в списке отказа.

**Что осталось открытым.** Суточная сверка `request_trace` против `usage` (R-27.3) для оси
`calls_made` blockscout сегодня ничем не подкреплена observability-каналом уровня записи — только
уровня инструмента (`tool.refused`, задача 015-17) и уровня VM-верификации (задача 015-24, читает
таблицу напрямую). Решение — отдельная задача: либо явно зафиксировать, что R-27.3 не распространяется
на суточный счётчик вызовов бесплатного провайдера (и это записать в `data-model.md`/
`system-architecture.md`), либо расширить `VendorChargeRecord`/`onVendorSpend`/TC-GATE-02 на третий
файл.

**Как проверить, что исключение не замаскировало что-то другое.** Прогнать
`grep -rn "\.checkAndReserve(\|\.recordDelta(" packages/core/src packages/mcp-server/src --include='*.ts'`
и свериться, что вне двух реализаций хранилища вызовов ровно четыре: две `recordDelta` в
`nansen/reconcile.ts`, одна `checkAndReserve` в `nansen/budget-gate.ts` и одна в
`packages/core/src/adapters/blockscout/call-gate.ts:106` с литеральным `0` третьим аргументом. Пятый вызов — повод перечитать
исключение, а не расширить его.
