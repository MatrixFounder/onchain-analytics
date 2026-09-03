# Задача 014.32b: регистрация двух тулов и шестнадцать инвентарных каналов

## Связь со сценариями

- UC-1 — n8n вызывает способность по сети

<!-- contract:goal -->

## Цель задачи

Зарегистрировать `ToolSpec` тулов `onchain_pool_info` и `onchain_token_pools` со схемами и
заглушечными обработчиками, закрыть все инвентарные каналы обоих тулов и оставить сьюту зелёной на
заглушечных значениях.

**Why.** `docs/PLAN.md:59` освобождает от Stub-First только там, где первая фаза оказалась бы
пустой. Здесь она несёт два `ToolSpec`, четыре схемы и шестнадцать правок инвентаря — то есть всю
форму, которую логика потом наполняет.

**Why две регистрации в одной задаче.** Снимок `tools/list` замораживает набор тулов, и AC-2
принимает его правку только с обоснованием в коммите. Две отдельные заглушки двигали бы снимок
дважды и вели бы два списка инвентарных обязательств, которые разошлись бы на первом же изменении.

**Контракты спроектированы до этой задачи.** `docs/architectures/interfaces.md` §5.1.7 для
`onchain_pool_info` и §5.1.8 для `onchain_token_pools`. Задача фиксирует их исполнимой формой, а не
вводит.

<!-- contract:changes -->

## Описание изменений

### Новые файлы

- `packages/mcp-server/src/tools/pool-info.ts` — `ToolSpec`, схемы, заглушечный обработчик
- `packages/mcp-server/src/tools/token-pools.ts` — то же для второго тула
- `packages/mcp-server/test/tool-registration-stub.test.ts` — контрактные тесты на заглушках

### Заглушка отвечает типизированным отказом, а не пустым значением

Обработчик до отгрузки логики отвечает отказом, называющим задачу, которая его снимает: 014-32c для
`pool.info`, 014-32d для `token.pools`.

**Why.** Пустой объект и пустой массив на этих двух тулах неотличимы от «пул без токенов» и «токен
без пулов» ⇒ заглушка, отдающая их, порождает ответ, у которого нет признаков незавершённости. Это
класс L-10 и запись M6.

### Интервал заглушки объявляется в `CAPABILITY_EXCLUSIONS`, и это решение, а не запись

Регистрация `ToolSpec` делает способность «обслуженной» для
`packages/mcp-server/test/eval-capability-coverage.test.ts:48`,
`const accounted = new Set<string>([`. Множество `accounted` собирается из `CAPABILITY_TOOLS` и
`CAPABILITY_EXCLUSIONS` — и **не** из `CAPABILITY_KNOWN_GAPS`. Файлы кейсов, наполняющие
`CAPABILITY_TOOLS`, создают 014-32c и 014-32d.

**Следствие:** без записи обе способности обслужены и не покрыты кейсом, и сьюта даёт отказ — то
есть Stub-First-контракт «тест на стабе зелёный» не выполняется.

`pool.info` и `token.pools` заносятся в `CAPABILITY_EXCLUSIONS` с причиной «зарегистрирована
заглушка, логику отгружает 014-32c / 014-32d».

**Снятие каждой записи назначено поимённо.** Строку `pool.info` удаляет 014-32c, строку
`token.pools` — 014-32d, тем же коммитом, что создаёт файл кейса. Обе задачи называют
`CAPABILITY_EXCLUSIONS`, а не `CAPABILITY_KNOWN_GAPS`: во второй карте строки `token.pools` нет и
эта задача её не заводит (`packages/mcp-server/eval/capabilities.mjs:85`,
`export const CAPABILITY_KNOWN_GAPS = new Map([` — в ней ровно два ключа, `token.metadata` и
`pool.info`).

**Какой сломанный случай маскирует новый законный ответ.** Запись в `CAPABILITY_EXCLUSIONS` делает
`accounted` истинным без кейса ⇒ она маскирует «тул зарегистрирован и не проверяется ничем». Это
запись M6 памяти. Поэтому: причина называет снимающую задачу поимённо, а 014-34 сверяет отсутствие
обеих записей после отгрузки 014-32c и 014-32d — проверка внесена в
`docs/tasks/task-014-34-acceptance.md` этой же правкой, отдельным пунктом приёмки, а не обещанием.

**AC-29 закрывает 014-32c, не эта задача.** Гейт сверки требует, чтобы каждый ключ манифеста
обслуживал зарегистрированный тул либо был назван в объявленном списке с причиной. Зарегистрированная
заглушка удовлетворяет первую ветвь буквой, не обслуживая ключ.

**Why.** Иначе гейт, заведённый ради L-15, станет зелёным над тулом, который способность не
обслуживает, — то есть примет ровно ту форму, ради обнаружения которой написан.

### Шестнадцать инвентарных каналов — восемь на тул

