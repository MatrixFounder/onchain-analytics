# WI-45 — аудит дрейфа координат живого корпуса

**Замер:** `bc30e13` (состояние до правки), корпус `docs/TASK.md`, `docs/PLAN.md`,
`docs/architectures/`. **Инструмент аудита:** `git blame` строки-цитаты → версия цели на том
коммите → текст на процитированной координате ТОГДА против ТЕПЕРЬ. Этим восстанавливается
референт, который автор написал бы, а не тот, на который ссылка попала после сдвига.

**Почему аудит идёт первым (§3 записи).** Простановка референтов до аудита припечатала бы
сегодняшнюю ошибку: авто-простановка привязала бы к съехавшей ссылке ту строку, на которую она
попала случайно, и превратила бы ошибку в вечную и формально верифицированную.

## 1. Итог замера

| Вердикт | Ссылок | Что сделано |
| :--- | ---: | :--- |
| Стабильные | 112 | номер не тронут, дописан референт |
| Съехавшие, чинятся механически | 42 | исходная строка автора найдена дословно и единственный раз → номер сдвинут на неё, дописан референт |
| Съехавшие, две площадки | 7 | прочитаны; разобраны в §3 |
| Цитируемый текст переписан | 4 | прочитаны; разобраны в §4 |
| Без опорной строки в диапазоне | 5 | номер не тронут, референт не выдуман |
| **Всего** | **170** | |

Заявка записи — «26 съехавших из 142 разрешимых» — **не подтвердилась**: разрешимых 170,
съехавших 53. Число в записи получено более слабым методом; здесь оно пересчитано прогоном.

## 2. Съехавшие, исправленные механически (42)

Ни одна не заякорена без совпадения текста: строка автора найдена в файле дословно и ровно один
раз. Δ — насколько уехала цитата.

