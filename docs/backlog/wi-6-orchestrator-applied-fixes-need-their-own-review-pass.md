---
id: WI-6
type: work-item
status: done
opened_at: 2026-07-24
slug: wi-6-orchestrator-applied-fixes-need-their-own-review-pass
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development), частично — 2026-07-28
---

# Orchestrator-applied fixes need their own review pass

> **DONE 2026-07-28 — основная часть принята, один тезис откачен.**
>
> **Принято** в `vdd-enhanced.md` §4: (4) фикс, применённый оркестратором в обход цикла
> Developer→Reviewer, переносится в бриф следующего цикла и называется там неотревьюенным; (5) если
> лимит циклов достигнут, а такой фикс так и не отревьюен, вердикт становится **WARNING, никогда не
> PASS**, и неотревьюенное изменение называется в отчёте пользователю. Пункт (5) — усиление
> относительно предложенного мной «отчёт должен об этом сказать»: словами можно пренебречь, вердиктом
> нет.
>
> **Откачен** тезис «независимые критики категорически лучше самокритики». Три причины, все
> справедливые: он шёл без ссылки на прогон; он деприкейтил `vdd-multi` — тот самый workflow, который
> вызывается в этом же файле; и он противоречил единственному записанному эксперименту, где базовая
> линия выигрывает по recall, а параллельный вариант стоит примерно втрое. Я обобщил одно
> наблюдение TASK-007 до правила и подал его как измеренный факт — это была не измеренная величина,
> а впечатление от одного прогона.

Adversarial cycles 2 and 3 found defects introduced **by the previous cycle's fixes** — and both were applied by the orchestrator directly, outside the developer→code-reviewer loop: - **zod `.max()` caps enforced only at `Schema.parse`.** The cap was correct (bounding attacker-authored vendor text reaching the model), but a parse throw happens _after_ the paid call, with nothing cached — so the agent's retry paid again. It converted "an attacker can write a long token name" into "an attacker can drain credits", strictly worse than the original problem. Correct mechanism: truncate in the mapper, keep the schema cap as an unreachable backstop. - **Key redaction written truncate-then-redact.** `stringifyTruncated(body).split(key)` slices to 500 chars first, so a key straddling the boundary left an unredacted prefix — and whoever influences the body length picks where the boundary falls. **Lesson to encode:** a fix applied outside the dev→review loop still needs its own review pass. The multi-cycle adversarial structure is what caught both, so the 3-cycle cap is load-bearing rather than ceremony. Consider an explicit rule in `vdd-enhanced.md`: orchestrator-applied fixes are re-reviewed in the next cycle and named as such in the brief (which is what happened here, and is why they were caught).
