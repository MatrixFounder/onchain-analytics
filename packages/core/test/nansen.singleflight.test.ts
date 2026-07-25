import { describe, expect, it, vi } from 'vitest';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { createThrottle } from '../src/net/rate-limit.js';

// Singleflight coalescing (task 005-5, R-39) — the outermost layer of `fetch()`. Exercised through
// the FULL composed `adapter.fetch()` (not `createSingleflight()` in isolation): the assertions this
// task's own Test Cases list names (`checkAndReserve`-spy call count, `fetchImpl`-spy call count,
// `recordDelta`-spy call count) only make sense at that composed level, proving the WHOLE pipeline
// coalesces, not just an isolated `Map` wrapper. No live Nansen credits — every network call goes
// through an injected `fetchImpl`, and the throttle uses a real-timer-free fake clock.

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
const UNI_ADDRESS = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const AAVE_ADDRESS = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';

/** Real-timer-free token-bucket clock (mirrors test/rate-limit.test.ts's own `fakeClock()`) — some
 * scenarios below issue calls across two `fetch()` attempts, which would otherwise burn real
 * wall-clock time against the 5-capacity/1-per-second `nansen` rate limit (`providers.config.ts`). */
function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    wait: (ms: number): Promise<void> => {
      current += ms;
      return Promise.resolve();
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface Fixture {
  adapter: ReturnType<typeof createNansenAdapter>;
  budgetStore: ReturnType<typeof createBudgetStore>;
  calls: string[];
  reserveSpy: ReturnType<typeof vi.spyOn>;
  recordDeltaSpy: ReturnType<typeof vi.spyOn>;
}

/** `smart-money.flows` (2 sub-calls, 10cr total, R-41 "always both") — the simplest composite
 * capability, routed against a synthetic `/api/v1/account` + the two real sub-endpoints. */
function makeFixture(overrides: { dailyCreditCap?: number; holdersStatus?: number } = {}): Fixture {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname === '/api/v1/account') {
      return jsonResponse({ plan: 'free', credits_remaining: 100_000 });
    }
    if (pathname === '/api/v1/smart-money/netflow') {
      return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
    }
    if (pathname === '/api/v1/tgm/holders') {
      if (overrides.holdersStatus) {
        return jsonResponse(null, overrides.holdersStatus);
      }
      return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
    }
    throw new Error(`unrouted test call to ${pathname}`);
  };

  const budgetStore = createBudgetStore({ dbPath: ':memory:' });
  const reserveSpy = vi.spyOn(budgetStore, 'checkAndReserve');
  const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');

  const adapter = createNansenAdapter({
    env: { NANSEN_API_KEY: 'test-key-not-real' },
    fetchImpl,
    now: () => NOW,
    throttle: createThrottle(fakeClock()),
    budgetStore,
    ...(overrides.dailyCreditCap !== undefined ? { dailyCreditCap: overrides.dailyCreditCap } : {}),
  });

  return { adapter, budgetStore, calls, reserveSpy, recordDeltaSpy };
}

