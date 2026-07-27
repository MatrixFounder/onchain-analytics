---
id: WI-6
type: work-item
status: open
opened_at: 2026-07-24
slug: wi-6-orchestrator-applied-fixes-need-their-own-review-pass
---

# Orchestrator-applied fixes need their own review pass

Adversarial cycles 2 and 3 found defects introduced **by the previous cycle's fixes** — and both were applied by the orchestrator directly, outside the developer→code-reviewer loop: - **zod `.max()` caps enforced only at `Schema.parse`.** The cap was correct (bounding attacker-authored vendor text reaching the model), but a parse throw happens _after_ the paid call, with nothing cached — so the agent's retry paid again. It converted "an attacker can write a long token name" into "an attacker can drain credits", strictly worse than the original problem. Correct mechanism: truncate in the mapper, keep the schema cap as an unreachable backstop. - **Key redaction written truncate-then-redact.** `stringifyTruncated(body).split(key)` slices to 500 chars first, so a key straddling the boundary left an unredacted prefix — and whoever influences the body length picks where the boundary falls. **Lesson to encode:** a fix applied outside the dev→review loop still needs its own review pass. The multi-cycle adversarial structure is what caught both, so the 3-cycle cap is load-bearing rather than ceremony. Consider an explicit rule in `vdd-enhanced.md`: orchestrator-applied fixes are re-reviewed in the next cycle and named as such in the brief (which is what happened here, and is why they were caught).
