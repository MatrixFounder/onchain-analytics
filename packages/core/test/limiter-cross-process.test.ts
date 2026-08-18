import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteLimiterStore } from '../src/cache/limiter-store.js';
import { createInProcessLimiterStore, type LimiterStore } from '../src/net/limiter-store.js';
import {
  createThrottle,
  DeadlineWouldExceedError,
  RateLimitRejectedError,
} from '../src/net/rate-limit.js';
import { DeadlineExceededError } from '../src/net/safe-fetch.js';

/**
 * Task 014-18 — the bucket stops being a process's private state (R-7.1, R-7.2, AC-4, AC-5, AC-20).
 *
 * **What each block is evidence of.** The two spawning cases are the only ones that measure what
 * AC-4 and AC-5 actually claim, because both claims are about a SECOND process. Everything below
 * them measures the arithmetic and the seam, which two processes cannot show and a unit test can.
 *
 * **These are the SQLite-axis cases.** The Postgres axis has the same two criteria, and they are
 * TC-E2E-03/04 in the task: they need a live database, R-21 forbids one in CI, and they run on the
 * stage gate (task 014-34). What IS measured for Postgres in this suite is the statement's
 * arithmetic — `pg-store-parity.test.ts` executes the shipped text against the reversed dialect.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.resolve(packageRoot, 'node_modules/tsx/dist/cli.mjs');
const childEntry = path.resolve(packageRoot, 'test/fixtures/limiter-child.ts');

/** A registered provider, so `provider_buckets.provider` resolves against the bootstrapped rows. */
const PROVIDER = 'defillama';
/** Two tokens, one back every 500 ms — the same bucket `pg-store-parity.test.ts` uses. */
const RATE = { capacity: 2, refillPerSec: 2 };
/** A fixed instant. Every case states its own clock; none reads one. */
const T0 = 1_770_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  // TC-UNIT-01 — its OWN directory, so no case can see another's bucket. A limiter test that
  // depends on test order fails for a reason unrelated to the limiter, and teaches the reader to
  // distrust it.
  dir = mkdtempSync(path.join(tmpdir(), 'onchain-limiter-'));
  dbPath = path.join(dir, 'cache.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the child and returns the tokens it was left with after each take. */
function childTakes(count: number, weight = 1, nowMs = T0): number[] {
  const stdout = execFileSync(
    process.execPath,
    [
      tsxCli,
      childEntry,
      dbPath,
      PROVIDER,
      String(RATE.capacity),
      String(RATE.refillPerSec),
      String(weight),
      String(count),
      String(nowMs),
    ],
    { encoding: 'utf8', cwd: packageRoot },
  );
  return (JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { takes: number[] }).takes;
}

describe('TC-E2E-01 / AC-4: two processes against one DATA_DIR do not each get the full rate', () => {
  it('admits `capacity` slots in total, not `capacity` per process', () => {
    // Both children are handed the same instant, so the refill term is exactly zero however the two
    // interleave: what the bucket admits is decided by the bucket and by nothing else.
    const first = childTakes(RATE.capacity);
    const second = childTakes(RATE.capacity);

    const admitted = [...first, ...second].filter((tokensLeft) => tokensLeft >= 0).length;
    expect(admitted).toBe(RATE.capacity);
    // Said the other way, because the number above is also what a BROKEN limiter can produce by
    // accident: the second process must have been refused every slot, having found the bucket
    // already spent by a process it never spoke to.
    expect(second.every((tokensLeft) => tokensLeft < 0)).toBe(true);
    // And the state that decided it is a row, not a memory.
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare(`SELECT provider, scope_key, tokens FROM provider_buckets`).get()).toEqual({
      provider: PROVIDER,
      scope_key: '',
      tokens: -RATE.capacity,
    });
    db.close();
  });
});