Перечень ведёт `packages/mcp-server/test/inventory-channels.ts:36`,
`export const INVENTORY_CHANNELS: readonly InventoryChannel[] = [`.

**Файл `packages/mcp-server/src/tools/tool-specs.ts`:**

- Зарегистрировать оба тула через `defineTool`

**Файл `packages/mcp-server/tool-inventory.json`:**

- Перегенерировать

**Семь гейтованных документов — каждый называет оба тула:**

- `README.md` и `README.ru.md` — **оба в корне репозитория**; файла
  `packages/mcp-server/README.md` не существует, перечень ведёт
  `packages/mcp-server/test/tool-inventory-docs.test.ts:49`, `const GATED_DOCUMENTS = [`
- `docs/ARCHITECTURE.md`
- `docs/architectures/interfaces.md`
- `docs/architectures/functional-architecture.md`
- `docs/onchain-analytics/ROADMAP.md`
- `packages/mcp-server/.AGENTS.md`

**Перечисление имён — обязательство сверх упоминания, и у него три области.** Гейт
`packages/mcp-server/test/docs-counts.test.ts:260`,
`it('lists the tool NAMES correctly wherever a document enumerates them (WI-48)', async () => {`
сличает содержимое области с живым реестром через `toStrictEqual`:

- `docs/onchain-analytics/ROADMAP.md` — таблица состава, имена в обратных кавычках
- `packages/mcp-server/.AGENTS.md` — список после `**The <число> tools today:**`, в порядке
  регистрации
- `docs/architectures/functional-architecture.md` — узел C4:
  `packages/mcp-server/test/docs-counts.test.ts:293`,
  `from: /MCP\["MCP server @onchain-intel\/mcp-server — \d+ tools/`. Имена там **без префикса
  `onchain_`** и разделены `·`

**Why названо отдельно.** «Документ называет тул» и «документ перечисляет тулы» — разные
обязательства: правка одного лишь числа `— NN tools` в узле C4 оставит утверждение области красным.
Объявленный канал репозитория для этого гейта обязательство перечисления не формулирует
(`packages/mcp-server/test/inventory-channels.ts:53`,
`gate: 'packages/mcp-server/test/docs-counts.test.ts',`), поэтому перечень ведёт эта задача.

**Файл `docs/architectures/interfaces.md` — сверх упоминания:**

- §5.1.7 и §5.1.8 получают якорь `// Capability:` в пределах 25 строк от имени тула
- Преамбула §5.1 перестаёт называть тулы спроектированными и не зарегистрированными
  (`docs/architectures/interfaces.md:12`, `**Two further tools are designed and not registered.**`)
- **Суффикс `DESIGNED, not registered` снимается во всех четырёх местах внутри §5.1.7 и §5.1.8.**
  Числовой греп их не находит: цифр двадцатых на этих строках нет. Координаты:
  - `docs/architectures/interfaces.md:621` — `#### 5.1.7 The pool tool (T-014, R-21.1) — DESIGNED, not registered`
  - `docs/architectures/interfaces.md:649` — `DexScreener-backed, keyless, 0 credits. DESIGNED, not registered.`
  - `docs/architectures/interfaces.md:843` — `#### 5.1.8 The token-pools tool (T-014, R-34) — DESIGNED, not registered`
  - `docs/architectures/interfaces.md:864` — `// DESIGNED, not registered.`
- `docs/tasks/task-014-32d-token-pools-tool.md:39` цитирует заголовок §5.1.8 **вместе с суффиксом**
  как якорь своего контракта; цитата приводится к новому заголовку тем же коммитом, иначе
  позиционная ссылка живой задачи перестаёт разрешаться
- Строки 829-830 объявляют, что регистрирующий коммит удаляет строку `pool.info` из карты пробелов;
  план это исполняет буквально — правки текста не требуется

**Числа тулов в настоящем времени — во всех документах, не только в `interfaces.md`.** Гейт
`packages/mcp-server/test/docs-counts.test.ts:166` обходит не менее 24 утверждений в
`ARCHITECTURE.md`, обоих `README`, `security.md`, `deployment.md`, `functional-architecture.md`,
`technology-stack.md`, `system-architecture.md`, `.AGENTS.md` пакета и `ROADMAP.md`.

**Файл `packages/mcp-server/test/docs-counts.test.ts` — правятся шаблоны, а не только словарь:**

- Захват во всех шаблонах числительных расширяется с `(\w+)` до формы, принимающей дефис и пробел:
  `packages/mcp-server/test/docs-counts.test.ts:172`, `/of the (\w+) tools take a chain/g` — и так же
  на `:169`, `:170`, `:175`, `:211`, `:219`, `:223` и `:377`
- Русский шаблон принимает двухсловное числительное **и обе формы существительного**:
  `packages/mcp-server/test/docs-counts.test.ts:209`,
  `/\*\*([А-Яа-яЁё]+) тулов\*\*, в порядке публикации/g`
