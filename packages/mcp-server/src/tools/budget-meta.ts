import { adapterRegistrations, dayBucketMs, type BudgetStore } from '@onchain-intel/core';

/**
 * The paid adapter whose ledger this reading must come from, or `undefined` when the traversal can
 * have spent nothing (adversarial cycle 2, F-4; narrowed to ENTERED-only in cycle 3, F-A).
 *
 * **Visibility follows the TRAVERSAL, and only the traversal.** `entered` is
 * `CapabilityResolution.attempted` — the adapters whose `fetch()` the walk actually entered, which
 * is the complete set of sources that can have spent anything. On `entity.labels` it differs from
 * "who answered" in the ordinary case: `blockscout` answers truthfully-but-unsatisfyingly, the walk
 * enters `nansen`, `nansen` SPENDS, its answer is unsatisfying too, and the registry returns
 * blockscout's (`registry.ts`'s `unsatisfying ??=`). Deriving `_meta.budget` from the answering id
 * reported NO spend for that call — a false negative in the expensive direction, since an agent that
 * believes a call was free repeats it (R-41). The engine's own delivery test asserts that exact
 * state: `core/test/entity-labels-deadline-arithmetic.test.ts` TC-INT-02 has `source === 'blockscout'`
 * and `getUsage('nansen', BUCKET) === 5` in one run.
 *
 * **The answering id is not consulted at all, and that is the cycle-3 fix.** Cycle 2 read it FIRST
 * (`if (isPaidProvider(answeringId)) return answeringId`) and left the callers gating on
 * `cache.status === 'miss'`, which reopened the same false negative one branch over: the H-1 return
 * can hand back a CACHE HIT (`registry.ts`'s `unsatisfying` may be the `cache: 'hit'` object built
 * for an earlier adapter) after the walk entered and paid `nansen`, and the `'miss'` gate then
 * dropped `_meta.budget` on precisely the route F-4 was written for. Asking only "who was entered"
 * makes the rule one sentence with no cache-status term in it: **a source that was never entered
 * cannot have spent, and a source that was entered can have** — `attempted` is appended at the CALL,
 * not at its outcome, exactly so a `fetch()` that throws after committing a reservation still counts.
 *
 * A pure cache hit therefore reports nothing, as before: it entered nobody, `entered` is empty. That
 * the answering adapter of a `'miss'` is always itself in `entered` is the invariant this
 * simplification rests on, and it is asserted rather than assumed — see
 * `test/tools/budget-meta.test.ts` TC-F-A-INV.
 *
 * **Why the LAST paid entry when there are several.** The wire shape is one `{provider,
 * creditsUsedToday}` (R-41), so several would have to be collapsed anyway, and the most recently
 * entered source is the one whose ledger this response is closest in time to. **Measured, 2026-08-05:
 * the choice is unobservable today** — `providers.config.ts` registers exactly two `tier: 'paid'`
 * adapters (`nansen`, `dune`), and `dune` appears in no route at all, so no traversal can enter two.
 * The day a second paid adapter is routed behind the first, this reports one of the two ledgers and
 * the shape has to grow; that is a decision for whoever routes it, not a defect to pre-solve here.
 */
function paidProviderToReport(entered: readonly string[]): string | undefined {
  for (let i = entered.length - 1; i >= 0; i -= 1) {
    const id = entered[i];
    if (id !== undefined && isPaidProvider(id)) return id;
  }
  return undefined;
}

/**
 * `_meta.budget` shape (interfaces.md §5.1.2, R-41 "аналог `_meta.cache`").
 *
 * **`provider` is a `string`, not a union of the paid adapter ids (ADR-002 D8, task 012-3).** It
 * used to be the literal type `'nansen'` — one of the four competing classifications of paidness
 * D8 exists to collapse into `AdapterRegistration.tier`. The replacement is deliberately NOT a
 * narrower union derived from the registrations: `adapterRegistrations` is exported as a mutable
 * `AdapterRegistration[]`, so TypeScript widens every `id` to `string`, and inferring a literal
 * union would mean retyping that array (`as const satisfies …`) along with
 * `SqliteBudgetStoreOptions.providers`, its `SqliteCacheStore` sibling and every generic consumer
 * — a radius this task does not take (data-model.md M6). More to the point, D8 calls the literal
 * TYPE itself the defect ("the classification leaked into the type system"), so a derived-but-still
 * -literal union would move the leak rather than close it. The precision comes back at runtime,
 * below, at the boundary where the value first becomes known.
 *
 * The WIRE shape is unchanged: `{provider, creditsUsedToday}` serialises exactly as before
 * (`e2e.inprocess.test.ts` `:738`/`:770`/`:796`/`:817` pin it by value and were not touched).
 */