| Документ | Было (на `bc30e13`) | Стало | Δ строк |
| :--- | :--- | :--- | ---: |
| `docs/PLAN.md` | `registry.ts:1083@bc30e13` | `packages/core/src/adapters/registry.ts:1554` | +471 |
| `docs/PLAN.md` | `adapters/types.ts:333@bc30e13` | `packages/core/src/adapters/types.ts:346` | +13 |
| `docs/PLAN.md` | `registry.ts:253@bc30e13` | `packages/core/src/adapters/registry.ts:317` | +64 |
| `docs/PLAN.md` | `registry.ts:1083@bc30e13` | `packages/core/src/adapters/registry.ts:1554` | +471 |
| `docs/TASK.md` | `capability-manifest.ts:165-167@bc30e13` | `packages/core/src/capability-manifest.ts:181-183` | +16 |
| `docs/TASK.md` | `registry.ts:443-453@bc30e13` | `packages/core/src/adapters/registry.ts:646-656` | +203 |
| `docs/TASK.md` | `registry.ts:858@bc30e13` | `packages/core/src/adapters/registry.ts:1468` | +610 |
| `docs/TASK.md` | `capability-manifest.test.ts:329@bc30e13` | `packages/core/test/capability-manifest.test.ts:391` | +62 |
| `docs/TASK.md` | `registry.ts:618-628@bc30e13` | `packages/core/src/adapters/registry.ts:835-845` | +217 |
| `docs/TASK.md` | `registry.ts:580@bc30e13` | `packages/core/src/adapters/registry.ts:644` | +64 |
| `docs/TASK.md` | `registry.ts:618-628@bc30e13` | `packages/core/src/adapters/registry.ts:835-845` | +217 |
| `docs/TASK.md` | `registry.ts:697-704@bc30e13` | `packages/core/src/adapters/registry.ts:1307-1314` | +610 |
| `docs/TASK.md` | `registry.ts:944@bc30e13` | `packages/core/src/adapters/registry.ts:1554` | +610 |
| `docs/TASK.md` | `registry.ts:929-943@bc30e13` | `packages/core/src/adapters/registry.ts:1539-1553` | +610 |
| `docs/TASK.md` | `types.ts:262@bc30e13` | `packages/core/src/adapters/types.ts:455` | +193 |
| `docs/TASK.md` | `registry.ts:582-598@bc30e13` | `packages/core/src/adapters/registry.ts:799-815` | +217 |
| `docs/TASK.md` | `registry.ts:212@bc30e13` | `packages/core/src/adapters/registry.ts:319` | +107 |
| `docs/TASK.md` | `registry.ts:740-742@bc30e13` | `packages/core/src/adapters/registry.ts:1350-1352` | +610 |
| `docs/TASK.md` | `registry.ts:669-682@bc30e13` | `packages/core/src/adapters/registry.ts:886-899` | +217 |
| `docs/TASK.md` | `registry.ts:216-239@bc30e13` | `packages/core/src/adapters/registry.ts:323-346` | +107 |
| `docs/TASK.md` | `registry.ts:789@bc30e13` | `packages/core/src/adapters/registry.ts:1399` | +610 |
| `docs/architectures/open-questions.md` | `adapters/registry.ts:443-455@bc30e13` | `packages/core/src/adapters/registry.ts:646-658` | +203 |
| `docs/architectures/open-questions.md` | `registry.ts:789@bc30e13` | `packages/core/src/adapters/registry.ts:1399` | +610 |
| `docs/architectures/open-questions.md` | `docs/TASK.md:524-526@bc30e13` | `docs/TASK.md:538-540` | +14 |
| `docs/architectures/open-questions.md` | `docs/TASK.md:681-688@bc30e13` | `docs/TASK.md:695-702` | +14 |
| `docs/architectures/open-questions.md` | `adapters/registry.ts:901@bc30e13` | `packages/core/src/adapters/registry.ts:1511` | +610 |
| `docs/architectures/open-questions.md` | `adapters/registry.ts:886-901@bc30e13` | `packages/core/src/adapters/registry.ts:1496-1511` | +610 |
| `docs/architectures/open-questions.md` | `dexscreener/index.ts:125@bc30e13` | `packages/core/src/adapters/dexscreener/index.ts:132` | +7 |
| `docs/architectures/open-questions.md` | `adapters/registry.ts:191-195@bc30e13` | `packages/core/src/adapters/registry.ts:234-238` | +43 |
| `docs/architectures/open-questions.md` | `adapters/types.ts:139@bc30e13` | `packages/core/src/adapters/types.ts:145` | +6 |
| `docs/architectures/open-questions.md` | `mcp-server/src/server.ts:52-55@bc30e13` | `packages/mcp-server/src/server.ts:37-40` | -15 |
| `docs/architectures/reliability.md` | `registry.ts:580@bc30e13` | `packages/core/src/adapters/registry.ts:644` | +64 |
| `docs/architectures/reliability.md` | `registry.ts:929-943@bc30e13` | `packages/core/src/adapters/registry.ts:1539-1553` | +610 |
| `docs/architectures/reliability.md` | `registry.ts:944@bc30e13` | `packages/core/src/adapters/registry.ts:1554` | +610 |
| `docs/architectures/security.md` | `net/safe-fetch.ts:83@bc30e13` | `packages/core/src/net/safe-fetch.ts:251` | +168 |
| `docs/architectures/system-architecture.md` | `registry.ts:191-195@bc30e13` | `packages/core/src/adapters/registry.ts:234-238` | +43 |
| `docs/architectures/system-architecture.md` | `registry.ts:238-254@bc30e13` | `packages/core/src/adapters/registry.ts:345-361` | +107 |
| `docs/architectures/system-architecture.md` | `registry.ts:744@bc30e13` | `packages/core/src/adapters/registry.ts:822` | +78 |
| `docs/architectures/system-architecture.md` | `registry.ts:968@bc30e13` | `packages/core/src/adapters/registry.ts:1439` | +471 |
| `docs/architectures/system-architecture.md` | `registry.ts:453@bc30e13` | `packages/core/src/adapters/registry.ts:656` | +203 |
| `docs/architectures/version-history.md` | `registry.ts:944@bc30e13` | `packages/core/src/adapters/registry.ts:1554` | +610 |
| `docs/architectures/version-history.md` | `adapters/registry.ts:443-455@bc30e13` | `packages/core/src/adapters/registry.ts:646-658` | +203 |

Крупнейший источник дрейфа — `packages/core/src/adapters/registry.ts`: 40 из 53 съехавших
указывают в него. Координаты записывались 2026-08-05…08-06 (анализ и архитектура T-013), а
013-2/013-3/013-4 нарастили файл до 1560 строк — отсюда сдвиги до +610.

## 3. Семь координат, у которых появилась вторая площадка

`013-4` (`e95b909`) добавил **обход слияния** — почти копию одиночного обхода. После этого
`if (Date.now() >= effectiveDeadlineAtMs) {`, `} else if (cached) {` и `attempted.push(adapterId);`
существуют в `registry.ts` по два раза; на момент написания цитат — по одному
(проверено: `git show 77fa89c1` и `ba3f959` дают 1, рабочее дерево даёт 2).