- **Оба якоря областей WI-48 переякориваются, их два.** Русский —
  `packages/mcp-server/test/docs-counts.test.ts:276`,
  `from: /\*\*[А-Яа-яЁё]+ тулов\*\*, в порядке публикации:/`; английский —
  `packages/mcp-server/test/docs-counts.test.ts:282`, `from: /\*\*The \w+ tools today:\*\*/,`

**Why английский якорь ломается, хотя его никто не трогает.** Задача сама ведёт это предложение к
дефисной форме, расширяя парный захватывающий шаблон `:211`. Живой текст —
`packages/mcp-server/.AGENTS.md:35`, `**The twenty tools today:**` — слово, не цифра. У якоря `:282`
группы захвата нет, расширение захватов до него не дотягивается, и область перестаёт находиться:
`packages/mcp-server/test/docs-counts.test.ts:311`,
`region cannot be located, so this gate would check nothing. Re-anchor it.`.

**Русское существительное зашито в обоих читателях, и числительное 22 требует другой формы.**
Захватывающий шаблон `:209` и якорь `:276` содержат литерал ` тулов`. Двадцать управляет родительным
множественного («двадцать тулов»), двадцать два — родительным единственного («двадцать два тула»).
Расширение только числительного даёт безграмотное «Двадцать два тулов» в гейтуемом документе.

**Решение: расширяется и существительное.** В обоих читателях ` тулов` заменяется на форму,
принимающую оба окончания, а `docs/onchain-analytics/ROADMAP.md:272`
(`**Двадцать тулов**, в порядке публикации:`) получает грамматически верное «**Двадцать два тула**».
Отвергнуто «написать цифрой `22`»: `\w` цифру покрывает и правка была бы меньше, но дом стиля этих
документов — числительное словом (`docs/ARCHITECTURE.md:120`,
`capability manifest carries twenty-six rows.`), и цифра рассогласовала бы русский документ с
английскими.

- Словарь `WORDS` (`packages/mcp-server/test/docs-counts.test.ts:58`, `const WORDS: Record<string, number> = {`)
  получает `'twenty-two'` и `'двадцать два'`; `toNumber` нормализует внутренний пробел

**Why расширения словаря недостаточно.** `WORDS` читается только из `toNumber`
(`packages/mcp-server/test/docs-counts.test.ts:91`, `function toNumber(token: string): number {`), а
`toNumber` вызывается на `match[1]` **уже совпавшего** шаблона. `\w` — это `[A-Za-z0-9_]`: на строке
«of the twenty-two tools take a chain» захват берёт `twenty`, упирается в дефис вместо ` tools` и
совпадение не состоится вовсе. Утверждение не станет неверным — оно **исчезнет**, и упадёт
`expect(claims.length).toBeGreaterThanOrEqual(24)`
(`packages/mcp-server/test/docs-counts.test.ts:235`). До словаря дело не доходит.

**Why якоря правятся тем же коммитом.** Оба входа областей перечисления литеральны намеренно, и оба
перестают находиться при переходе на новое числительное. Отказ громкий и самоназывающий:
`packages/mcp-server/test/docs-counts.test.ts:340`, `region cannot be located, so this gate would check nothing. Re-anchor it.`.
Переякоривание — работа задачи, а не побочный эффект.

**Файл `docs/ARCHITECTURE.md`:**

- §5 называет два спроектированных и незарегистрированных тула; после задачи их ноль, а число
  зарегистрированных становится 22
- `docs/ARCHITECTURE.md:51`, `The server publishes twenty tools; the` — **третий счёт в этом файле, и
  его не читает ни один гейт.** Шаблонов по `ARCHITECTURE.md` в тесте счёта ровно два (`:241` и
  `:242`), они ловят `:50` и `:271`. Без явного назначения `:119` тихо становится ложным при критерии
  «все числа тулов в настоящем времени обновлены»

**Файл `docs/architectures/functional-architecture.md` — счёт и перечисление вне всех гейтов:**

- Строка 117, `- **Twenty registered tools**, all zod in/out and registry-routed, declared once in` —
  настоящее время, становится «Twenty-two»
- Строки 119-142 перечисляют двадцать тулов по вехам. Область WI-48 в этом файле привязана к узлу
  C4 (`packages/mcp-server/test/docs-counts.test.ts:293`), то есть этот перечень не читает никто, а
  `packages/mcp-server/test/tool-inventory-docs.test.ts` требует лишь присутствия имени где-либо в
  файле

**Why названо отдельно.** Минимальная правка, удовлетворяющая обоим гейтам этого файла, — узел C4;
заголовок «Twenty registered tools» и перечень под ним переживают её при зелёной сьюте. Репозиторий
уже проходил этот дрейф на этом же файле — он и есть предмет WI-48.

**Файл `packages/mcp-server/test/tool-inventory-docs.test.ts`:**

- Обе записи покидают `PLANNED_TOOL_NAMES`

**Файл `packages/mcp-server/eval/capabilities.mjs`:**

