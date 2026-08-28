import { describe, expect, it } from 'vitest';
import type { BudgetStore } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createSharedRuntime } from '../src/runtime.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';

/**
 * Task 015-15, MINOR-8 (round 2 plan review) — the daily call gate's POINT OF CONSTRUCTION is
 * `runtime.ts:206`: `createCallGate({ provider: 'blockscout', budgetStore })`, over the SAME
 * `budgetStore` instance `nansen`'s own gate already receives (`runtime.ts:211`). Task 015-13's own
 * `call-gate-contract.test.ts` and this task's own `blockscout-call-gate.test.ts` (`packages/core`)
 * prove the gate and the adapter wiring in isolation; this file proves the SEAM those two cannot
 * reach — that `buildRegistry()` actually builds the gate over the SHARED store, not a private one,
 * and actually hands it to the `blockscout` adapter.
 *
 * **No network reached, by TWO independent guards, so a wiring bug cannot turn this into a live
 * call (R-21).** The injected `budgetStoreFactory` refuses every reservation outright, and the
 * injected `throttle` ALSO refuses outright — belt and braces: if the gate were accidentally
 * skipped, the walk would still stop at the limiter, never at `fetch`.
 */

describe('TC-UNIT-09: production wiring builds the daily call gate over the SAME budgetStore nansen gets', () => {
  it("checkAndReserve('blockscout', …) reaches the injected store — not a private instance, not skipped", async () => {
    const calls: unknown[][] = [];
    const stubBudgetStore: BudgetStore = {
      checkAndReserve: async (...args: unknown[]) => {
        calls.push(args);
        // Refuses unconditionally — keeps this test offline (see file docstring) and lets a single
        // assertion on `calls` answer both "was it called" and "with what provider".
        return { ok: false, reason: 'stub refusal — this test never intends to admit a call' };
      },
      recordDelta: async () => undefined,
      getUsage: async () => 0,
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 0,
    } as unknown as BudgetStore;

    const runtime = createSharedRuntime({
      env: loadEnv({ BLOCKSCOUT_PRO_API_KEY: 'proapi_test_placeholder_not_a_secret' }),
      version: '0.0.0-test',
      budgetStoreFactory: () => stubBudgetStore,
      billing: createBillingStoreStub(),
      // Second guard (belt and braces, see file docstring): rejects unconditionally, so a bug that
      // skipped the gate entirely still cannot reach `fetch()`.
      throttle: () => Promise.reject(new Error('limiter probe — must never be reached live')),
    });

    // `createSharedRuntime` returns the SAME instance the factory produced (R-2.2) — the identity
    // this whole test rests on: `nansen`'s own gate (`runtime.ts:211`) and `blockscout`'s
    // (`runtime.ts:206`) are built over `runtime.budgetStore`, this exact object.
    expect(runtime.budgetStore).toBe(stubBudgetStore);

    await runtime.registry
      .resolve('token.holders', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      })
      .catch(() => undefined);

    const blockscoutCalls = calls.filter((args) => args[0] === 'blockscout');
    expect(
      blockscoutCalls,
      'blockscout must reserve against the SAME budgetStore runtime.ts hands to nansen',
    ).toHaveLength(1);
  });
});
