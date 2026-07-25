import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetStore } from '../src/cache/budget-store.js';
import { createBudgetStore, SqliteBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { adapterRegistrations } from '../src/providers.config.js';

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'onchain-budget-test-'));
  return { dir, dbPath: join(dir, 'cache.sqlite3') };
}

// A fixed instant + its bucket, reused across most cases so the arithmetic itself isn't
// re-derived per test (`dayBucketMs`'s own one-line formula gets its own dedicated coverage
// below).
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);

describe('dayBucketMs (R-34: epoch-ms day-bucket, not a string date)', () => {
  it('floors an epoch-ms instant to the containing day-bucket start', () => {
    expect(dayBucketMs(Date.UTC(2026, 6, 23, 12, 30, 0))).toBe(Date.UTC(2026, 6, 23, 0, 0, 0));
  });

  it('an instant already exactly at a bucket boundary maps to itself', () => {
    const boundary = Date.UTC(2026, 6, 23, 0, 0, 0);
    expect(dayBucketMs(boundary)).toBe(boundary);
  });

  it('two instants in the same UTC day map to the identical bucket', () => {
    expect(dayBucketMs(Date.UTC(2026, 6, 23, 0, 0, 1))).toBe(
      dayBucketMs(Date.UTC(2026, 6, 23, 23, 59, 59)),
    );
  });
});

describe('SqliteBudgetStore (task 005-2, R-34/R-35)', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteBudgetStore;

  beforeEach(() => {
    ({ dir, dbPath } = tempDbPath());
    store = new SqliteBudgetStore({ dbPath, providers: adapterRegistrations });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-UNIT-01: two recordDelta(+5) calls in the same bucket SUM to 10, not overwrite to 5', async () => {
    await store.recordDelta('nansen', BUCKET, 5);
    await store.recordDelta('nansen', BUCKET, 5);
    expect(await store.getUsage('nansen', BUCKET)).toBe(10);
  });

  it('TC-UNIT-02: a signed (negative) delta subtracts from the accumulated total', async () => {
    await store.recordDelta('nansen', BUCKET, 10);
    await store.recordDelta('nansen', BUCKET, -4);
    expect(await store.getUsage('nansen', BUCKET)).toBe(6);
  });

  it('TC-UNIT-03: MAX(0, …) clamps the counter at 0, never negative', async () => {
    await store.recordDelta('nansen', BUCKET, 3);
    await store.recordDelta('nansen', BUCKET, -10);
    expect(await store.getUsage('nansen', BUCKET)).toBe(0);
  });

  it('TC-UNIT-04: different day-buckets and different providers are independent counters', async () => {
    const otherBucket = BUCKET + 86_400_000;
    await store.recordDelta('nansen', BUCKET, 7);
    await store.recordDelta('nansen', otherBucket, 1);
    await store.recordDelta('dune', BUCKET, 2);

    expect(await store.getUsage('nansen', BUCKET)).toBe(7);
    expect(await store.getUsage('nansen', otherBucket)).toBe(1);
    expect(await store.getUsage('dune', BUCKET)).toBe(2);
  });

  it('TC-UNIT-05: a refused checkAndReserve writes NOTHING (usage identical before/after)', async () => {
    const before = await store.getUsage('nansen', BUCKET);
    const result = await store.checkAndReserve('nansen', BUCKET, 150, 100);
    const after = await store.getUsage('nansen', BUCKET);

    expect(result).toEqual({ ok: false, reason: expect.any(String) });
    expect(after).toBe(before);
  });

  it("TC-UNIT-06: FK is enforced on the store's OWN connection (recordDelta for an unregistered provider throws)", async () => {
    await expect(store.recordDelta('not-a-real-provider', BUCKET, 1)).rejects.toThrow();
  });

  it('TC-UNIT-07: a standalone SqliteBudgetStore (no SqliteCacheStore involved) self-bootstraps providers and writes usage', async () => {
    const standalone = new SqliteBudgetStore({ dbPath: ':memory:' });
    await standalone.recordDelta('nansen', BUCKET, 3);
    expect(await standalone.getUsage('nansen', BUCKET)).toBe(3);
  });

  it('TC-UNIT-08: two concurrent checkAndReserve calls that together exceed the ceiling yield exactly one ok:true', async () => {
    const [first, second] = await Promise.all([
      store.checkAndReserve('nansen', BUCKET, 60, 100),
      store.checkAndReserve('nansen', BUCKET, 60, 100),
    ]);

    const results = [first, second];
    const oks = results.filter((r) => r.ok);
    const fails = results.filter((r) => !r.ok);

    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(await store.getUsage('nansen', BUCKET)).toBe(60);
  });

  it('TC-UNIT-09: used + cost === ceiling passes (<=, not <)', async () => {
    await store.recordDelta('nansen', BUCKET, 40);
    const result = await store.checkAndReserve('nansen', BUCKET, 60, 100);
    expect(result).toEqual({ ok: true });
    expect(await store.getUsage('nansen', BUCKET)).toBe(100);
  });

  it('a successful checkAndReserve additively reserves cost (visible via getUsage)', async () => {
    const result = await store.checkAndReserve('nansen', BUCKET, 25, 100);
    expect(result).toEqual({ ok: true });
    expect(await store.getUsage('nansen', BUCKET)).toBe(25);
  });

  it('getUsage returns 0 for a (provider, bucket) with no writes yet', async () => {
    expect(await store.getUsage('nansen', BUCKET)).toBe(0);
  });

  // cycle-4 verification pass, security F-6: `used + cost > ceiling` is FALSE — i.e. approved —
  // whenever the comparison cannot decide. A money guard must refuse in that case, not spend.
  describe('checkAndReserve fails CLOSED on an undecidable comparison', () => {
    it('refuses an unpriced (Infinity) cost even against an unbounded ceiling', async () => {
      // `costOf()` returns +Infinity for a capability it cannot price — deliberately fail-closed.
      // Against a +Infinity ceiling the bare `>` would have been `Infinity > Infinity === false`,
      // i.e. an unpriced paid call APPROVED. That is the one pair that slipped through.
      const result = await store.checkAndReserve(
        'nansen',
        BUCKET,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
      expect(result.ok).toBe(false);
      expect(await store.getUsage('nansen', BUCKET)).toBe(0);
    });

    it('refuses a NaN ceiling rather than treating it as unbounded', async () => {
      const result = await store.checkAndReserve('nansen', BUCKET, 10, Number.NaN);
      expect(result.ok).toBe(false);
      expect(await store.getUsage('nansen', BUCKET)).toBe(0);
    });

    it('still honours +Infinity as the explicit "no self-imposed ceiling" sentinel', async () => {
      // The narrow guard must not break the unbounded contract the reconcile suite relies on.
      const result = await store.checkAndReserve('nansen', BUCKET, 10, Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(true);
      expect(await store.getUsage('nansen', BUCKET)).toBe(10);
    });
  });
});

describe('createBudgetStore factory (task 005-2 — same factory-not-singleton principle as createCacheStore)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = tempDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('assembles a working BudgetStore, bootstrapped with the real adapterRegistrations by default', async () => {
    const store: BudgetStore = createBudgetStore({ dbPath });
    await store.recordDelta('nansen', BUCKET, 9);
    expect(await store.getUsage('nansen', BUCKET)).toBe(9);
  });
});