- `CAPABILITY_EXCLUSIONS`: две записи интервала заглушки, каждая называет снимающую задачу
- `CAPABILITY_KNOWN_GAPS`: строка `pool.info` **удаляется**, а не переписывается

**Why удаляется.** `unwiredCapabilities` коротит на исключении до того, как ищет причину
(`packages/mcp-server/eval/capabilities.mjs:124`,
`if (wired.has(capability) || CAPABILITY_EXCLUSIONS.has(capability)) continue;`) ⇒ переписанная
причина стала бы мёртвым текстом, который ни один прогон не печатает. Удаление совпадает с уже
записанным контрактом: `docs/architectures/interfaces.md:835`,
`The registering commit deletes the`.

**Файл `packages/mcp-server/eval/checks.mjs` — не трогается этой задачей.**

**Why.** `packages/mcp-server/test/eval-checks-coverage.test.ts:71`, `const invoked = [` требует
запись только на тул, который eval **вызывает** (заголовок теста —
`packages/mcp-server/test/eval-checks-coverage.test.ts:70`,
`it('checks every tool the eval actually invokes', () => {`). Файлов
кейсов эта задача не создаёт, поэтому ни один из двух тулов не вызывается. Записи заводят 014-32c и
014-32d вместе со своими кейсами.

**Файл `packages/core/src/types/pool.ts`:**

- Шесть необязательных полей: `baseTokenAddress`, `quoteTokenAddress`, `reserveBase`,
  `reserveQuote`, `feeTierBps`, `versionLabel`

**Why здесь, а не в 014-32c.** Поля входят в опубликованную схему обоих тулов и в схему
`onchain_active_pairs`, который встраивает тот же тип ⇒ снимок `tools/list` двигает их появление, а
снимок эта задача двигает один раз.

**Файл `packages/core/src/capability-manifest.ts`:**

- Строка `token.pools`: `shape: 'set'`, `ttlSeconds` и `deadlineMs` по образцу строки `pool.info`,
  поле `shareable` со значением и записью вывода
- Строка `pool.info` меняет `shape` с `set` на `point`; AUDIT-комментарий переписывается
- Перекрёстная ссылка на это прочтение живёт во второй строке того же файла:
  `packages/core/src/capability-manifest.ts:333`,
  `by the same reading that classified` —
  строка `protocol.list` обосновывает свой `shape` через `pool.info`. Коммит, переклассифицирующий
  `pool.info`, оставляет её ссылающейся на удалённое прочтение. Гейты `shape`-прозу не читают, то
  есть дрейф тихий
- Зашитое число строк в докстринге файла: 26 → 27 — на `:117`
  (`* **Every one of the 26 rows carries its own marker, and a test counts them.** The first version of`)
  и на `:236` (`// not the enforcement record for any of them:** each of the 26 rows carries its OWN`)
- Зашитый счёт маршрутов на `packages/core/src/capability-manifest.ts:210`,
  `All 23 routed capabilities` — **строка устарела до этой задачи**: живой замер сегодня 27
  маршрутов над 26 способностями (`packages/core/test/policy.test.ts:733`,
  `expect(routes).toHaveLength(27);`). После задачи верное значение — **28 маршрутов над 27
  способностями**, а не «24 и 25»
- Строка `packages/core/src/capability-manifest.ts:74`
  (`* **Measured 2026-08-05, re-measured 2026-08-11** over the shipped registry (`) несёт ту же
  устаревшую пару, но она **датирована** ⇒ по R-23.6 не переписывается; рядом ставится действующее
  число

**Why счёт назван поимённо.** Предыдущая редакция этой задачи предписывала «24 способности и 25
маршрутов», сложив +1 к цифре из докстринга вместо замера, — та самая ошибка «Measure, don't
eyeball», от которой докстринг и устарел. Форма `All <число> routed capabilities` не ловилась гейтом
`TC-E2E-05` вовсе — поэтому именно эта строка и устарела на три незамеченной. Третья форма внесена в
`TC-E2E-05` этим же изменением (`docs/tasks/task-014-34-acceptance.md:128`), так что после задачи
число на `:210` гейтовано.

### Числа, живущие в прозе, находятся грепом, а не перечнем

Три числа рассыпаны по документам и коду в форме, которую не читает ни один гейт: строк манифеста
(26), маршрутизируемых способностей (26) и маршрутов (27). Задача **не перечисляет** их вхождения.
Задача предписывает найти их и обработать:

```
grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude-dir=tasks --exclude-dir=plans --exclude-dir=reviews --exclude-dir=issues \
    --exclude-dir=backlog --exclude-dir=dune-query-discovery --exclude-dir=raw \
    -Ei '\b(2[0-9]|twenty[- ][a-z]+|двадцать [а-я]+)\b' \
    docs packages README.md README.ru.md .env.example \
  | grep -vE 'docs/(TASK|PLAN)\.md|version-history\.md' \
  | grep -Ei 'row|capabilit|route|manifest|tool|строк|способност|маршрут|тул'
```

