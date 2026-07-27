---
id: WI-1
type: work-item
status: done
opened_at: 2026-07-22
slug: wi-1-formatter-gate-blast-radius-guard
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development), переписано владельцем — 2026-07-28
---

# Formatter-gate broadening needs a blast-radius guard

> **DONE 2026-07-28 — принято, но переписано владельцем, и правка сняла противоречие.**
> Живёт как `developer-guidelines` §5.1 **Blast Radius — Any Bulk-Rewrite Command**.
>
> **Обобщено со стека, где произошло.** Моя редакция была написана про `prettier`/`eslint`, а скилл
> грузится в каждой задаче на любом языке. Теперь правило про любую команду массовой перезаписи
> (форматтеры, автофиксящие линтеры, кодмоды, `sed -i`, массовый rename) с таблицей отчётных и
> пишущих форм по экосистемам — Python, JS/TS, Go, Rust, Solidity, — отдельной ловушкой `gofmt`
> (`./...` не работает; `go fmt ./...` — это `-l -w`, то есть уже запись) и веткой «отчётной формы
> нет» (чистое дерево + `git diff --stat` сразу после).
>
> **Снято противоречие, которое я внёс.** У меня шагом 3 стояло «расширь repo-wide ignore-правила» —
> обязательное действие, прямо запрещённое §1 того же скилла (правки вне задачи). Теперь это
> **находка для эскалации**: предложи, решает пользователь. А первым шагом добавлено то, чего у меня
> не было вовсе и что снимает вопрос в большинстве случаев: сузить аргумент-путь до файлов своей
> задачи, вместо `.`.

During the M0 adversarial fix round, a repo-wide `prettier --write .` reformatted 34 unrelated curated/generated files (SoT docs, n8n exports, reference dialogs); the orchestrator reverted and scoped .prettierignore after the fact. Process guard to adopt: any directive that broadens a formatter/linter gate must run the CHECK first, review the file list, extend ignore rules for curated/generated content, and only then write.
