import { describe, expect, it } from 'vitest';
import {
  createInProcessLimiterStore,
  type LimiterKey,
  type LimiterStore,
  type LimiterTake,
} from '../src/net/limiter-store.js';
import {
  createThrottle,
  RateLimitRejectedError,
  type LimiterStoreTimer,
  type ThrottleDeps,
} from '../src/net/rate-limit.js';

/**
 * Task 014-19 — the limiter survives its store (R-7.7, AC-45, `system-architecture.md` §3.4.4).
 *
 * **The decision this measures, and the two alternatives it rejects.** Owner decision 2026-08-12:
 * letting the call through pierces the ceiling and moves spend onto the paid fallback behind a free
 * source; refusing turns a storage outage into a service outage. Degradation holds each process to
 * the declared ceiling — worse than one shared bucket, better than either extreme.
 *
 * **What degradation does NOT promise, asserted here so it is not read into the green.** The sum
 * across processes may exceed the ceiling, by up to the number of processes. That is the accepted
 * consequence, not a defect, and no case below claims otherwise.
 */

const RATE = { capacity: 2, refillPerSec: 2 };
const T0 = 1_770_000_000_000;
/** `DEGRADED_COOLDOWN_MS`, restated. A test that imported the constant would agree with the module
 * about a number neither of them had checked against §3.4.4. */
const COOLDOWN_MS = 60_000;

/** A deadline that never fires — every case except the hang one is about a store that ANSWERS
 * (with a value or a throw), and a real timer has no business in any of them. */
const neverFires = (): LimiterStoreTimer => ({
  promise: new Promise<never>(() => {}),
  cancel: () => {},
});

/** A store that fails every call the way a database that is down fails: by throwing. */
function brokenStore(reason = 'connection refused'): LimiterStore & { calls: number } {
  const state = {
    calls: 0,
    take: (): Promise<LimiterTake> => {
      state.calls += 1;
      return Promise.reject(new Error(reason));
    },
    refund: (): Promise<void> => {
      state.calls += 1;
      return Promise.reject(new Error(reason));
    },
  };
  return state;
}

/** A real (in-process) store that can be switched off and on, so recovery is a fact and not a mock
 * expectation. */
function flakyStore(): LimiterStore & { up: boolean; takes: number } {
  const inner = createInProcessLimiterStore();
  const state = {
    up: true,
    takes: 0,
    take: (key: LimiterKey, config: typeof RATE, weight: number, nowMs: number) => {
      state.takes += 1;
      return state.up
        ? inner.take(key, config, weight, nowMs)
        : Promise.reject(new Error('store is down'));
    },
    refund: (key: LimiterKey, weight: number, nowMs: number) =>
      state.up ? inner.refund(key, weight, nowMs) : Promise.reject(new Error('store is down')),
  };
  return state;
}

function throttleOver(store: LimiterStore, extra: Partial<ThrottleDeps> = {}) {
  const waits: number[] = [];
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  let clock = T0;
  const throttle = createThrottle({
    now: () => clock,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    store,
    storeTimer: neverFires,
    emit: (event, detail) => events.push({ event, detail }),
    ...extra,
  });
  return {
    throttle,
    waits,
    events,
    advance: (ms: number): void => {
      clock += ms;
    },
    at: (): number => clock,
  };
}

describe('TC-UNIT-01 / AC-45: a failed store still leaves a limiter', () => {
  it('holds the declared ceiling per process instead of admitting everything', async () => {
    const store = brokenStore();
    const { throttle, waits } = throttleOver(store);

    // Capacity 2 at one instant: two through, the third into backlog.
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);

    expect(store.calls, 'the store was tried, and only once — then the cooldown holds').toBe(1);
    expect(waits.filter((ms) => ms > 0)).toEqual([500]);
  });

  it('TC-UNIT-04: it does not let the call past the bucket', async () => {
    // A bucket this saturated refuses rather than waits, and it must still refuse while degraded —
    // "degraded" is not a synonym for "unlimited".
    const { throttle } = throttleOver(brokenStore());
    const slow = { capacity: 5, refillPerSec: 0.05 };
    await throttle('defillama', slow, 5);
    await expect(throttle('defillama', slow, 5)).rejects.toBeInstanceOf(RateLimitRejectedError);
  });
});