**Шаблон намеренно избыточен, и это его свойство, а не дефект.** Он ловит любое число из двадцатых
рядом с любым из релевантных существительных, на обоих языках и с любыми словами между ними. Точный
шаблон уже дважды прошёл мимо живых форм: `26 routed capabilities` в трёх заголовках тестов и
`returns 26` / `26 keys` в `docs/architectures/interfaces.md` — оба раза потому, что я угадывал
формулировку вместо того, чтобы искать число. Лишние попадания стоят одного взгляда каждое;
пропущенное не стоит ничего до тех пор, пока не станет ложью в контракте.

**Регистр не различается: флаг `-i` стоит на обоих шагах.** Без него первый шаг пропускает
`docs/architectures/functional-architecture.md:117`,
`- **Twenty registered tools**, all zod in/out and registry-routed, declared once in` — заглавная
`T`, цифры на строке нет, и до фильтра по существительному дело не доходит. Соседняя строчная форма
(`docs/architectures/interfaces.md:1267`) при этом ловится: разница в один символ.

**Объём триажа измерен, а не оценён.** Замер 2026-08-20 на дереве до правок: **443 строки**.
Большинство — числа двадцатых в посторонних смыслах (таймауты, размеры страниц, номера задач);
относящихся к трём числам — десятки. Число названо, чтобы исполнитель не принял объём выдачи за
признак неверного шаблона и не начал его сужать.

**Область исключений скопирована с исполняемого гейта репозитория, а не придумана.**
`packages/mcp-server/test/tool-inventory-docs.test.ts:123`, `const EXCLUDED_PATH_PATTERNS = [` —
`docs/tasks/`, `docs/plans/`, `docs/reviews/`, `docs/issues/`, `docs/backlog/`,
`docs/dune-query-discovery/`, `docs/onchain-analytics/raw/`, `docs/TASK.md`, `docs/PLAN.md`,
`.agent/`. Причина там же, `:33`, и она чужая, не моя: переписывать историю под сегодняшний
инвентарь хуже, чем не иметь гейта вовсе. Файлы задач, ревью и бэклога — снимки завершённой работы;
число в них верно на дату записи.

**Почему `docs/TASK.md` и `docs/PLAN.md` исключены, хотя они живые.** Их числа ведёт RTM и таблица
оценки, а не эта задача; за ними следят `scan_register.py` и гейты приёмки 014-34.

Каждое найденное вхождение обрабатывается по своей форме:

- **настоящее время** — переписывается на действующее число;
- **датированный замер** (в предложении стоит дата или слово `Measured`/`замер`) — не переписывается;
  рядом ставится действующее число (R-23.6);
- **исторический контекст эпохи** (`docs/architectures/version-history.md`, changelog-поля
  `ARCHITECTURE.md`, тексты, прямо названные записями прошлого) — не трогается вовсе.

**Спорный случай решается в пользу датированного обращения.** Если по тексту нельзя решить, замер
это или утверждение настоящего времени, вхождение обрабатывается как датированное: рядом ставится
действующее число, исходный текст сохраняется. Переписанный замер невосстановим, а лишнее уточнение
рядом — нет.

**Why перечня здесь нет.** Три редакции этой задачи подряд перечисляли вхождения и трижды
недосчитали: сначала было названо одно место из десяти, потом девять под заголовком «десять», потом
тринадцать при том, что грепу видно больше — включая `docs/ARCHITECTURE.md:10`, где число стоит
дважды, и три файла задач этапа. Перечень в прозе — это счётное утверждение, которое стареет между
написанием и исполнением; греп стареть не может. Это то же лекарство, что применено к гейтам выше:
измерить, а не пересказать.

**Гейт для этой правки существует только на части мест**, и это причина, а не оправдание:
`packages/core/test/capability-manifest.test.ts:46` проверяет лишь нижнюю границу, а гейтованы
только строка отношения ENFORCEMENT (`:95`), докстринг и таблица (`:117`, `:236`, `:210`) через
`TC-E2E-05` задачи 014-34. Остальные расходятся молча — класс M3, ради которого предписан греп.

**Файл `packages/core/src/providers.config.ts`:**

- Маршрут `{ capability: 'token.pools', adapterIds: ['dexscreener'] }`

### Гейты вне восьми инвентарных каналов

**Первым действием прогоняется непочиненная сьюта, и перечень ниже — вход, а не итог.** Обе
регистрации, строка манифеста и маршрут вносятся, полный прогон исполняется **до** правки гейтов, и
список упавших утверждений записывается измеренным. Перечисленное ниже сверяется с измеренным: всё,
что упало и не названо, дописывается; всё, что названо и не упало, вычёркивается с причиной.

