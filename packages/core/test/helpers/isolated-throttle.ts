import { createThrottle, type Throttle } from '../../src/net/rate-limit.js';

/**
 * A per-instance token bucket on a VIRTUAL clock — the seam WI-26 exists for.
 *
 * **The defect.** An adapter constructed without `throttle` falls back to the module-level
 * production singleton (`net/rate-limit.ts`'s exported `throttle`), whose bucket map is created
 * once per process. Vitest isolates per FILE, not per test, so every test in a file shared one
 * bucket — and the buckets are deliberately narrow (`blockscout` is `{capacity: 5,
 * refillPerSec: 2}` and one `entity.labels` call burns 3 tokens). Two calls emptied it; everything
 * after waited on a REAL `setTimeout`. Measured before this helper existed: 23.5 s in
 * `blockscout.transport.test.ts`, 12.8 s in `defillama-dex-volume`, 8.0 s in `blockscout-fallback`,
 * 2.0 s in `registry.fallback` — **46.8 s of the core suite's 48.5 s cumulative test time was
 * sleeping**. A gate whose verdict depends on what else the machine was doing is not a gate.
 *
 * (WI-26's capture also reports a single test at `1010515ms`. That figure is quoted from the
 * captured run and is **not** reproduced or explained here: vitest's default `testTimeout` is
 * 5 000 ms and nothing in this repo raises it, so a 16.8-minute *test* that then fails on an
 * assertion is not a shape this configuration can produce. Something real went wrong — the run was
 * red — but the number measures something other than one test's limiter sleep. The four durations
 * above were measured directly and are the evidence this helper rests on.)
 *
 * **Why not simply a no-op throttle.** That is the cheaper fix and it throws away the only place
 * the limiter runs against a real capability's real weight — the property
 * `BlockscoutAdapterDeps.throttle`'s docstring points at. Here the arithmetic is real: refill,
 * deficit and weight run exactly as in production for **sequentially awaited** calls, which is what
 * every test in this repo makes.
 *
 * **What this deliberately cannot reproduce (adversarial cycle 1).** `wait()` runs *synchronously*
 * inside `throttle()`'s synchronous prefix, so it advances the clock before the `await` suspends —
 * and the next caller's refill therefore sees the time its predecessor "slept". Under genuine
 * concurrency production behaves differently: every caller's prefix reads the same `Date.now()`,
 * deficits accumulate, and past `MAX_WAIT_MS = 30_000` the limiter throws `RateLimitRejectedError`.
 * Here deficits never accumulate, so **saturation and the fairness cap are unreachable by
 * construction**. A test that needs those must use `createThrottle` with a clock it controls itself
 * — `rate-limit.test.ts` does exactly that, and it is where that behaviour is owned.
 *
 * Each call returns a FRESH bucket state, so one test cannot spend another test's tokens.
 */
export function isolatedThrottle(startMs = 0): Throttle {
  let clock = startMs;
  return createThrottle({
    now: () => clock,
    wait: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
}
