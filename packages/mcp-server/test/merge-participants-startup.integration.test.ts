import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TC-INT-05 (task 013-2, T-013, R-162/R-163) — a paid participant reachable through a merged
 * capability's routes must take down PROCESS START, and it must do so **before** any store is
 * constructed.
 *
 * **Sibling of `registration-validation.integration.test.ts` (TC-INT-01, task 012-2) — same
 * mechanism, same reason for existing.** That file's own docstring explains why the assertions are
 * NOT interchangeable and why `src/server.js` + the stdio transport are mocked; this file follows
 * the identical shape for the OTHER module-scope guard, `assertMergeParticipantsAreFree`, called
 * immediately after `assertValidAdapterRegistrations` in `src/index.ts`.
 *
 * **This is the test the task exists to justify.** `merge-activation.test.ts`'s TC-UNIT-01/02 call
 * `assertMergeParticipantsAreFree` directly and would stay green even if the call line were deleted
 * from `src/index.ts` — the check would be declared but never enforced at the one place that
 * matters, the exact WI-34…WI-37 distinction. This file proves the WIRING, not the function.
 *
 * **No shipped route carries `merge: true` before 013-6**, so the fixture cannot use the real,
 * unmodified `routes` table — it mocks `@onchain-intel/core` to ADD one extra route for an
 * already-`mergeable: true` capability (`platform.metrics.history`, declared eligible in 013-1),
 * naming the REAL paid adapter (`nansen`, `tier: 'paid'` in `providers.config.ts`) as a second
 * participant. `assertMergeParticipantsAreFree` itself is NOT mocked — this exercises the real
 * implementation against a corrupted `routes` array, the same "corrupt the input, not the function"
 * discipline as the sibling file.
 */

const spies = vi.hoisted(() => ({
  /** Every store construction, in order. Must stay EMPTY when the gate fails. */
  constructed: [] as string[],
  serverConnected: [] as string[],
}));

const MERGING_CAPABILITY = 'platform.metrics.history';
const PAID_PARTICIPANT = 'nansen';

vi.mock('@onchain-intel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onchain-intel/core')>();
  // A SECOND route for an already-eligible capability (013-1's `mergeable: true`), naming the real
  // paid adapter as an extra participant. `assertMergeParticipantsAreFree` unions `adapterIds`
  // across ALL of a capability's routes (013-2's own rule) — the paid one need not sit on the route
  // that itself carries `merge: true`, only somewhere in the same capability's route set. Here it
  // does sit on the merge-carrying route directly, which is the simplest sufficient fixture.
  const mergeRoute = {
    capability: MERGING_CAPABILITY,
    adapterIds: ['platform-explorer', PAID_PARTICIPANT],
    merge: true,
  };
  return {
    ...actual,
    routes: [...actual.routes, mergeRoute],
    createCacheStore: () => {
      spies.constructed.push('createCacheStore');
      return undefined as never;
    },
    createBudgetStore: () => {
      spies.constructed.push('createBudgetStore');
      return {
        checkAndReserve: async () => ({ ok: true }) as const,
        recordDelta: async () => undefined,
        getUsage: async () => 0,
      } as never;
    },
  };
});

vi.mock('../src/server.js', () => ({
  createServer: () => ({
    connect: async () => {
      spies.serverConnected.push('connect');
    },
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

describe('TC-INT-05 — a paid participant on a merged capability fails process start', () => {
  beforeEach(() => {
    spies.constructed.length = 0;
    spies.serverConnected.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('importing src/index.ts rejects, naming the capability and the paid adapter, before any store exists', async () => {
    let thrown: unknown;
    try {
      await import('../src/index.js');
    } catch (error) {
      thrown = error;
    }

    // 1. Start fails OBSERVABLY.
    expect(thrown).toBeInstanceOf(Error);
    // 2. ...naming both halves — the capability and the offending adapter.
    expect((thrown as Error).message).toContain(MERGING_CAPABILITY);
    expect((thrown as Error).message).toContain(PAID_PARTICIPANT);
    // 3. ...and it failed BEFORE the stores — proves the call sits ahead of
    //    `createCacheStore()`/`createBudgetStore()`, not merely somewhere inside `main()`.
    expect(spies.constructed).toEqual([]);
    // 4. ...and long before a transport was attached.
    expect(spies.serverConnected).toEqual([]);
  });
});