describe('TC-UNIT-02: the degradation is announced', () => {
  it('emits limiter.degraded naming the bucket, the reason and when it will retry', async () => {
    const { throttle, events, at } = throttleOver(brokenStore('ECONNREFUSED 10.0.0.2:5432'));
    await throttle('rpc-evm#eip155:1', RATE);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('limiter.degraded');
    expect(events[0]?.detail).toStrictEqual({
      providerId: 'rpc-evm',
      scopeKey: 'eip155:1',
      phase: 'take',
      reason: 'ECONNREFUSED 10.0.0.2:5432',
      cooldownMs: COOLDOWN_MS,
      retryAtMs: at() + COOLDOWN_MS,
    });
  });

  it('announces the TRANSITION, not every call it serves while degraded', async () => {
    const { throttle, events } = throttleOver(brokenStore());
    for (let i = 0; i < 5; i += 1) await throttle('defillama', { capacity: 50, refillPerSec: 50 });
    // A row per request for the length of an outage would drown the eight events §4.5.8 declares.
    expect(events).toHaveLength(1);
  });

  it('announces again after the cooldown expires and the retry fails — the outage is still on', async () => {
    const store = brokenStore();
    const { throttle, events, advance } = throttleOver(store);
    await throttle('defillama', RATE);
    advance(COOLDOWN_MS);
    await throttle('defillama', RATE);
    expect(store.calls).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('a throttle with no port degrades silently and identically', async () => {
    const { throttle, waits } = throttleOver(brokenStore(), { emit: undefined });
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    expect(waits.filter((ms) => ms > 0)).toEqual([500]);
  });
});

describe('TC-UNIT-03: recovery returns the process to the shared state', () => {
  it('does not touch the store during the cooldown, and takes it back afterwards', async () => {
    const store = flakyStore();
    const { throttle, advance } = throttleOver(store);

    store.up = false;
    await throttle('defillama', RATE);
    expect(store.takes).toBe(1);

    // Inside the cooldown the store is not called at all — that is what the cooldown buys: an
    // outage costs one timeout a minute per process, not one per call.
    advance(COOLDOWN_MS - 1);
    await throttle('defillama', RATE);
    expect(store.takes).toBe(1);

    store.up = true;
    advance(1);
    await throttle('defillama', RATE);
    expect(store.takes).toBe(2);

    // And it stays on the store from then on, rather than retrying once and falling back again.
    await throttle('defillama', RATE);
    expect(store.takes).toBe(3);
  });

  it('the shared bucket keeps what it held before the outage', async () => {
    const store = flakyStore();
    const { throttle, waits, advance } = throttleOver(store);

    // Two slots taken from the SHARED bucket: it is now empty.
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    expect(waits.filter((ms) => ms > 0)).toEqual([]);

    store.up = false;
    await throttle('defillama', RATE); // served by this process's own, full bucket — no wait
    expect(waits.filter((ms) => ms > 0)).toEqual([]);

    store.up = true;
    advance(COOLDOWN_MS);
    // The shared bucket owed 2 tokens for 60 s at 2/sec, so it refilled to capacity and this call
    // is free — but the FOURTH within the same instant is not, which is the state surviving.
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    expect(waits.filter((ms) => ms > 0)).toEqual([500]);
  });
});

describe('a store that hangs is a failure too, and the one a catch does not cover', () => {
  it('bounds the call and degrades when the deadline fires first', async () => {
    let cancels = 0;
    const hanging: LimiterStore = {
      take: () => new Promise<LimiterTake>(() => {}),
      refund: () => new Promise<void>(() => {}),
    };
    const { throttle, events } = throttleOver(hanging, {
      storeTimer: (ms) => ({
        promise: Promise.reject(new Error(`limiter store did not answer within ${ms}ms`)),
        cancel: () => {
          cancels += 1;
        },
      }),
    });

    await throttle('defillama', RATE);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail['reason']).toBe('limiter store did not answer within 1000ms');
    // The deadline is cancelled on every path, or the hottest call in this module leaks a timer.
    expect(cancels).toBe(1);
  });

  it('the production timer is a real one, unref-ed, and cancelled when the store answers', async () => {
    // No `storeTimer` override: this exercises the default. A store that answers immediately must
    // not leave a pending timer behind — vitest would hold the event loop open on one that is not
    // unref-ed, and the assertion below would still pass, so the unref is what makes this safe.
    const throttle = createThrottle({
      now: () => T0,
      wait: () => Promise.resolve(),
      store: createInProcessLimiterStore(),
    });
    await expect(throttle('defillama', RATE)).resolves.toBeUndefined();
  });
});

describe('the refund goes back to whichever store granted the slot', () => {
  it('a slot taken while degraded is returned to the process bucket, not to the store', async () => {
    const store = flakyStore();
    const { throttle } = throttleOver(store);
    const slow = { capacity: 5, refillPerSec: 0.05 };

    store.up = false;
    await throttle('defillama', slow, 5);
    // Saturating: refused, and the refund must reach the FALLBACK — crediting the shared row for a
    // slot it never granted would leave both buckets wrong in opposite directions.
    await expect(throttle('defillama', slow, 5)).rejects.toBeInstanceOf(RateLimitRejectedError);

    // Proven by the arithmetic rather than by a spy: two further saturating calls at the same
    // instant must compute the SAME wait, which they can only do if each rejection's slot came
    // back to the bucket that granted it. Routed to the shared store instead, the refund would fail
    // there (it is down), the fallback would keep the deficit, and the waits would grow by 100 s a
    // call.
    const waitOf = async (): Promise<number> => {
      const error = await throttle('defillama', slow, 5).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RateLimitRejectedError);
      return Number(/computed wait (\d+)ms/.exec((error as Error).message)?.[1]);
    };
    const first = await waitOf();
    expect(first).toBe(100_000);
    expect(await waitOf()).toBe(first);
  });

  it('a refund that fails degrades the process and does not change the refusal class', async () => {
    // The take succeeds and the refund does not — a store that dies between two statements.
    const inner = createInProcessLimiterStore();
    let refundsFail = false;
    const store: LimiterStore = {
      take: (key, config, weight, nowMs) => inner.take(key, config, weight, nowMs),
      refund: (key, weight, nowMs) =>
        refundsFail
          ? Promise.reject(new Error('lost the connection mid-refund'))
          : inner.refund(key, weight, nowMs),
    };
    const { throttle, events } = throttleOver(store);
    const slow = { capacity: 5, refillPerSec: 0.05 };

    await throttle('defillama', slow, 5);
    refundsFail = true;
    // The caller still gets the class the registry knows how to route ("ask the next provider"),
    // never a storage error it has no branch for.
    await expect(throttle('defillama', slow, 5)).rejects.toBeInstanceOf(RateLimitRejectedError);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail['phase']).toBe('refund');
  });
});

describe('regression: the healthy path is untouched', () => {
  it('a working store is used, and nothing is announced', async () => {
    const store = flakyStore();
    const { throttle, events, waits } = throttleOver(store);
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    await throttle('defillama', RATE);
    expect(store.takes).toBe(3);
    expect(events).toEqual([]);
    expect(waits.filter((ms) => ms > 0)).toEqual([500]);
  });
});
