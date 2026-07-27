---
id: WI-9
type: work-item
status: done
opened_at: 2026-07-26
slug: wi-9-one-commit-per-task-vs-overlapping-files
effort: S
value: 'M'
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development)
---

# PLAN §0.5 «один коммит на задачу» не оговаривает задачи с пересекающимися файлами

> **DONE 2026-07-28.** `skill-planning-format` gains §4.1 _Commit Granularity — Decide It in the
> Plan, Not at Commit Time_: the convention holds only for file-independent tasks, and for any file
> touched by more than one task the **planner** must choose in writing between (a) declaring the
> group as one commit and (b) separating the files so the overlap disappears. Both "do not" clauses
> survived intact — do not split coupled tasks just to satisfy the form, and do not drop the
> convention.

Конвенция взята из плана TASK-006 и в общем случае верна, но на этой задаче оказалась неисполнимой постфактум. Задачи 006-1…006-10 правят один и тот же `packages/core/src/chain/registry.data.json`: 006-1 создаёт стаб на 3 сети, 006-2 генерирует боевые 458, 006-8 курирует `rpcHosts`, 006-9 заполняет `vendors.nansen`. То же и с `registry.ts` (006-1 создаёт, 006-2 разделяет на `registry-core.ts` + обёртку). Разложить это на десять коммитов постфактум можно только механически — и тогда каждый промежуточный коммит не проходит тесты, то есть история перестаёт быть бисектируемой, что и есть главная ценность гранулярных коммитов. Пришлось сделать один связный коммит и назвать отклонение в его теле. **Что стоит поменять:** оговорка в `skill-planning-format` (и/или в шаблоне PLAN §0.5) — конвенция «коммит на задачу» применима, когда задачи **файлово независимы**. Иначе у планировщика два честных варианта, и он должен выбрать один ЗАРАНЕЕ, а не разработчик постфактум: (а) объявить группу задач одним коммитом прямо в плане (например «006-1…006-2 — один коммит: общий артефакт данных»), либо (б) развести файлы между задачами так, чтобы пересечения не было (например, генератор пишет в отдельный файл, который подключается одной строкой). Побочная польза варианта (б) — он вынуждает заметить связность на этапе планирования, а не на этапе коммита. **Не делать:** не разбивать такие задачи на коммиты ради формального соблюдения — красная история хуже одного большого честного коммита; и не убирать конвенцию целиком — на файлово независимых задачах она работает и уже окупилась в M1/M2.
