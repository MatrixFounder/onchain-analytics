---
id: WI-7
type: work-item
status: done
opened_at: 2026-07-24
slug: wi-7-subagent-stall-resilience
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development), уточнено владельцем — 2026-07-28
---

# Subagent stall resilience: incremental-write + resume guidance for long agent tasks

> **DONE 2026-07-28 — принято, с уточнением от владельца.**
> `08_developer_prompt` Step 2b (писать группами, узкий тест после каждой, не исследовать до
> изнеможения перед первой записью); `04_architect_prompt` перед Step 3 (роль с самой широкой
> поверхностью чтения — здесь назван прогон на 263k токенов, оборвавшийся ровно перед первой
> записью); `01_orchestrator` §7 случай 15 (обрыв субагента — **возобновлять, а не порождать
> заново**).
>
> **Уточнение:** «сначала самое ценное» упорядочивает работу **внутри назначенной фазы** и никогда не
> переставляет сами фазы Stub-First. Без этой оговорки приоритизацию можно было прочитать как
> разрешение начать с реализации в обход стабов. К архитектору добавлено симметричное ограничение:
> `ARCHITECTURE.md` — живой документ, который читает ревьюер, поэтому посекционная запись идёт в
> порядке, предписанном `architecture-format-*`, а решения, пришедшие не в том порядке, черновиком
> в отдельный файл.

Five subagent runs in the M2 pipeline died with `Response stalled mid-stream` or the 600s watchdog. The worst case (the architect) burned **263k tokens** researching and stalled immediately _before_ its first write — saving nothing at all. **What worked, and is worth making standing guidance rather than rediscovering per run:** 1. **Resume via `SendMessage`, not a fresh spawn.** The agent's research context survives, so the retry costs a fraction of the original. 2. **Instruct incremental writing explicitly**: "one Edit per tool call, never batch; after each group run its narrow test, then continue." A stall then costs one file, not the session. 3. **Give a priority order** so a partial run still lands the highest-value work ("if you only finish one thing, finish X"). Proposed: fold points 2–3 into `System/Agents/04_architect_prompt.md` and `08_developer_prompt.md` as a standing "long-task resilience" section, and point 1 into the orchestrator's failure-handling guidance.
