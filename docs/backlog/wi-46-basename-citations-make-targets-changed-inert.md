---
id: WI-46
type: work-item
status: open
opened_at: 2026-08-07
slug: wi-46-basename-citations-make-targets-changed-inert
effort: M
value: 'Самый ценный режим механизма WI-43 (`--targets-changed`) на нашем стиле цитирования не выбирает НИ ОДНОГО документа; замерено — одна repo-relative ссылка включает его и сразу даёт 9 ошибок'
source: 'проверка WI-43/WI-45 после переноса, 2026-08-07'
provenance: machine
component: 'docs/**, packages/*/.AGENTS.md'
---

# WI-46 — цитирование basename'ом делает `--targets-changed` инертным, а `.AGENTS.md` вне области миграции

> Остаток [WI-43](wi-43-line-anchored-citations-in-docs-decay-silently.md) (механизм) и
> [WI-45](wi-45-living-corpus-carries-no-referents.md) (корпус). Обе закрыты правильно —
> предмет этой записи механизм закрыть не может, потому что это свойство **нашего корпуса**,
> а не резолвера.

**Signal.** `check_positional_refs.py` несёт режим `--targets-changed` — «documents citing a
file the current change touched … the scope that catches a source-only commit shifting lines
under a document nobody opened». Это ровно тот отказ, который за прогон T-013 воспроизвёлся
четырежды. На нашем корпусе режим не выбирает ничего.

Замер (рабочее дерево, `packages/core/src/adapters/registry.ts` изменён на +471):

```
$ check_positional_refs.py --targets-changed
NOTHING CHECKED: no Markdown document is in scope. Nothing was verified.
```

Одна ссылка в `docs/tasks/task-013-2-route-activation-and-rank.md` переписана
`registry.ts:690` → `packages/core/src/adapters/registry.ts:690`, тот же режим:

```
9 error(s), 1 warning(s) across 34 reference(s) in 2 document(s)
```

**Причина.** `registry.ts` матчит в этом репозитории **три** файла — `packages/core/src/adapters/`,
`packages/core/src/chain/`, `packages/mcp-server/src/tools/` — поэтому ссылка получает
`AMBIGUOUS`, и резолвер не может установить, что документ ссылается на изменённый файл. То же с
`index.ts` (15 файлов) и `.AGENTS.md` (3 файла).

**Охват на 2026-08-07** (`--all docs/architectures docs/tasks`, 81 документ): 348 ссылок,
**34 ошибки**; из 260 `path:line` — 64 с референтом (проверены), 165 без референта (не
исследованы), 31 неразрешима. По всему `docs` (199 документов, 1541 ссылка): 199 ошибок —
112 `AMBIGUOUS`, 53 `UNRESOLVABLE`, 18 `OUT_OF_RANGE`, 9 `REFERENT_ABSENT`, 3 `REFERENT_MOVED`.

**Вторая половина: `packages/*/.AGENTS.md` вне области.** Миграция WI-45 шла по `docs/`, и
exhaustive-режим по умолчанию тоже (`--all docs`). Между тем `.AGENTS.md` — **единственный
долговременный отчётный документ проекта** (`docs/reports/` здесь нет, это записано в самих
журналах). Diff-режимы его видят: тот же прогон нашёл в `packages/core/.AGENTS.md` восемь
`AMBIGUOUS` — `registry.ts:944`, `:210`, `:384`, `:638`, `:253`, `:330` — то есть **ровно те
устаревшие координаты, которые были исправлены в `docs/` и не исправлены в журнале**. Плюс
`ORDINAL_MISSING`: `packages/core/.AGENTS.md:4028` ссылается на `docs/PLAN.md §0.5`, которого в
PLAN нет.

**Why it matters.** Механизм есть, гейт есть, а самый ценный его режим на нашем корпусе
сообщает `NOTHING CHECKED` — и это неотличимо от «всё чисто». Тот же класс, что RF-6
(гейт читал 39 % документа и рапортовал успех) и WI-38 (утверждение о состоянии, которого не
читает ни один гейт).

**Options.**

| # | Option | Cost | Trade-off |
| --- | --- | --- | --- |
| 1 | Правило авторинга: `path:line` только repo-relative; чинить корпус по мере касания | S | Дёшево, но остаток живёт долго и `--targets-changed` включается постепенно |
| 2 | Разовая миграция ~110 shorthand-координат в `docs/` + 8 в `.AGENTS.md` | M | Включает режим целиком; делать ПОСЛЕ T-013, иначе числа поедут ещё раз |
| 3 | Расширить область exhaustive-прогона: `--all docs packages/*/.AGENTS.md` в гейте | S | Закрывает вторую половину; без варианта 1/2 просто покажет больше `AMBIGUOUS` |
| 4 | Просить резолвер разрешать shorthand по уникальному суффиксу | M | Правка вверх по течению; не поможет там, где суффикс действительно неоднозначен (`index.ts`) |

**Recommendation.** 1 + 3 сразу (правило и область — обе дешёвые и не зависят от T-013),
2 — после закрытия T-013 одним проходом, когда `registry.ts` перестанет двигаться.
Вариант 4 не рекомендуется: `index.ts` с 15 кандидатами показывает, что суффикс не спасает,
а «почти уникально» — неверная планка для гейта.

**Acceptance.** На дереве, где изменён только исходник, `--targets-changed` выбирает документы,
которые на него ссылаются, и `NOTHING CHECKED` означает отсутствие таких документов, а не
неразрешимость ссылок. Проверяется правкой одной строки в `registry.ts` и прогоном.

**Related.** [WI-43](wi-43-line-anchored-citations-in-docs-decay-silently.md) — механизм, закрыт.
[WI-45](wi-45-living-corpus-carries-no-referents.md) — миграция корпуса `docs/`, закрыта.
[WI-44](wi-44-typecheck-reads-stale-core-dist-so-cross-package-type-breakage-is-invisible.md) —
тоже гейт, дающий ложный зелёный, но там предмет — типы, здесь — координаты.