describe('fetch() singleflight coalescing (task 005-5, R-39)', () => {
  // TC-UNIT-08
  it('TC-UNIT-08 (coalescing): two parallel identical fetch() calls share ONE reservation, ONE HTTP set, ONE usage write, and the same result', async () => {
    const { adapter, budgetStore, calls, reserveSpy, recordDeltaSpy } = makeFixture();
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    // No `await` between the two starts — both `fetch()` calls run their synchronous prefix
    // (singleflight's own Map lookup) before either settles, so the second one finds the first's
    // in-flight entry.
    const [result1, result2] = await Promise.all([
      adapter.fetch('smart-money.flows', args),
      adapter.fetch('smart-money.flows', args),
    ]);

    expect(result1).toBe(result2); // literally the same coalesced outcome, not two independent fetches
    expect(calls.filter((p) => p === '/api/v1/smart-money/netflow')).toHaveLength(1);
    expect(calls.filter((p) => p === '/api/v1/tgm/holders')).toHaveLength(1);
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(10);
  });

  // TC-UNIT-09
  it('TC-UNIT-09 (sequential, not coalesced): a second identical fetch() issued AFTER the first resolves gets its own fresh reservation and network calls', async () => {
    const { adapter, budgetStore, calls, reserveSpy } = makeFixture();
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    await adapter.fetch('smart-money.flows', args);
    await adapter.fetch('smart-money.flows', args);

    expect(calls.filter((p) => p === '/api/v1/smart-money/netflow')).toHaveLength(2);
    expect(calls.filter((p) => p === '/api/v1/tgm/holders')).toHaveLength(2);
    expect(reserveSpy).toHaveBeenCalledTimes(2);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(20);
  });

  // TC-UNIT-10
  it('TC-UNIT-10 (key derivation): identical args in a different key order coalesce; a genuinely different arg value does not', async () => {
    const { adapter, calls } = makeFixture();

    const [result1, result2] = await Promise.all([
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
      adapter.fetch('smart-money.flows', { tokenAddress: UNI_ADDRESS, chain: 'ethereum' }), // reordered keys
    ]);
    expect(result1).toBe(result2);
    expect(calls.filter((p) => p === '/api/v1/smart-money/netflow')).toHaveLength(1);

    const [result3, result4] = await Promise.all([
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: AAVE_ADDRESS }),
    ]);
    expect(result3).not.toBe(result4); // different args -> NOT coalesced with each other
    expect(calls.filter((p) => p === '/api/v1/smart-money/netflow')).toHaveLength(3); // +2, distinct keys
  });

  // TC-UNIT-11
  it('TC-UNIT-11 (cleanup on rejection): a rejected fetch() clears its Map entry — a retry for the same key starts fresh, not stuck on the rejected promise', async () => {
    const { adapter, calls } = makeFixture({ holdersStatus: 402 });
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    await expect(adapter.fetch('smart-money.flows', args)).rejects.toThrow(/402/);
    const holdersCallsAfterFirst = calls.filter((p) => p === '/api/v1/tgm/holders').length;

    // Retry — if the Map entry were never cleared, this would hang forever awaiting the SAME
    // already-settled (rejected) promise instead of starting a genuinely new attempt.
    await expect(adapter.fetch('smart-money.flows', args)).rejects.toThrow(/402/);
    const holdersCallsAfterSecond = calls.filter((p) => p === '/api/v1/tgm/holders').length;

    expect(holdersCallsAfterSecond).toBe(holdersCallsAfterFirst + 1); // a genuinely fresh HTTP attempt
  });

  // TC-UNIT-12
  it('TC-UNIT-12 (layer order): a gate refusal makes ZERO network calls of its own, and still clears its singleflight entry', async () => {
    const { adapter, calls } = makeFixture({ dailyCreditCap: 10 }); // smart-money.flows costs exactly 10cr
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    // Warm-up call: consumes the entire 10cr self-imposed cap AND resyncs /account, so the refused
    // call below reuses an already-fresh, same-bucket snapshot (needsResync() sees no reason to
    // resync again) — isolating "gate refusal" from "resync" as the only network-call source.
    await adapter.fetch('smart-money.flows', args);
    calls.length = 0; // only the REFUSED call's own network activity matters from here

    await expect(adapter.fetch('smart-money.flows', args)).rejects.toThrow(/self-imposed cap/);
    expect(calls).toHaveLength(0); // fetchImpl never invoked at all for the refused call

    // The singleflight entry was still cleared in `finally` — a further attempt is a genuinely
    // fresh gate check (same refusal reason again, since the cap is still fully spent), not a hang.
    await expect(adapter.fetch('smart-money.flows', args)).rejects.toThrow(/self-imposed cap/);
  });

  // M-2(c) (adversarial review cycle 1): arg extraction + normalizeAddress are hoisted ABOVE
  // ensureBudget() — a malformed address must throw before ANY credits are reserved, never after.
  // Pre-fix, `performSubCalls()` was the first thing to validate the address, but only AFTER
  // `ensureBudget()` had already committed the reservation — this proves no reservation, and not
  // even the /account resync HTTP call, ever happens for a malformed address.
  it('M-2(c): a malformed tokenAddress throws before ANY credits are reserved (not even the /account resync runs)', async () => {
    const { adapter, budgetStore, calls, reserveSpy } = makeFixture();

    await expect(
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: 'not-an-address' }),
    ).rejects.toThrow(/invalid ethereum address/);

    expect(reserveSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0); // zero HTTP calls at all, not even /account
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(0);
  });
});