**Why перечень не пинится числом.** Прецедент этой же формы задачи: `docs/tasks/task-013-8-tool-registration-channels.md:17`,
`фактическое срабатывание каждого, а не пересказав список по памяти` — там полный прогон
непочиненным стоит первым пунктом списка изменений, и `packages/mcp-server/test/inventory-channels.ts:19`
записывает результат словами `The list below was MEASURED, not recalled`. Раунды 3, 5 и 6 ревью
плана отклонили ровно счётное утверждение: перечень, выведенный чтением, трижды оказывался неполным,
и каждый раз недостача обнаруживалась не автором. Измерение снимает класс целиком.

**Знаменатель «восемь каналов» неполон, и это записано в пакете, который задача правит.**
`packages/mcp-server/.AGENTS.md:1579`, `**Three gates outside the eight also fired**` — там поимённо
названы `tool-response-shape.test.ts`, `readme-tool-table.test.ts` и
`tools/chain-discoverability.test.ts`, причём про последний сказано «named nowhere … the next tool
author should know it exists». Эта задача — тот самый следующий автор.

**Ломает регистрация двух тулов (20 → 22):**

- `packages/mcp-server/test/tool-response-shape.test.ts:122`, `expect(tools).toHaveLength(20);` —
  над живым реестром, становится 22
- `packages/mcp-server/test/tools/chain-discoverability.test.ts:77`,
  `expect(tool.description ?? '', tool.name).toContain('onchain_list_chains');` — описания обоих
  тулов обязаны называть тул обнаружения, потому что оба принимают `chain`
- `packages/mcp-server/test/readme-tool-table.test.ts:177`,
  `expect(rows.length).toBe(toolSpecs.length);` — число выводится из реестра, но по строке таблицы
  на каждый тул надо дописать в **оба** README, и языки сличаются построчно
- `docs/architectures/interfaces.md:17`, `Seventeen of the twenty tools take a chain` —
  девятнадцать из двадцати двух; читает `packages/mcp-server/test/docs-counts.test.ts:377`

**Ломает новая строка манифеста и новый маршрут (способностей 26 → 27, маршрутов 27 → 28):**

- `packages/core/test/policy.test.ts:733`, `expect(routes).toHaveLength(27);` — становится 28
- `packages/core/test/capability-manifest.test.ts:70`,
  `expect(routedCapabilities).toHaveLength(26);` — становится 27
- `packages/core/test/capability-manifest.test.ts:664`,
  `expect(scannedFieldCount(manifestSource)).toBe(29); // 26 deadlineMs + 3 paidLegMs` — становится
  30, и комментарий тоже
- `packages/core/test/capability-manifest.test.ts:1108`, `expect(blocks.size).toBe(26);` — становится
  27
- `packages/core/src/capability-manifest.ts:95`,
  `* - **26 of 26 capabilities are therefore actually bounded by their row below.** The three added` —
  становится `27 of 27`. Это **гейтованная** прозаическая строка:
  `packages/core/test/capability-manifest.test.ts:1176`,
  `const capabilityClaim = /\*\*(\d+) of (\d+) capabilities are therefore actually bounded/.exec(`, и
  утверждение на `:1191`. Обе цифры двигаются вместе: `blocks.size` считает строки манифеста, а
  `measuredEnforced` — способности, чьи адаптеры читают дедлайн, и `dexscreener` входит в измеренный
  список. Строка названа поимённо в `docs/TASK.md:270` как место R-23.7
- `packages/mcp-server/test/readme-tool-table.test.ts:620`, `expect(routed).toHaveLength(26);` —
  становится 27
- `packages/mcp-server/test/readme-tool-table.test.ts:412`,
  `expect(rows.length).toBe(21); // the exact row count of §3.2's table, not a floor` — становится
  22: §3.2 обязана нести строку TTL на **каждую** маршрутизируемую способность
- `docs/architectures/system-architecture-chain-normalization.md:1126`, `holds **27 routes** over 26` — 28 над 27;
  читает `packages/mcp-server/test/docs-counts.test.ts:329`
- `docs/architectures/system-architecture-call-budget.md:322` — первая строка данных таблицы дедлайнов
  перечисляет способности поимённо, и `token.pools` в ней нет. Это **вторая** проверка полноты в том
  же тестовом файле, отдельная от таблицы TTL §3.2:
  `packages/mcp-server/test/readme-tool-table.test.ts:602`,
  `` `${capability}: the manifest gives it a deadlineMs the table never documents`, `` над живым
  `routed`. Восьмой строкой не чинится — `packages/mcp-server/test/readme-tool-table.test.ts:619`,
  `expect(deadlineRows(markdown, routed).length).toBe(7); // the exact row count, not a floor`;
  правка одна: расширить перечень на `:246`

**Две замороженные таблицы получают не строку, а именованное исключение.** Это решение, а не правка.

- `packages/core/test/capability-manifest.test.ts:184`,
  `expect(Object.keys(TTL_SECONDS_BEFORE_THE_MOVE)).toHaveLength(26);`
- `packages/core/test/ttl-coverage.test.ts:219`,
  `expect(Object.keys(TTL_FOR_BEFORE_THE_MOVE).sort()).toStrictEqual(routedCapabilities);`
