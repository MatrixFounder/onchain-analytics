---
id: WI-5
type: work-item
status: open
opened_at: 2026-07-24
slug: wi-5-check-test-deps-before-removing-dead-code
---

# Check test dependencies before acting on a 'remove dead code' finding

Cycle-2 finding L-2 recommended deleting an unreachable `premium_labels` 150cr pricing branch in `cost-of.ts` (the transport never sent the flag, so price and request could drift). Implementing "delete it" broke the **R-37-mandated 150-vs-100 refusal test** — the test that closes ROADMAP §M2 exit criterion #2 ("budget-guard реально режет при достижении лимита (тест)"). The supposedly dead code was load-bearing as the fixture for a _required_ behaviour. The correct resolution was the critic's other stated option: make the transport forward the flag so price and request genuinely agree, preserving the acceptance test. **Guidance worth recording:** before acting on a "remove dead/unreachable code" finding, check whether a test depends on it — particularly an acceptance test tied to a milestone exit criterion. A grep for the symbol across `test/` is enough.