describe('TC-E2E-02 / AC-5: the bucket survives the process that spent it', () => {
  it('a second process starts from what the first left, not from a full bucket', () => {
    const first = childTakes(1);
    expect(first).toEqual([RATE.capacity - 1]);
    // The first process has exited by now — `execFileSync` returned. Everything it knew is gone
    // except the row.
    const second = childTakes(1);
    expect(second).toEqual([RATE.capacity - 2]);
  });

  it('the refill it earns is measured from the instant the FIRST process recorded', () => {
    childTakes(RATE.capacity); // bucket: 0, last_refill_ms: T0
    // 500 ms later exactly one token is owed, so a weight-1 take lands back on zero. The number
    // discriminates both ways of losing the timestamp with the process: refilling from NOW would
    // owe nothing and answer −1, refilling from the epoch would clamp to capacity and answer 1.
    expect(childTakes(1, 1, T0 + 500)).toEqual([0]);
  });
});

describe('the two in-process stores answer identically (AC-20, and the fallback stays faithful)', () => {
  it('the map and the row produce the same sequence for the same inputs', async () => {
    const inProcess = createInProcessLimiterStore();
    const onDisk = createSqliteLimiterStore({ dbPath });
    const key = { providerId: PROVIDER, scopeKey: '' };
    // R-7.7 degrades to the map when the row is unreachable. A degradation that also changed the
    // arithmetic would make the fallback a second limiter rather than the same one, unshared.
    const script: [number, number][] = [
      [1, T0],
      [1, T0],
      [1, T0],
      [2, T0 + 1_000],
      // A wall clock steps backwards on an NTP correction, and both stores must clamp the elapsed
      // term at zero rather than charge this caller for the correction. Without the step, an
      // unclamped SQL refill agrees with the clamped map on every row above.
      [1, T0 - 5_000],
      [1, T0 + 3_600_000],
    ];
    for (const [weight, nowMs] of script) {
      expect(
        await onDisk.take(key, RATE, weight, nowMs),
        `weight ${weight} at ${nowMs}`,
      ).toStrictEqual(await inProcess.take(key, RATE, weight, nowMs));
    }
    onDisk.close();
  });

  it('and so does the refund, including the timestamp it must NOT move', async () => {
    const inProcess = createInProcessLimiterStore();
    const onDisk = createSqliteLimiterStore({ dbPath });
    const key = { providerId: PROVIDER, scopeKey: '' };
    // A slow, deep bucket on purpose: with `RATE` the clamp at capacity absorbs the difference a
    // moved `last_refill_ms` makes, and the case would pass against a store that moved it.
    const slow = { capacity: 10, refillPerSec: 1 };
    for (const store of [inProcess, onDisk]) {
      await store.take(key, slow, 5, T0);
      await store.take(key, slow, 5, T0);
      // Refunded a full second AFTER the take. A store that stamped `last_refill_ms` here would
      // swallow that second, and the take below would find one token fewer than it is owed.
      await store.refund(key, 5, T0 + 1_000);
    }
    expect(await onDisk.take(key, slow, 1, T0 + 2_000)).toStrictEqual(
      await inProcess.take(key, slow, 1, T0 + 2_000),
    );
    // Absolutely, not only against the other store: two stores wrong the same way agree perfectly.
    expect(await onDisk.take(key, slow, 1, T0 + 2_000)).toStrictEqual({
      tokensLeft: 5,
      waitMs: 0,
    });
    onDisk.close();
  });
});