- `packages/core/test/ttl-coverage.test.ts:278`, `expect(fallingThrough).toStrictEqual([]);` — **второй
  читатель того же замороженного литерала**, в отдельном `it`
  (`packages/core/test/ttl-coverage.test.ts:239`,
  `it('is unreachable for the 26 routed capabilities — enumerated, not asserted in general', () => {`).
  Исключение применяется к обоим, иначе отказ приходит под заголовком про провал в
  `DEFAULT_TTL_SECONDS` и уводит от прописанного решения

**Why исключение, а не строка.** Обе таблицы — исторический снимок «до переезда», и заголовок это
объявляет: `packages/core/test/capability-manifest.test.ts:183`,
`it('pins all 26, so a TTL edit disguised as a migration fails here', () => {`. У способности,
которой до переезда не существовало, значения «до» нет ⇒ вписать ей строку означало бы
сфабриковать замер и обессмыслить гейт. Сравнение получает явный перечень способностей, заведённых
после переезда; `token.pools` — его первая запись, с причиной. Для всех дошедших до переезда строк
гейт остаётся ровно таким же строгим.

**Файл `packages/core/src/adapters/dexscreener/index.ts`:**

- `capabilities()` объявляет третью способность

**Файл `docs/architectures/system-architecture.md`:**

- Строка 1620 — строка адаптера `dexscreener` в таблице — называет две способности; становится три.
  Гейт над таблицей проверяет только присутствие идентификатора адаптера
  (`packages/mcp-server/test/docs-counts.test.ts:489`,
  `it('names every registered adapter id in the system-architecture adapter table', () => {`), то
  есть расхождение тихое

**Файл `packages/core/test/dexscreener.contract.test.ts`:**

- Утверждение на точное равенство списка способностей принимает третий элемент
  (`packages/core/test/dexscreener.contract.test.ts:140`,
  `expect(caps.map((c) => c.id).sort()).toEqual(['pairs.active', 'pool.info']);`)

### Измеренный список падений непочиненной сьюты (2026-08-20)

Прогон исполнен после внесения двух регистраций, строки манифеста, маршрута, третьей способности
адаптера и шести полей `Pool` — и **до** единой правки гейтов. **32 упавших утверждения в 14 файлах**:
core 9 из 1612, mcp-server 23 из 825.

**core (9).** Все девять названы разделом «Гейты вне восьми инвентарных каналов» — координаты
сместились на несколько строк, предмет совпал.

| файл:строка                        | предмет                                          |
| :--------------------------------- | :----------------------------------------------- |
| `policy.test.ts:733`               | маршрутов 27 → 28                                |
| `capability-manifest.test.ts:70`   | способностей 26 → 27                             |
| `capability-manifest.test.ts:189`  | замороженная таблица TTL «до переезда»           |
| `capability-manifest.test.ts:666`  | `scannedFieldCount` 29 → 30                      |
| `capability-manifest.test.ts:1175` | гейтованная строка `26 of 26` → `27 of 27`       |
| `capability-manifest.test.ts:1258` | `blocks.size` 26 → 27                            |
| `dexscreener.contract.test.ts:140` | точный список способностей адаптера              |
| `ttl-coverage.test.ts:221`         | замороженная таблица, второй читатель            |
| `ttl-coverage.test.ts:248`         | `fallingThrough`, третий читатель той же таблицы |

**mcp-server (23).** Двадцать — восемь инвентарных каналов и уже названные гейты счёта. **Три не
названы задачей ни в одном разделе:**

1. `route-disclosure-schema.test.ts` — «names the tools that publish output without validating it
   against their own schema». Список точный, и заглушке валидировать нечего: она не публикует
   вывод вовсе. Обрабатывается так, как требует само сообщение гейта — обе записи вносятся с
   причиной, называющей снимающую задачу. Снимают их 014-32c и 014-32d вместе с логикой
2. `tools-refusal-class.test.ts` — «every `ok: false` literal lives in one of the two declared
   producers». Отказ заглушки — третий объявленный производитель, `src/tools/stub-refusal.ts`.
   Запись постоянная, не интервальная: производитель всегда несёт класс, а это ровно то, чего
   гейт требует
3. `wire-deadline.test.ts:194` — `expect(toolSpecs.length).toBe(snapshot.length)`. Отдельной правки
   не требует: утверждение читает замороженный снимок `tools/list` и зеленеет его перегенерацией

**Названо разделом и не упало — одно.** `tools/chain-discoverability.test.ts:77` требует, чтобы
описание тула, принимающего `chain`, называло `onchain_list_chains`. Оба описания его называют с
первой редакции, поэтому утверждение зелёное. Вычеркнуто с причиной, а не оставлено в перечне.

### Схемы ввода

