import { describe, expect, it, vi } from 'vitest';
import {
  createThrottle,
  RateLimitRejectedError,
  throttle as productionThrottle,
} from '../src/net/rate-limit.js';

/** Builds an injectable, real-timer-free clock: `now()` returns a controllable counter; `wait(ms)`
 * never actually sleeps — it advances the same counter by `ms` and resolves immediately, so tests
 * can assert on the requested wait duration without spending real wall-clock time. */
function fakeClock(startMs = 0) {
  let current = startMs;
  const waitCalls: number[] = [];
  return {
    now: () => current,
    wait: vi.fn((ms: number) => {
      waitCalls.push(ms);
      current += ms;
      return Promise.resolve();
    }),
    advance: (ms: number) => {
      current += ms;
    },
    waitCalls,
  };
}

describe('throttle (token-bucket) [Phase 2, injectable clock — no real timers]', () => {
  it('lets up to `capacity` calls through immediately without waiting', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 3, refillPerSec: 1 };

    await throttle('coingecko', config);
    await throttle('coingecko', config);
    await throttle('coingecko', config);

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('waits once capacity is exhausted, for exactly the time needed to refill one token', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 }; // one token, refills fully in 500ms

    await throttle('coingecko', config); // consumes the only token, no wait
    await throttle('coingecko', config); // must wait

    expect(clock.wait).toHaveBeenCalledTimes(1);
    expect(clock.wait).toHaveBeenCalledWith(500);
  });

  it('refills tokens proportionally to elapsed time before deciding whether to wait', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 2, refillPerSec: 1 };

    await throttle('dexscreener', config);
    await throttle('dexscreener', config); // bucket now empty
    clock.advance(1000); // one full second passes — refills exactly one token

    await throttle('dexscreener', config); // should proceed without waiting

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('never refills beyond `capacity`, even after a very long idle period', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 2, refillPerSec: 5 };

    await throttle('defillama', config);
    await throttle('defillama', config); // bucket empty
    clock.advance(10_000); // would refill far more than 2 tokens if uncapped

    await throttle('defillama', config); // 1st of the refilled tokens
    await throttle('defillama', config); // 2nd — still within capacity, no wait
    await throttle('defillama', config); // 3rd — bucket exhausted again, must wait

    expect(clock.wait).toHaveBeenCalledTimes(1);
  });

  it('maintains an independent bucket per providerId — exhausting one never throttles another', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const tightConfig = { capacity: 1, refillPerSec: 0.1 };
    const roomyConfig = { capacity: 5, refillPerSec: 1 };

    await throttle('dune', tightConfig); // exhausts dune's single token

    await throttle('coingecko', roomyConfig); // unrelated provider, unaffected

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('the production `throttle` singleton is a real, callable Throttle built with real timers (smoke check only, not exercised for timing)', () => {
    expect(typeof productionThrottle).toBe('function');
  });

  describe('concurrency-safe token bucket (adversarial cycle 1, fix C)', () => {
    it('serializes 3 concurrent callers against a 1-capacity bucket into distinct, cascading wait durations — never all firing after the same single wait', async () => {
      // A frozen clock (`now()` never advances on its own) — `wait()` only records the requested
      // duration, with NO clock mutation — isolates the spacing logic under test from the
      // real-time-elapsed refill logic the tests above already cover via `clock.advance()`. This
      // matters because 3 calls issued via `Promise.all` all run their synchronous bucket-math
      // prefix back-to-back, in the same real instant, before any of them awaits a real timer.
      const waitCalls: number[] = [];
      const deps = {
        now: () => 0,
        wait: vi.fn((ms: number) => {
          waitCalls.push(ms);
          return Promise.resolve();
        }),
      };
      const throttle = createThrottle(deps);
      const config = { capacity: 1, refillPerSec: 2 }; // 1 token every 500ms

      await Promise.all([
        throttle('shared', config),
        throttle('shared', config),
        throttle('shared', config),
      ]);

      // 1st caller consumes the initial token immediately (no wait call at all); the 2nd and 3rd
      // each get their OWN, progressively later slot — never the same duration twice (the bug
      // this fix closes: both used to compute the identical 500ms wait).
      expect(waitCalls).toEqual([500, 1000]);
    });

    it('rejects with a typed RateLimitRejectedError when refillPerSec is 0 — never busy-spins or hangs forever', async () => {
      const clock = fakeClock();
      const throttle = createThrottle(clock);

      await expect(
        throttle('broken-provider', { capacity: 1, refillPerSec: 0 }),
      ).rejects.toBeInstanceOf(RateLimitRejectedError);
      expect(clock.wait).not.toHaveBeenCalled();
    });

    it('rejects with a typed RateLimitRejectedError for a negative refillPerSec too', async () => {
      const clock = fakeClock();
      const throttle = createThrottle(clock);

      await expect(
        throttle('broken-provider', { capacity: 1, refillPerSec: -1 }),
      ).rejects.toBeInstanceOf(RateLimitRejectedError);
    });
  });
});
