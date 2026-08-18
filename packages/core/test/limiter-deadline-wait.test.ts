import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteLimiterStore } from '../src/cache/limiter-store.js';
import type { LimiterStore } from '../src/net/limiter-store.js';
import {
  createThrottle,
  renderBucketState,
  DeadlineWouldExceedError,
  RateLimitRejectedError,
  type LimiterBucketState,
  type Throttle,
} from '../src/net/rate-limit.js';

/**
 * Task 014-20 — the wait in the SHARED bucket ends by the call deadline (R-9.1/R-9.4, AC-21).
 *
 * **Why this could not be measured before T-014.** There was one waiter, because there was one
 * bucket per process. With two sessions against one row the question becomes answerable and has to
 * be answered: a call carrying eight seconds of budget must not wait out a backlog another tenant
 * created, and a call carrying a minute may.
 *
 * **Two throttles over ONE store is the model, and the model is the point.** Each `createThrottle`
 * is one session's limiter: separate in-process state, separate clock, one bucket. A test that used
 * one throttle for both principals would be measuring a `Map`.
 */

/** 500 ms per token, two tokens deep — small enough that every number below is exact. */
const RATE = { capacity: 2, refillPerSec: 2 };
const T0 = 1_770_000_000_000;
const PROVIDER = 'defillama';
/** `MIN_POST_WAIT_REMAINDER_MS`, restated rather than imported: a test that read the module's own
 * constant would agree with it about a number neither had checked against R-9.2. */
const FLOOR_MS = 5_000;
const CAP_MS = 30_000;

let dir: string;
let store: LimiterStore & { close(): void };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'onchain-limiter-deadline-'));
  store = createSqliteLimiterStore({ dbPath: path.join(dir, 'cache.sqlite3') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One session's limiter over the shared bucket, with its waits recorded rather than slept. */
function session(): { throttle: Throttle; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    throttle: createThrottle({
      now: () => T0,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      store,
      storeTimer: () => ({ promise: new Promise<never>(() => {}), cancel: () => {} }),
    }),
  };
}

/** Drives the bucket into a backlog with no deadline anywhere, so the cases below start level. */
async function drainTo(deficit: number): Promise<void> {
  const { throttle } = session();
  for (let taken = 0; taken < RATE.capacity + deficit; taken += RATE.capacity) {
    await throttle(PROVIDER, RATE, RATE.capacity);
  }
}

describe('TC-UNIT-01 / AC-21: on a saturated bucket the deadline decides, not MAX_WAIT_MS', () => {
  it('the short-deadline principal refuses while the long-deadline one waits — in either order', async () => {
    for (const shortFirst of [false, true]) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(path.join(tmpdir(), 'onchain-limiter-deadline-'));
      store.close();
      store = createSqliteLimiterStore({ dbPath: path.join(dir, 'cache.sqlite3') });
      await drainTo(2); // bucket: −2, i.e. one second of backlog

      const long = session();
      const short = session();
      // 20 s of budget against a 2 s wait clears the floor with room; 6 s against 3 s does not.
      const runLong = (): Promise<void> => long.throttle(PROVIDER, RATE, 2, T0 + 20_000);
      const runShort = (): Promise<unknown> =>
        short.throttle(PROVIDER, RATE, 2, T0 + 6_000).catch((error: unknown) => error);

      const [first, second] = shortFirst ? [runShort, runLong] : [runLong, runShort];
      const firstOut = await first();
      const secondOut = await second();

      const where = `shortFirst=${String(shortFirst)}`;
      const longOut = shortFirst ? secondOut : firstOut;
      const shortOut = shortFirst ? firstOut : secondOut;

      // Order does not decide this — swapping who goes first swaps nothing about who waits. The
      // deadline does.
      expect(longOut, where).toBeUndefined();
      expect(shortOut, where).toBeInstanceOf(DeadlineWouldExceedError);
      expect((shortOut as DeadlineWouldExceedError).phase, where).toBe('predicted');
      // The long-deadline principal slept on the SAME bucket the short one was refused over.
      expect(
        long.waits.filter((ms) => ms > 0),
        where,
      ).toHaveLength(1);
      expect(short.waits, where).toEqual([]);
    }
  });
});