`ChainInputSchema`, адрес по формату сети, `.strict()`, `isValidAddress` внутри `superRefine` — та
форма, которую несёт `WalletBalancesInputSchema`. Ни одно поле не порождает хост, URL или эндпоинт:
гейт задачи 014-22 обходит опубликованную схему и распространяется на обе новые.

<!-- contract:tests -->

## Тест-кейсы

### Модульные тесты

1. **TC-UNIT-01:** оба тула присутствуют в `toolSpecs`; число тулов в тесте не зашито
2. **TC-UNIT-02:** каждая схема ввода `.strict()` и не принимает хост, URL или эндпоинт (AC-11)
3. **TC-UNIT-03:** вызов заглушки отвечает типизированным отказом, называющим задачу-снимающую
4. **TC-UNIT-04:** заглушка не отвечает пустым объектом и не отвечает пустым массивом
5. **TC-UNIT-05:** `pool.info` неразделяем: `shape: 'point'` не участвует в слиянии серий
6. **TC-UNIT-06:** строка `token.pools` манифеста несёт `shareable`
7. **TC-UNIT-07:** `capabilities()` адаптера объявляет три способности
8. **TC-UNIT-08:** каждая способность, обслуженная тулом, имеет кейс либо запись в
   `CAPABILITY_EXCLUSIONS`; падает при удалении любой из двух записей интервала заглушки
9. **TC-UNIT-09:** причина каждой записи интервала заглушки называет снимающую задачу

### Регрессионные тесты

- Снимок `tools/list` двигается один раз: два тула и шесть необязательных полей в
  `onchain_active_pairs`; правка обоснована в коммите (AC-2)
- Число тулов не зашито ни в одном тесте инвентаря
- Мутация: удаление одного тула из `toolSpecs` роняет сверку с закоммиченным снимком
- `docs-counts.test.ts` зелёный на числе 22 в обеих языковых формах; откат расширения захвата роняет
  его — то есть расширение проверено, а не объявлено
- Мутация: возврат любого утверждения из **измеренного** перечня к прежнему числу роняет сьюту

<!-- contract:acceptance -->

## Критерии приёмки

- [x] Оба `ToolSpec` зарегистрированы; схемы `.strict()`; сьюта зелёная на заглушках
- [x] Восемь инвентарных каналов пройдены для каждого тула
- [x] Непочиненный прогон исполнен первым, измеренный список упавших утверждений записан в задаче —
      32 утверждения в 14 файлах, раздел «Измеренный список падений непочиненной сьюты»
- [x] Измеренный список сверен с перечнем раздела «Гейты вне восьми инвентарных каналов»: три
      упавших и не названных дописаны, одно названное и не упавшее вычеркнуто с причиной
- [x] Каждое утверждение измеренного списка зелёное — core 1614, mcp-server 842
- [x] Заглушка отвечает типизированным отказом, называющим задачу-снимающую
- [x] `pool.info` и `token.pools` названы в `CAPABILITY_EXCLUSIONS`; причина называет снимающую
      задачу
- [x] AC-2 (частично): снимок `tools/list` двигается один раз, обоснование в коммите — диф
      строго аддитивный, 365 строк добавлено, ноль удалено
- [x] AC-11 (частично): ни одно поле обеих схем не порождает хост, URL или эндпоинт — проверено по
      ОПУБЛИКОВАННОЙ схеме из снимка, а не по zod-объекту
- [x] AC-13 (частично): строка `token.pools` несёт `shareable`
- [x] Греп по трём числам прогнан; каждое найденное вхождение обработано по своей форме, и
      повторный прогон не находит ни одного вхождения старого числа в настоящем времени
- [x] Гейтованная строка отношения ENFORCEMENT (`capability-manifest.ts:95`) читает `27 of 27`
- [x] Счёт способностей и маршрутов приведён к замеру: 27 способностей, 28 маршрутов — не к «24 и 25»
- [x] Все числа тулов в настоящем времени обновлены; шаблоны числительных принимают дефисную и
      двухсловную форму вместе с обеими формами существительного; **оба** якоря областей WI-48
      переякорены
- [x] `ROADMAP.md` несёт грамматически верное «Двадцать два тула», и гейт на нём зелёный
- [x] Три области перечисления имён содержат оба тула, узел C4 — в своей форме без префикса
- [x] Оба читателя замороженной TTL-таблицы несут именованное исключение, а не сфабрикованную строку
      «до переезда»; каждое исключение сверяется с живым манифестом, поэтому опечатка в ключе никого
      не извиняет
- [x] Таблица дедлайнов `system-architecture.md` перечисляет `token.pools`
- [x] **Сверх плана:** вторая интервальная запись — `route-disclosure-schema.test.ts` — заведена с
      причиной, назначена 014-32c и 014-32d и внесена в приёмку 014-34

## Примечания

**Заглушка фиксирует форму, а не поведение.** `docs/PLAN.md:41` записывает цену ошибки прямо:
неверный стаб обходится дороже отсутствующего, поэтому обе схемы берутся из §5.1.7 и §5.1.8
дословно, а не пересказываются.
