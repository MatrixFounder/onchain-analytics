import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, adapterRegistrations, dayBucketMs } from '@onchain-intel/core';
import type { BudgetStore, CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { budgetMeta } from '../../src/tools/budget-meta.js';

/**
 * Unit tests for `src/tools/budget-meta.ts` (task 012-3, R-151/AC-14).
 *
 * The function used to take no provider: it hardcoded `getUsage('nansen')` and returned
 * `provider: 'nansen'`, the third of the four competing classifications of paidness ADR-002 D8
 * collapses into `AdapterRegistration.tier`. A membership check on that version would have been a
 * tautology — the checked value was a constant that always passed — which is why the task builds
 * the seam (PLAN §0.3, #2) instead of asserting over it.
 *
 * So the cases below are about the two things the parameter buys: the reported provider is one the
 * traversal actually ENTERED, and the membership check can actually FAIL.
 *
 * **The parameter changed twice, and the second time removed one.** 012-3 passed the ANSWERING
 * adapter's id; cycle 2's F-4 added the traversal record beside it; cycle 3's F-A found the pair
 * disagreeing — the answering id can be a CACHE HIT that spent nothing while the walk behind it paid
 * — and kept only the traversal record. Every case below therefore reads "who was entered", and no
 * case anywhere passes a cache status: `entered` being empty is what a pure hit IS.
 */

/** Records every `getUsage` call, so "was it consulted at all" is observable, not inferred. */
function recordingBudgetStore(usage = 10): {
  store: BudgetStore;
  calls: { provider: string; dayBucketMs: number }[];
} {
  const calls: { provider: string; dayBucketMs: number }[] = [];
  return {
    calls,
    store: {
      checkAndReserve: async () => ({ ok: true }),
      recordDelta: async () => undefined,
      getUsage: async (provider: string, day: number) => {
        calls.push({ provider, dayBucketMs: day });
        return usage;
      },
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 0,
    },
  };
}

const NOW = 1_800_000_000_000;
const now = (): number => NOW;

describe('TC-UNIT-04 — a paid provider yields `{provider, creditsUsedToday}`', () => {
  it('reads the usage of the paid provider that was entered and reports it under that id', async () => {
    const { store, calls } = recordingBudgetStore(42);
    await expect(budgetMeta(store, now, ['nansen'])).resolves.toStrictEqual({
      provider: 'nansen',
      creditsUsedToday: 42,
    });
    // The ledger read must be keyed on the ENTERED provider and on the current day bucket — a
    // mutant that keeps `getUsage('nansen', …)` while echoing the argument back would otherwise
    // pass every value assertion in this file.
    expect(calls).toStrictEqual([{ provider: 'nansen', dayBucketMs: dayBucketMs(NOW) }]);
  });

  it('is not nansen-specific: the OTHER paid adapter reads its own ledger row', async () => {
    // `dune` is the second `tier: 'paid'` registration. Nothing about this function names a vendor
    // any more, and this case is what says so — it fails on any surviving `'nansen'` literal.
    const { store, calls } = recordingBudgetStore(7);
    await expect(budgetMeta(store, now, ['dune'])).resolves.toStrictEqual({
      provider: 'dune',
      creditsUsedToday: 7,
    });
    expect(calls.map((call) => call.provider)).toStrictEqual(['dune']);
  });
});

describe('TC-UNIT-05 — a FREE walk yields `undefined`, and the store is never consulted', () => {
  /**
   * This is the case that makes the membership check falsifiable, and it is not hypothetical:
   * `entity.labels` routes `blockscout` (free) first and reaches `nansen` only when blockscout's
   * answer is unsatisfying, so a free-only walk is the ordinary case on that route whenever
   * blockscout satisfies.
   *
   * The opposite input — a free ANSWERER with a paid entry behind it — is TC-F4-UNIT below, and it
   * must NOT be `undefined`.
   */
  it('returns undefined for a free adapter WITHOUT calling getUsage', async () => {
    const { store, calls } = recordingBudgetStore();
    await expect(budgetMeta(store, now, ['blockscout'])).resolves.toBeUndefined();
    // Asserting only the `undefined` would pass on an implementation that asked the store for a
    // usage row that cannot exist and then threw the answer away — same return value, a real read.
    expect(calls).toStrictEqual([]);
  });

  it('returns undefined for an id that is not a registered adapter at all', async () => {
    const { store, calls } = recordingBudgetStore();
    await expect(budgetMeta(store, now, ['not-an-adapter'])).resolves.toBeUndefined();
    expect(calls).toStrictEqual([]);
  });

  it('an EMPTY walk — the pure cache hit — is undefined, and is the default argument', async () => {
    // Cycle 3, F-A: this case is what replaced the callers' `cache.status === 'miss'` gate. A pure
    // hit entered nobody, so the empty list already carries the whole fact; both spellings are
    // asserted because the handlers pass `outcome.attempted`, which is ABSENT (not `[]`) whenever
    // the registry omitted it.
    const { store, calls } = recordingBudgetStore();
    await expect(budgetMeta(store, now, [])).resolves.toBeUndefined();
    await expect(budgetMeta(store, now)).resolves.toBeUndefined();
    expect(calls).toStrictEqual([]);
  });

  it('the free/paid split under test is the registration table, not a list of this file’s own', () => {
    // Pins the mechanism rather than the outcome: `blockscout` is only a valid probe for the case
    // above while it is registered and free, and `nansen`/`dune` only while they are paid. If a
    // future task re-ranks one of them, this fails here — visibly — instead of silently turning the
    // case above into a test of nothing.
    const tierOf = (id: string): string | undefined =>
      adapterRegistrations.find((r) => r.id === id)?.tier;
    expect(tierOf('blockscout')).toBe('free');
    expect(tierOf('nansen')).toBe('paid');
    expect(tierOf('dune')).toBe('paid');
    expect(tierOf('not-an-adapter')).toBeUndefined();
  });
});

/**
 * Adversarial cycle 2, F-4 — visibility follows the TRAVERSAL, not the winner.
 *
 * 012-3 replaced a hardcoded `getUsage('nansen')` (a false POSITIVE: it reported a spend on calls
 * that had none) with a reading keyed on the answering provider — and created the mirror defect on
 * the one route the whole free-first order exists for. `entity.labels` walks `blockscout` → `nansen`;
 * when NEITHER has labels, `nansen` is entered and PAYS while the registry returns blockscout's
 * truthful-but-unsatisfying answer, so the answering id is a free adapter and `_meta.budget`
 * disappeared on a call that had just spent credits. Under-reporting is the expensive direction: an
 * agent that believes a call was free repeats it (R-41).
 */
describe('TC-F4-UNIT — a free ANSWERER with a paid adapter in the walk still reports the spend', () => {
  it('reads the paid adapter the traversal entered, not the one that answered', async () => {
    const { store, calls } = recordingBudgetStore(5);
    await expect(budgetMeta(store, now, ['blockscout', 'nansen'])).resolves.toStrictEqual({
      provider: 'nansen',
      creditsUsedToday: 5,
    });
    // Keyed on the PAID id, not on the answering one — a mutant that reported `provider: 'nansen'`
    // while reading blockscout's (permanently empty) ledger row would pass the value above.
    expect(calls).toStrictEqual([{ provider: 'nansen', dayBucketMs: dayBucketMs(NOW) }]);
  });

  it('a walk of free adapters only is still undefined, and still touches nothing', async () => {
    // The other direction, so the fix cannot be "report something whenever `entered` is non-empty":
    // that would resurrect the false POSITIVE 012-3 removed.
    const { store, calls } = recordingBudgetStore();
    await expect(budgetMeta(store, now, ['coingecko', 'blockscout'])).resolves.toBeUndefined();
    expect(calls).toStrictEqual([]);
  });

  it('the LAST paid entry wins when a walk enters two', async () => {
    // The wire shape is one `{provider, creditsUsedToday}`, so several paid entries have to be
    // collapsed; the most recently entered source is the one this response is closest in time to.
    // Written with two paid ids so the precedence is observable at all — no route reaches two today.
    const { store, calls } = recordingBudgetStore(9);
    await expect(budgetMeta(store, now, ['dune', 'nansen'])).resolves.toStrictEqual({
      provider: 'nansen',
      creditsUsedToday: 9,
    });
    expect(calls.map((call) => call.provider)).toStrictEqual(['nansen']);
  });
});

/**
 * TC-F-A-INV — the invariant the cycle-3 simplification rests on, asserted instead of assumed.
 *
 * Dropping the answering-provider argument is only sound while the answering adapter of a `'miss'`
 * is itself in `attempted`. It is, by construction: `adapters/registry.ts` pushes the id immediately
 * BEFORE `adapter.fetch()`, and the only `cache: 'miss'` resolution it builds is returned from the
 * line after that call. But "by construction" is exactly the kind of claim that stops being true in
 * a later refactor while every value assertion in this file keeps passing — and the failure mode is
 * silent under-reporting of a paid call, which is the direction R-41 cares about.
 *
 * So this drives the REAL `CapabilityRegistry` and reads the property off its resolution.
 */
describe('TC-F-A-INV — on a `miss`, the answering adapter is always among the entered ones', () => {
  it('registry.resolve() reports `source` inside `attempted` for a fresh answer', async () => {
    const routes: CapabilityRoute[] = [{ capability: 'entity.labels', adapterIds: ['nansen'] }];
    const adapter: ProviderAdapter = {
      id: 'nansen',
      capabilities: () => [{ id: 'entity.labels', chains: ['ethereum'] }],
      costOf: () => ({ credits: 5 }),
      fetch: async () => ({}),
      normalize: () => [{ name: 'Uniswap' }],
      isAvailable: () => ({ ok: true }),
    };
    const registry = new CapabilityRegistry(routes, new Map([['nansen', adapter]]));

    const resolution = await registry.resolve('entity.labels', 'ethereum', {});

    expect(resolution.cache).toBe('miss');
    expect(resolution.attempted).toContain(resolution.source);
  });
});

describe('TC-UNIT-06 — both pre-existing degradation paths still yield `undefined`', () => {
  it('no budgetStore injected -> undefined (the tool answers, just without _meta.budget)', async () => {
    await expect(budgetMeta(undefined, now, ['nansen'])).resolves.toBeUndefined();
  });

  it('getUsage() throwing -> undefined, never a rejected promise', async () => {
    // Visibility must never turn an otherwise-successful tool call into an error.
    const faulty: BudgetStore = {
      ...recordingBudgetStore().store,
      getUsage: async () => {
        throw new Error('budget ledger unavailable');
      },
    };
    await expect(budgetMeta(faulty, now, ['nansen'])).resolves.toBeUndefined();
  });
});
