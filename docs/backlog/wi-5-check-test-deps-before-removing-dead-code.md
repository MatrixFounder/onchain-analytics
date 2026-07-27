---
id: WI-5
type: work-item
status: done
opened_at: 2026-07-24
slug: wi-5-check-test-deps-before-removing-dead-code
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development), переписано владельцем — 2026-07-28
---

# Check test dependencies before acting on a 'remove dead code' finding

> **DONE 2026-07-28 — принято, но переписано владельцем; моя редакция была опасна.**
> Живёт как `code-review-checklist` §2, пунктом чеклиста «Dead Code: before proposing a deletion —
> symbol grepped repo-wide?» плюс развёрнутый callout; §6 «Law of Minimalism» на него ссылается.
>
> **Греп по `test/` заменён на греп по всему репозиторию.** Моя формулировка была снята с раскладки
> этого проекта, где тесты лежат в `test/`. В Go тесты лежат рядом с исходником, в Rust — внутри того
> же файла, в Solidity — `test/*.t.sol`. Греп с ограничением по каталогу вернул бы пусто именно там,
> где раскладка другая, и **санкционировал бы удаление живой фикстуры** — то есть инструкция не
> просто не сработала бы, а дала бы неверный результат с видом проверенного.

Cycle-2 finding L-2 recommended deleting an unreachable `premium_labels` 150cr pricing branch in `cost-of.ts` (the transport never sent the flag, so price and request could drift). Implementing "delete it" broke the **R-37-mandated 150-vs-100 refusal test** — the test that closes ROADMAP §M2 exit criterion #2 ("budget-guard реально режет при достижении лимита (тест)"). The supposedly dead code was load-bearing as the fixture for a _required_ behaviour. The correct resolution was the critic's other stated option: make the transport forward the flag so price and request genuinely agree, preserving the acceptance test. **Guidance worth recording:** before acting on a "remove dead/unreachable code" finding, check whether a test depends on it — particularly an acceptance test tied to a milestone exit criterion. A grep for the symbol across `test/` is enough.