describe('TC-UNIT-02: a deadline beyond the cap does not lengthen the wait', () => {
  it('a wait over MAX_WAIT_MS is still refused, with an hour of budget left', async () => {
    // 0.05 tokens/s: a two-token deficit is 40 s, over the 30 s fairness cap.
    const slow = { capacity: 2, refillPerSec: 0.05 };
    const { throttle, waits } = session();
    await throttle(PROVIDER, slow, 2);
    const refused = await throttle(PROVIDER, slow, 2, T0 + 3_600_000).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(RateLimitRejectedError);
    expect((refused as Error).message).toContain(`${String(CAP_MS)}ms fairness cap`);
    // Nothing was slept: the cap refuses rather than truncating, because a truncated wait returns
    // without the token it was waiting for.
    expect(waits).toEqual([]);
  });
});

describe('TC-UNIT-03: the post-wait floor is what the deadline is measured against', () => {
  it('a wait leaving exactly the floor is served, and one ms less is refused', async () => {
    await drainTo(2); // −2 → the next weight-2 caller waits 2 000 ms

    const served = session();
    await served.throttle(PROVIDER, RATE, 2, T0 + 2_000 + FLOOR_MS);
    expect(served.waits).toEqual([2_000]);

    await drainTo(2);
    const refused = session();
    const error = await refused
      .throttle(PROVIDER, RATE, 2, T0 + 2_000 + FLOOR_MS - 1)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    expect((error as DeadlineWouldExceedError).minRemainderMs).toBe(FLOOR_MS);
    expect(refused.waits).toEqual([]);
  });
});

describe('TC-UNIT-04 / R-9.4: the operator rendering names the remainder and the ceiling', () => {
  it('the deadline refusal carries both, as text and as a field', async () => {
    await drainTo(2);
    const { throttle } = session();
    const error = (await throttle(PROVIDER, RATE, 2, T0 + 6_000).catch(
      (caught: unknown) => caught,
    )) as DeadlineWouldExceedError;

    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    // «остаток» and «потолок»: −4 tokens against a ceiling of 2. Without the pair an operator
    // cannot tell a bucket configured too tight from a bucket another tenant drained, and those
    // call for opposite responses.
    expect(error.bucket).toStrictEqual({ remaining: -4, ceiling: 2, refillPerSec: 2 });
    expect(error.message).toContain(renderBucketState(error.bucket as LimiterBucketState));
  });

  it('the saturation refusal carries both, and the misconfiguration refusals carry neither', async () => {
    const slow = { capacity: 2, refillPerSec: 0.05 };
    const { throttle } = session();
    await throttle(PROVIDER, slow, 2);
    const saturated = (await throttle(PROVIDER, slow, 2).catch(
      (caught: unknown) => caught,
    )) as RateLimitRejectedError;
    expect(saturated.bucket).toStrictEqual({ remaining: -2, ceiling: 2, refillPerSec: 0.05 });

    // Absent is not "unknown": these two are refused BEFORE any bucket is touched, so there is no
    // state to report and inventing one would describe a bucket that was never read.
    const misconfigured = (await throttle(PROVIDER, { capacity: 2, refillPerSec: 0 }).catch(
      (caught: unknown) => caught,
    )) as RateLimitRejectedError;
    expect(misconfigured).toBeInstanceOf(RateLimitRejectedError);
    expect(misconfigured.bucket).toBeUndefined();
    expect(misconfigured.message).not.toContain('bucket remaining');

    const unsatisfiable = (await throttle(PROVIDER, RATE, 99).catch(
      (caught: unknown) => caught,
    )) as RateLimitRejectedError;
    expect(unsatisfiable.bucket).toBeUndefined();
  });
});

describe('regression: a call with no deadline behaves as it always did', () => {
  it('waits out the backlog rather than refusing, and the wait is the arithmetic one', async () => {
    await drainTo(2);
    const { throttle, waits } = session();
    await throttle(PROVIDER, RATE, 2);
    expect(waits).toEqual([2_000]);
  });
});
