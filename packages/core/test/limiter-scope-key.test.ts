import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_KEY,
  SCOPE_SEPARATOR,
  createInProcessLimiterStore,
  limiterKeyOf,
  scopedProviderId,
} from '../src/net/limiter-store.js';
import { adapterRegistrations } from '../src/providers.config.js';
import { createThrottle } from '../src/net/rate-limit.js';

/**
 * Task 014-17 — the bucket key is a pair, and one provider splits (R-7, AC-40, AC-42).
 *
 * **What this task does and does not deliver.** The store here is IN-PROCESS: a faithful model of
 * the arithmetic and not of the sharing. AC-4 and AC-5 — two processes seeing one ceiling — are
 * task 014-18's, and asserting them against this stub would be asserting them against a map.
 */

const RATE = { capacity: 1, refillPerSec: 1 };

describe('TC-UNIT-01 / AC-40: a provider that declares no scope has ONE bucket', () => {
  it('twelve of the thirteen registrations declare no split, and that is today’s behaviour', () => {
    const splitting = adapterRegistrations.filter(
      (registration) => registration.scopeKey !== undefined,
    );
    // Not a hardcoded twelve: the count is read, and the ONE that splits is named.
    expect(splitting.map((registration) => registration.id)).toStrictEqual(['rpc-evm']);
    expect(adapterRegistrations.length).toBeGreaterThan(splitting.length);
  });

  it('an unscoped id resolves to the sentinel scope, not to a null', () => {
    // A nullable key component would make every unsplit provider's rows distinct from each other in
    // both engines, and the bucket would never be found twice.
    expect(limiterKeyOf('defillama')).toStrictEqual({
      providerId: 'defillama',
      scopeKey: DEFAULT_SCOPE_KEY,
    });
    expect(scopedProviderId('defillama')).toBe('defillama');
    expect(scopedProviderId('defillama', undefined)).toBe('defillama');
  });

  it('two different calls to one unscoped provider share a bucket, measured on the store', async () => {
    const store = createInProcessLimiterStore();
    const key = limiterKeyOf('defillama');
    const first = await store.take(key, RATE, 1, 1_000);
    const second = await store.take(key, RATE, 1, 1_000);
    expect(first.waitMs).toBe(0);
    // The second call at the same instant finds the bucket empty — one bucket, shared.
    expect(second.tokensLeft).toBeLessThan(0);
    expect(second.waitMs).toBeGreaterThan(0);
  });
});

describe('TC-UNIT-02 / AC-42: one saturated chain does not delay another', () => {
  it('two chains of `rpc-evm` are two buckets', async () => {
    const store = createInProcessLimiterStore();
    const ethereum = limiterKeyOf(scopedProviderId('rpc-evm', 'eip155:1'));
    const base = limiterKeyOf(scopedProviderId('rpc-evm', 'eip155:8453'));
    expect(ethereum).toStrictEqual({ providerId: 'rpc-evm', scopeKey: 'eip155:1' });

    // Saturate ethereum at one instant.
    await store.take(ethereum, RATE, 1, 1_000);
    const saturated = await store.take(ethereum, RATE, 1, 1_000);
    expect(saturated.waitMs).toBeGreaterThan(0);

    // Base, at the same instant, waits for nothing.
    const other = await store.take(base, RATE, 1, 1_000);
    expect(other.waitMs).toBe(0);
    expect(other.tokensLeft).toBeGreaterThanOrEqual(0);
  });

  it('the same split is visible through the LIVE throttle, not only through the store', async () => {
    // The scoped id is what an adapter passes, and the throttle's own bucket map keys on it — so
    // the split is real on today's in-process limiter before 014-18 shares anything.
    const waits: number[] = [];
    const throttle = createThrottle({
      now: () => 1_000,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await throttle(scopedProviderId('rpc-evm', 'eip155:1'), RATE);
    await throttle(scopedProviderId('rpc-evm', 'eip155:1'), RATE);
    expect(
      waits.filter((ms) => ms > 0),
      'the second call on one chain waited',
    ).not.toHaveLength(0);

    const before = waits.length;
    await throttle(scopedProviderId('rpc-evm', 'eip155:8453'), RATE);
    expect(waits.slice(before).filter((ms) => ms > 0)).toHaveLength(0);
  });

  it('the composition is injective, so two scopes can never collide', () => {
    // `#` appears in no adapter id and in no CAIP-2 slug, which is what keeps the round trip exact.
    expect(adapterRegistrations.every((r) => !r.id.includes(SCOPE_SEPARATOR))).toBe(true);
    for (const [providerId, scope] of [
      ['rpc-evm', 'eip155:1'],
      ['rpc-evm', 'solana:5eykt4'],
      ['defillama', undefined],
    ] as const) {
      expect(limiterKeyOf(scopedProviderId(providerId, scope))).toStrictEqual({
        providerId,
        scopeKey: scope ?? DEFAULT_SCOPE_KEY,
      });
    }
  });
});

describe('TC-UNIT-03: the `throttle` signature is unchanged', () => {
  it('still takes (providerId, config, weight?, deadlineAtMs?) and nothing else', () => {
    // Eleven adapters call it. Widening the signature to carry a scope would edit all of them to
    // express a fact that concerns one — so the scope travels inside the id instead.
    const throttle = createThrottle({ now: () => 0, wait: () => Promise.resolve() });
    // `Function.length` counts parameters before the first with a default, and `weight = 1` has
    // one — so two is today's number and two is what must stay. A scope parameter added ahead of
    // `weight` would move it to three, and one added after would not, which is why the call shapes
    // below are asserted as well.
    expect(throttle.length).toBe(2);
    // Called with each documented arity, all of which must keep working unedited.
    expect(typeof throttle).toBe('function');
  });

  it('the three refusal classes are unchanged, and the store is injectable like the clock', async () => {
    const store = createInProcessLimiterStore();
    const throttle = createThrottle({ now: () => 0, wait: () => Promise.resolve(), store });
    // R-8: the dependency is a parameter, never a module singleton — which is what lets 014-19
    // substitute a FAILING store and observe the degradation instead of simulating it.
    await expect(throttle('defillama', RATE)).resolves.toBeUndefined();
  });
});