describe('TC-UNIT-03: the injection point survives, and every refusal reaches the store', () => {
  /** Records what the throttle asked of its store, and answers whatever the case dictates. */
  function recordingStore(tokensLeft: number): LimiterStore & { refunds: number[] } {
    const refunds: number[] = [];
    return {
      refunds,
      take: (_key, config) =>
        Promise.resolve({
          tokensLeft,
          waitMs: tokensLeft >= 0 ? 0 : (-tokensLeft / config.refillPerSec) * 1000,
        }),
      refund: (_key, weight) => {
        refunds.push(weight);
        return Promise.resolve();
      },
    };
  }

  it('R-8: the store is a parameter, and the throttle asks it rather than a map', async () => {
    const store = recordingStore(-1);
    const throttle = createThrottle({ now: () => T0, wait: () => Promise.resolve(), store });
    // Admitted after a wait — nothing refunded.
    await throttle(PROVIDER, RATE);
    expect(store.refunds).toEqual([]);
  });

  it('the saturation refusal refunds the FULL weight through the store', async () => {
    // A deficit of 40 tokens against 0.5/sec is an 80 s wait — over the 30 s fairness cap.
    const store = recordingStore(-40);
    const throttle = createThrottle({
      now: () => T0,
      wait: () => Promise.resolve(),
      store,
    });
    await expect(throttle(PROVIDER, { capacity: 50, refillPerSec: 0.5 }, 3)).rejects.toBeInstanceOf(
      RateLimitRejectedError,
    );
    // Three, not one: a partial refund leaks tokens out of the bucket on every rejected weighted
    // call, tightening the limiter a little more each time until it admits nothing.
    expect(store.refunds).toEqual([3]);
  });

  it('both deadline refusals refund, and the post-wake one does not', async () => {
    const spent = { now: T0, wait: () => Promise.resolve() };

    const expired = recordingStore(-1);
    await expect(
      createThrottle({ now: () => T0, wait: spent.wait, store: expired })(
        PROVIDER,
        RATE,
        1,
        T0 - 1,
      ),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(expired.refunds).toEqual([1]);

    const predicted = recordingStore(-1);
    await expect(
      createThrottle({ now: () => T0, wait: spent.wait, store: predicted })(
        PROVIDER,
        RATE,
        1,
        T0 + 5_100,
      ),
    ).rejects.toBeInstanceOf(DeadlineWouldExceedError);
    expect(predicted.refunds).toEqual([1]);

    // The post-wake refusal slept the full wait, so its reservation was earned by elapsed time and
    // is repaid by the next caller's refill. Refunding as well would credit the bucket twice.
    const observed = recordingStore(-1);
    let clock = T0;
    const throttle = createThrottle({
      now: () => clock,
      wait: () => {
        clock += 10_000;
        return Promise.resolve();
      },
      store: observed,
    });
    await expect(throttle(PROVIDER, RATE, 1, T0 + 6_000)).rejects.toBeInstanceOf(
      DeadlineWouldExceedError,
    );
    expect(observed.refunds).toEqual([]);
  });

  it('the deadline is decided against a clock read AFTER the store answered', async () => {
    // §3.4.4: with a shared bucket, `store.take` is a round trip. A budget measured before that
    // trip overstates what is left by however long the trip took, and admitting a wait on that
    // strength is how a caller wakes under the floor and produces the TERMINAL class one layer
    // down — the outcome `DeadlineWouldExceedError` exists to prevent.
    let clock = T0;
    const slowStore: LimiterStore = {
      take: () => {
        clock += 2_000; // the store took two seconds to answer
        return Promise.resolve({ tokensLeft: -1, waitMs: 500 });
      },
      refund: () => Promise.resolve(),
    };
    const throttle = createThrottle({
      now: () => clock,
      wait: () => Promise.resolve(),
      store: slowStore,
    });
    // 6 000 ms of budget at entry. Measured before the trip: 6 000 − 500 = 5 500, over the 5 000
    // floor, admitted. Measured after it: 4 000 − 500 = 3 500, under the floor, refused.
    const refused = await throttle(PROVIDER, RATE, 1, T0 + 6_000).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DeadlineWouldExceedError);
    expect((refused as DeadlineWouldExceedError).phase).toBe('predicted');
    expect((refused as DeadlineWouldExceedError).remainingMs).toBe(4_000);
  });

  it('the `throttle` signature is still the one eleven adapters call', () => {
    const throttle = createThrottle({ now: () => T0, wait: () => Promise.resolve() });
    expect(throttle.length).toBe(2);
  });
});

describe('TC-UNIT-02: nothing here waits on a real clock', () => {
  it('this suite names no wall clock and no timer', () => {
    // The measurement, not the intention: a case that reached for `Date.now()` would make its own
    // result depend on when it ran, which is the defect AC-20 is about. Both stores take the
    // instant as a parameter, so there is never a reason to.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
    // And the child does not either — it is handed its instant on the command line.
    expect(readFileSync(childEntry, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /\bDate\.now\s*\(/,
    );
  });
});
