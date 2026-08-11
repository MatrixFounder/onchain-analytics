---
id: RF-7
type: defect
severity: SEV-3
status: fixed
opened_at: 2026-08-06
resolved_at: 2026-08-11
resolved_by: 'agentic-development TASK 105 (v3.29.0), options 1+3'
slug: rf-7-mutation-protocol-and-read-only-roast-run-concurrently-so-the-reviewer-measures-a-tree-that-never-shipped
component: 'agentic-development: vdd-enhanced.md §4, skill-parallel-orchestration §2.4'
source: 'vdd-03-develop Roast, задача 013-3 (T-013)'
provenance: machine
---

# RF-7 — мутационный протокол и read-only роаст идут по одному рабочему дереву одновременно, и ревьюер меряет состояние, которого не было и не будет

> Origin: роаст задачи 013-3 (T-013), 2026-08-06. Наблюдение принадлежит `code-reviewer`,
> причина установлена оркестратором (это была его собственная мутация).

**Что произошло.** `vdd-enhanced` предписывает две вещи, обе обязательные:

1. **роаст** — read-only агенты (`critic-*`, `code-reviewer`) читают рабочее дерево;
2. **мутационный протокол** — доказательство силы тестов ломает исходник, гоняет сьют,
   откатывает.

Порядок между ними нигде не задан. В 013-3 оркестратор гонял мутации, пока `code-reviewer`
читал то же дерево. Ревьюер поймал прогон

```
FAIL test/tools/resolve-capability-merge.test.ts > TC-UNIT-01
AssertionError: expected undefined to strictly equal [ { adapterId: 'adapter-c', …(1) } ]
 Test Files  1 failed | 36 passed (37)
      Tests  1 failed | 336 passed (337)
```

и `git diff --stat`, показавший `35 ++++` там, где 90 секундами раньше было `38 +`. Объяснить это
он не мог и завёл находку HIGH о **недоверии к цепочке измерений**: «отчёт разработчика датирован
раньше последней записи в файл, о котором он отчитывается». Вывод был правильный, причина —
не та, которую он мог увидеть: это была мутация MUT-A оркестратора (удалённый проброс
`missingSources`), а не нестабильность работы разработчика и не флейки.

**Почему это дефект процесса, а не оплошность.** Ревьюер отработал как надо: заметил расхождение,
не списал на флейк, потребовал перепрогона на замороженном дереве. Стоимость легла на другое —
он потратил семь дополнительных полных прогонов сьюта на проверку детерминизма и целую находку
HIGH на артефакт, а оркестратор потратил раунд на объяснение вместо разбора. Хуже другое: не
поймай он расхождение, он **сдал бы вердикт о дереве, которого никогда не было** — в окне мутации
у 013-3 не было проброса `missingSources`.

**Обобщение, не зависящее от стека.** Роль, читающая рабочее дерево, предполагает дерево
неподвижным; роль, доказывающая силу тестов, обязана дерево двигать. Это несовместимые
предпосылки об **одном общем ресурсе**, и совместимыми их делает только порядок или изоляция —
ни того ни другого контракт не называет. Тот же класс шире одного фреймворка: любой read-only
рецензент (линтер по снимку, аудит, снятие метрик) ломается о параллельную правку того же дерева.

**Смежное и уже принятое.** `skill-parallel-orchestration` §2.4 уже говорит, что доказательства
исполнения для безбашевого агента собирает **спавнер**. Это ровно та обязанность, из-за которой
оркестратор и гонял мутации в тот момент: критик пометил их `NOT RUN (no Bash)`, и настрелять их
надо было ему. То есть §2.4 **порождает** конфликт, ничего не говоря о его сериализации.

**Options.**

| # | Option | Cost | Trade-off |
| --- | --- | --- | --- |
| 1 | Правило порядка: мутации спавнер гоняет **после** возврата всех read-only агентов раунда; во время роаста дерево заморожено | XS | Дёшево, ничего не ломает; удлиняет раунд на время самого долгого критика |
| 2 | Изоляция: мутации в отдельном worktree/копии | S | Снимает связь совсем и разрешает параллельность; в этом репозитории `pnpm build` пишет в `dist`, так что копия должна быть полной |
| 3 | Дерево не морозить, но приложить к брифу критика отпечаток (`git diff` hash) и обязать сверять его на входе и выходе | S | Не предотвращает, а делает наблюдаемым; ревьюер 013-3 фактически изобрёл это сам (запиннил hash) |
| 4 | ничего не делать | — | Каждый роаст с мутациями может отдать вердикт о несуществующем дереве, и распознать это можно только по случайно пойманному расхождению |

**Recommendation.** Вариант 1 как правило и вариант 3 как страховка: порядок дешевле изоляции, а
отпечаток в брифе ловит нарушение порядка, если его нарушат. Вариант 2 стоит рассмотреть, если
роасты станут долгими настолько, что сериализация начнёт заметно стоить.

**Acceptance.** Брифинг read-only агента содержит отпечаток дерева; спавнер не правит исходники
между спавном и возвратом последнего агента раунда; нарушение видно из сверки отпечатка на
возврате. Проверяется прогоном роаста с намеренной правкой в середине — сверка обязана назвать её.

**Related.** [WI-6](../backlog/wi-6-orchestrator-applied-fixes-need-their-own-review-pass.md) —
тоже про то, что действия оркестратора не проходят ревью, но там предмет — **правки**, здесь —
**временные мутации**, которые как раз откатываются и потому в диффе не видны вовсе.

---

> **Resolved 2026-08-11 — `agentic-development` TASK 105, released as v3.29.0.**
> Operator selected **option 1** (ordering) and **option 3** (fingerprint). Both landed in
> `skill-parallel-orchestration` **§2.4.1**, the new subsection of the contract this record names as
> the site, and in 29 further places that read it.
>
> - **Freeze (option 1).** Orchestrator half, item 4: between the spawn of a round and the return of
>   its last role, the caller writes nothing to the artifacts under review. Evidence mutations,
>   applied fixes and reformats run before the spawn or after the last return.
> - **Fingerprint (option 3).** Orchestrator half, item 5: a value over the artifacts under review,
>   computed before the spawn, carried in the evidence block, recomputed at the round's return. The
>   `git` form is
>   `{ git rev-parse HEAD; git status --porcelain; git diff HEAD; } | shasum -a 256 | cut -c1-12`.
>   A mismatch invalidates the round rather than annotating it.
> - **One deviation from option 3 as filed, and why.** The record asks the critic to verify the
>   fingerprint on entry and exit. A critic's `tools:` line carries no Bash, so it can compute
>   nothing — handing it the hash command is the defect §2.4 already forbids, measured at a
>   600-second turn. The obligation is split instead: the **role quotes** the value it was given,
>   the **caller compares** before and after. The comparison is then anchored to what the role
>   actually saw.
> - **Acceptance.** `tests/test_frozen_tree_contract.py` (7 tests) pins the fingerprint line at all
>   9 caller-side briefs, the quote instruction at all 20 role definitions, and enumerates the
>   contract's carriers from disk so a site authored later fails rather than going uncovered. The
>   record's "deliberate mid-round edit must be named" is the executed mutation: removing the line
>   from one brief, handing `shasum` to `critic-security`, and adding an undeclared workflow each
>   turn a different assertion red.
> - **Option 2 (isolation in a worktree) was not built** — this record proposes it only if
>   serialization becomes expensive, and that cost is not yet measured.
