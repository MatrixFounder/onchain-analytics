import { dayBucketMs, type BudgetStore } from '@onchain-intel/core';

/**
 * `_meta.budget` shape (interfaces.md §5.1.2, R-41 "аналог `_meta.cache`"). `provider` is narrowed
 * to the literal `'nansen'` (not a generic `string`) — M2 has exactly one paid provider; widening
 * this to `string` would be speculative (developer-guidelines §1.6 "no unused config options").
 */
export interface BudgetMeta {
  provider: 'nansen';
  creditsUsedToday: number;
}

/**
 * Reads the current day-bucket's `usage.credits_used` for `nansen` (task 005-6, R-41) — shared by
 * all 3 M2 tool handlers (`smart-money-flows.ts`/`entity-label.ts`/`token-risk.ts`), mirrors
 * `resolve-capability.ts`'s own shared-helper precedent for the 4 M1 tools.
 *
 * Real (Phase 2, interfaces.md §5.1.2): when `budgetStore` is supplied, reads
 * `budgetStore.getUsage('nansen', dayBucketMs(now()))` and wraps it as `{provider: 'nansen',
 * creditsUsedToday}`. Two degradation paths, BOTH resolve to `undefined` rather than throwing —
 * visibility must never turn an otherwise-successful tool call into an error (mirrors
 * `CapabilityRegistry`'s own cache-fault contract, `registry.ts`):
 * - `budgetStore` was never injected into the tool's context (reviewer note: "`budgetStore`
 *   отсутствует (не инжектирован) → tool работает, просто без `_meta.budget`").
 * - `budgetStore.getUsage()` itself throws (a faulty/misbehaving store, same best-effort spirit as
 *   `registry.ts`'s own `cache.get()` fault handling).
 *
 * Callers are expected to invoke this ONLY when the capability's own `_meta.cache.status ===
 * 'miss'` — this function itself is agnostic to cache status, a generic "read usage, tolerate
 * failure" helper.
 */
export async function budgetMeta(
  budgetStore: BudgetStore | undefined,
  now: () => number,
): Promise<BudgetMeta | undefined> {
  if (!budgetStore) return undefined;
  try {
    const creditsUsedToday = await budgetStore.getUsage('nansen', dayBucketMs(now()));
    return { provider: 'nansen', creditsUsedToday };
  } catch {
    return undefined;
  }
}