export interface BudgetMeta {
  /**
   * Id of the PAID adapter this credit reading belongs to — never a hardcoded vendor name.
   *
   * Cycle 2, F-4 corrected what "this" means: it used to be "the adapter that answered", which named
   * nobody on the one route where a paid source is entered and a free source's answer is returned.
   * It is now the paid adapter the traversal actually ENTERED, and ONLY that — cycle 3, F-A removed
   * the residual answered-first branch (see `paidProviderToReport`).
   */
  provider: string;
  creditsUsedToday: number;
}

/**
 * `true` when `providerId` names an adapter registered as `tier: 'paid'` (ADR-002 D8).
 *
 * Reads the registrations directly on every call rather than caching a set of ids at module load:
 * the cached set would be a second classification with its own lifetime, which is the exact shape
 * task 012-3 removes from `cache/sqlite-store.ts`. Twelve entries, scanned once per ENTERED adapter
 * — at most 2 on any route `providers.config.ts` defines today, and only on a call that already made
 * a network request, so the cost is not measurable next to the request that preceded it. A pure
 * cache hit enters nobody and does not reach this function at all.
 */
export function isPaidProvider(providerId: string): boolean {
  return adapterRegistrations.some((r) => r.id === providerId && r.tier === 'paid');
}

/**
 * Reads the current day-bucket's `usage.credits_used` for the paid provider this traversal ENTERED
 * (task 005-6, R-41; a provider argument added by task 012-3, the traversal record by adversarial
 * cycle 2's F-4, answered-vs-entered resolved in cycle 3's F-A) — shared by all 3 M2 tool handlers
 * (`smart-money-flows.ts`/`entity-label.ts`/`token-risk.ts`), mirroring `resolve-capability.ts`'s own
 * shared-helper precedent for the 4 M1 tools.
 *
 * **`entered` is a parameter because the alternative could not be checked.** Until 012-3 this
 * function took no provider and hardcoded `getUsage('nansen')`, so "the reported provider is a paid
 * one" was a claim about a constant: true under every implementation, unfalsifiable by any test
 * (PLAN §0.3, seam #2). Passing the traversal record makes the check real, and — unlike the answering
 * adapter's id that 012-3 passed — it is the set the question is actually about.
 *
 * **There is no cache-status parameter, and no caller gate.** Cycle 2 documented the rule as "call
 * this only on a `'miss'`", which made cache status a second, independently-maintained classification
 * of the same fact; cycle 3's F-A found it disagreeing with the first on the H-1 cache-hit return, in
 * the expensive direction. Cache status is now derived from nothing and consulted nowhere: an empty
 * `entered` already means "no source was entered", which is what a pure hit IS.
 *
 * Three degradation paths, ALL resolving to `undefined` rather than throwing — visibility must
 * never turn an otherwise-successful tool call into an error (mirrors `CapabilityRegistry`'s own
 * cache-fault contract in `@onchain-intel/core`'s `adapters/registry.ts` — NOT the sibling
 * `./registry.ts`, which TASK-011 added to this very directory and which holds `defineTool`):
 * - `budgetStore` was never injected into the tool's context (reviewer note: "`budgetStore`
 *   отсутствует (не инжектирован) → tool работает, просто без `_meta.budget`");
 * - no adapter the walk entered is a paid one — including the case where it entered nobody at all,
 *   which is every pure cache hit — so nothing can have been spent and there is no budget to report.
 *   Returned BEFORE the store is touched: asking for a usage row that cannot exist and discarding the
 *   answer would look identical from the outside while still being a read;
 * - `budgetStore.getUsage()` itself throws (a faulty/misbehaving store, same best-effort spirit as
 *   core's `adapters/registry.ts` `cache.get()` fault handling).
 */
export async function budgetMeta(
  budgetStore: BudgetStore | undefined,
  now: () => number,
  entered: readonly string[] = [],
): Promise<BudgetMeta | undefined> {
  if (!budgetStore) return undefined;
  const provider = paidProviderToReport(entered);
  if (provider === undefined) return undefined;
  try {
    const creditsUsedToday = await budgetStore.getUsage(provider, dayBucketMs(now()));
    return { provider, creditsUsedToday };
  } catch {
    return undefined;
  }
}