**Правило разбора:** цитата написана до появления обхода слияния, значит она говорит про обход,
который тогда существовал, — одиночный. Он лежит НИЖЕ (комментарий самого кода слияния называет
его «the single-winner walk **below**»). Перенаправить цитату 2026-08-05 на код, написанный
2026-08-07, значило бы приписать автору намерение, которого у него быть не могло.

| Документ | Было | Стало | Референт |
| :--- | :--- | :--- | :--- |
| `docs/TASK.md:158@bc30e13` | `registry.ts:716-724@bc30e13` | `packages/core/src/adapters/registry.ts:1326-1334` | `deadlineHit = true;` |
| `docs/TASK.md:301@bc30e13` | `registry.ts:716-724@bc30e13` | `packages/core/src/adapters/registry.ts:1326-1334` | `deadlineHit = true;` |
| `docs/architectures/reliability.md:143@bc30e13` | `registry.ts:716-724@bc30e13` | `packages/core/src/adapters/registry.ts:1326-1334` | `deadlineHit = true;` |
| `docs/TASK.md:285@bc30e13` | `registry.ts:779-793@bc30e13` | `packages/core/src/adapters/registry.ts:1389-1403` | `if (satisfies(policy, cached.value, adapterId)) return withDiagnostics(hit);` |
| `docs/TASK.md:346@bc30e13` | `registry.ts:779-793@bc30e13` | `packages/core/src/adapters/registry.ts:1389-1403` | то же |
| `docs/TASK.md:324@bc30e13` | `registry.ts:936@bc30e13` | `packages/core/src/adapters/registry.ts:1407` | `attempted.push(adapterId);` |
| `docs/TASK.md:574@bc30e13` | `registry.ts:936@bc30e13` | `packages/core/src/adapters/registry.ts:1407` | то же |

Оба девяти- и пятнадцатистрочных блока найдены в дереве **дословно и единственный раз**
(716-724 → 1326, 779-793 → 1389), поэтому перенос диапазона механический, а не подогнанный.

**Оговорка, которую этот аудит не закрывает.** `attempted.push(adapterId);` теперь не уникален:
референт проходит гейт (он внутри процитированной координаты), но при следующем сдвиге даст
`REFERENT_AMBIGUOUS`, а не авто-починку. Это верное поведение для действительно задвоенной строки.

## 4. Четыре координаты, чей текст переписан

Все четыре цитировали докстринг `capability-manifest.ts`, который `013-1` переписал: абзац
объявлял обязательство T-013 как будущее, а теперь фиксирует, что оно **исполнено**.

| Документ | Было | Стало |
| :--- | :--- | :--- |
| `docs/TASK.md:23@bc30e13` | `capability-manifest.ts:152-163@bc30e13` | `packages/core/src/capability-manifest.ts:146-153` |
| `docs/architectures/data-model.md:229@bc30e13` | `capability-manifest.ts:152-163@bc30e13` | `packages/core/src/capability-manifest.ts:146-153` |
| `docs/architectures/system-architecture.md:759@bc30e13` | `capability-manifest.ts:152-163@bc30e13` | `packages/core/src/capability-manifest.ts:146-153` |
| `docs/TASK.md:222@bc30e13` | `capability-manifest.ts:147@bc30e13` | `packages/core/src/capability-manifest.ts:158` |

Референт первых трёх выбран намеренно говорящим —
`the obligation the paragraphs below used to describe as future is discharged.` — чтобы читатель
документа видел расхождение сразу: **проза всё ещё называет обязательство унаследованным, а код
уже сообщает, что оно исполнено.** Координата исправлена; предложение НЕ переписано — это
семантика, а её §5 записи явно оставляет за пределами механизма.

## 5. Пять без опорной строки

`open-questions.md` (строка 107), `reliability.md` (82 и 96), `system-architecture.md` (556 и 2591) — в процитированном диапазоне нет
строки длиннее служебной (`*/`, `) {`). Номер не тронут, референт не выдуман: такая ссылка
остаётся «не исследована», что честнее подставного якоря.

## 6. Гейт, который всё это ловит впредь

Проверено прогоном, а не заявлено: пять строк вставлены в `registry.ts`, `docs/` не тронут.

- `check_positional_refs.py --targets-changed` → **exit 1** (source-only коммит краснеет —
  именно тот случай, который диффом по изменённым документам не ловится).
- `--targets-changed --fix` → **13 ссылок живого корпуса починены механически**.
- Обе правки откачены, корпус восстановлен.
