import { describe, expect, it } from 'vitest';
import { SqliteBudgetStore } from '../src/cache/budget-store.js';
import {
  DAILY_CAP_OFF,
  MAX_CALLS_OFF,
  VELOCITY_OFF,
  VELOCITY_WINDOW_MS,
  createNansenBudgetGate,
  deriveVelocityCap,
  velocityWindowMs,
  NansenBudgetExceededError,
} from '../src/adapters/nansen/budget-gate.js';
import { createNansenAccountState } from '../src/adapters/nansen/account-state.js';
import { createThrottle } from '../src/net/rate-limit.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';

/**
 * SEC-1 — the daily cap bounds damage per day; nothing bounded the RATE.
 *
 * The throttle sustains ~5 paid calls/second ≈ 50 credits/second, so a 2500-credit daily cap was
 * consumable in under a minute by a runaway loop. That is not an over-spend — the ceiling held —
 * but it removes any chance for a human to notice, which for an operator is indistinguishable from
 * a leak. These tests are about the BRAKE: that it stops a burst, that it stops it across
 * processes, and that it never makes a legitimate call impossible.
 */
const PROVIDER = 'nansen';
const DAY = dayBucketMs(1_784_800_000_000);
const WINDOW = velocityWindowMs(1_784_800_000_000);

function store(): SqliteBudgetStore {
  return new SqliteBudgetStore({
    dbPath: ':memory:',
    providers: [{ id: PROVIDER, hosts: ['api.nansen.ai'], rateLimit: { rps: 1 } }] as never,
  });
}

describe('the brake stops a burst that the daily ceiling would have allowed', () => {
  it('refuses once the window is full, while the DAY still has plenty of room', async () => {
    const budget = store();
    try {
      // Day allows 2500; the window allows 100. Ten 10-credit calls fill the window and the
      // eleventh is refused — with 2400 credits of daily budget untouched.
      for (let i = 0; i < 10; i += 1) {
        const result = await budget.checkAndReserve(PROVIDER, DAY, 10, 2500, {
          windowStartMs: WINDOW,
          ceiling: 100,
        });
        expect(result.ok, `call ${i}`).toBe(true);
      }

      const refused = await budget.checkAndReserve(PROVIDER, DAY, 10, 2500, {
        windowStartMs: WINDOW,
        ceiling: 100,
      });
      expect(refused.ok).toBe(false);
      expect(refused.ok ? '' : refused.reason).toContain('velocity limit reached');

      expect(await budget.getUsage(PROVIDER, DAY)).toBe(100);
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(100);
    } finally {
      budget.close();
    }
  });

  it('writes NOTHING when it refuses — neither counter moves', async () => {
    const budget = store();
    try {
      await budget.checkAndReserve(PROVIDER, DAY, 90, 2500, {
        windowStartMs: WINDOW,
        ceiling: 100,
      });
      const before = {
        day: await budget.getUsage(PROVIDER, DAY),
        window: await budget.getWindowUsage(PROVIDER, WINDOW),
      };

      const refused = await budget.checkAndReserve(PROVIDER, DAY, 20, 2500, {
        windowStartMs: WINDOW,
        ceiling: 100,
      });
      expect(refused.ok).toBe(false);

      // A refusal that had already charged the day would be worse than no brake at all.
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(before.day);
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(before.window);
    } finally {
      budget.close();
    }
  });

  it('the next window starts empty', async () => {
    const budget = store();
    try {
      await budget.checkAndReserve(PROVIDER, DAY, 100, 2500, {
        windowStartMs: WINDOW,
        ceiling: 100,
      });
      const next = await budget.checkAndReserve(PROVIDER, DAY, 100, 2500, {
        windowStartMs: WINDOW + VELOCITY_WINDOW_MS,
        ceiling: 100,
      });
      expect(next.ok).toBe(true);
      // The day keeps accumulating across windows — the two limits are independent.
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(200);
    } finally {
      budget.close();
    }
  });

  it('the DAILY ceiling still binds first when it is the tighter of the two', async () => {
    const budget = store();
    try {
      const refused = await budget.checkAndReserve(PROVIDER, DAY, 30, 20, {
        windowStartMs: WINDOW,
        ceiling: 1000,
      });
      expect(refused.ok).toBe(false);
      // The reason must name the DAY, not the window — the two call for opposite operator actions.
      expect(refused.ok ? '' : refused.reason).toContain('budget exceeded');
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(0);
    } finally {
      budget.close();
    }
  });
});

describe('the window check shares the reservation transaction', () => {
  it('two independent connections to one file cannot both pass the same window', async () => {
    // The issue names this explicitly: an in-memory limiter, or one checked outside the
    // reservation transaction, is defeated by two processes racing on a shared cache.sqlite3 —
    // a supported topology (several stdio sessions per machine), not an exotic one.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'sec1-'));
    const dbPath = path.join(dir, 'cache.sqlite3');
    const providers = [{ id: PROVIDER, hosts: ['api.nansen.ai'], rateLimit: { rps: 1 } }] as never;
    const a = new SqliteBudgetStore({ dbPath, providers });
    const b = new SqliteBudgetStore({ dbPath, providers });
    try {
      const limit = { windowStartMs: WINDOW, ceiling: 100 };
      const first = await a.checkAndReserve(PROVIDER, DAY, 60, 2500, limit);
      const second = await b.checkAndReserve(PROVIDER, DAY, 60, 2500, limit);

      expect(first.ok).toBe(true);
      // The second connection reads the FIRST one's committed reservation, not a stale snapshot.
      expect(second.ok).toBe(false);
      expect(await a.getWindowUsage(PROVIDER, WINDOW)).toBe(60);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a refund returns credits to the window that actually spent them', () => {
  it('mirrors a negative delta into the reservation’s own window', async () => {
    const budget = store();
    try {
      await budget.checkAndReserve(PROVIDER, DAY, 10, 2500, {
        windowStartMs: WINDOW,
        ceiling: 100,
      });
      await budget.recordDelta(PROVIDER, DAY, -6, WINDOW);

      expect(await budget.getUsage(PROVIDER, DAY)).toBe(4);
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(4);
    } finally {
      budget.close();
    }
  });

  it('leaves the window alone when no window is named (guard off)', async () => {
    const budget = store();
    try {
      await budget.checkAndReserve(PROVIDER, DAY, 10, 2500);
      await budget.recordDelta(PROVIDER, DAY, -4);
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(6);
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(0);
    } finally {
      budget.close();
    }
  });
});

describe('the derived limit', () => {
  it('never falls below the price of the dearest single call', () => {
    // A limit under 100 would make the exhaustive `entity.labels` tier structurally impossible
    // rather than rate-limited — a worse failure than the one the guard prevents.
    expect(deriveVelocityCap(30)).toBe(100);
    expect(deriveVelocityCap(0)).toBe(100);
  });

  it('gives a full day at least ~20 minutes of sustained spending', () => {
    for (const ceiling of [2500, 10_000, 100_000]) {
      const perWindow = deriveVelocityCap(ceiling);
      const windowsToBurn = ceiling / perWindow;
      expect(windowsToBurn, `ceiling ${ceiling}`).toBeGreaterThanOrEqual(20);
    }
  });

  it('is defined even when the ceiling is not a finite number', () => {
    expect(deriveVelocityCap(Number.POSITIVE_INFINITY)).toBe(100);
    expect(deriveVelocityCap(Number.NaN)).toBe(100);
  });
});

describe('ensureBudget — the refusal is distinguishable and actionable', () => {
  function gate(velocityCap: number | typeof VELOCITY_OFF | undefined, budget: SqliteBudgetStore) {
    const accountState = createNansenAccountState();
    return createNansenBudgetGate({
      budgetStore: budget,
      accountState,
      dailyCreditCap: DAILY_CAP_OFF,
      ...(velocityCap === undefined ? {} : { velocityCap }),
      now: () => 1_784_800_000_000,
      env: { NANSEN_API_KEY: 'not-a-real-key' },
      throttle: createThrottle(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ plan: 'pro', credits_remaining: 100_000 }), { status: 200 }),
    });
  }

  it('names the VELOCITY limit, says the daily budget is intact, and how to change it', async () => {
    const budget = store();
    try {
      const { ensureBudget } = gate(10, budget);
      await ensureBudget('token.risk', { chain: 'ethereum', tokenAddress: '0xabc' });

      const thrown = await ensureBudget('token.risk', {
        chain: 'ethereum',
        tokenAddress: '0xabc',
      }).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(thrown).toBeInstanceOf(NansenBudgetExceededError);
      // An operator who cannot tell this from the daily refusal will raise the wrong ceiling.
      expect(thrown!.message).toContain('velocity limit');
      expect(thrown!.message).toContain('DAILY budget is not exhausted');
      expect(thrown!.message).toContain('NANSEN_VELOCITY_CREDITS_PER_MIN');
    } finally {
      budget.close();
    }
  });

  it('the CREDIT brake is switchable off without switching off the CALL limit', async () => {
    // CHANGED EXPECTATION (Q-3): turning the credit brake off no longer means "no window row".
    // The two denominators are independent — the call counter still writes, because a zero-credit
    // call is invisible to any credit-denominated limit and the call limit is the only bound that
    // can see it. What `VELOCITY_OFF` buys is that the CREDIT comparison never refuses.
    const budget = store();
    try {
      const { ensureBudget } = gate(VELOCITY_OFF, budget);
      for (let i = 0; i < 40; i += 1) {
        await ensureBudget('token.risk', { chain: 'ethereum', tokenAddress: '0xabc' });
      }
      // 40 × 6cr = 240, far past any derived credit allowance — and not refused.
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(240);
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(40);
    } finally {
      budget.close();
    }
  });

  it('with BOTH off, nothing is written to the window at all (pre-guard behaviour)', async () => {
    const budget = store();
    try {
      const accountState = createNansenAccountState();
      const { ensureBudget } = createNansenBudgetGate({
        budgetStore: budget,
        accountState,
        dailyCreditCap: DAILY_CAP_OFF,
        velocityCap: VELOCITY_OFF,
        maxCallsPerWindow: MAX_CALLS_OFF,
        now: () => 1_784_800_000_000,
        env: { NANSEN_API_KEY: 'not-a-real-key' },
        throttle: createThrottle(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ plan: 'pro', credits_remaining: 100_000 }), {
            status: 200,
          }),
      });
      const reservation = await ensureBudget('token.risk', {
        chain: 'ethereum',
        tokenAddress: '0xabc',
      });

      expect(reservation.window).toBeUndefined();
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(0);
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(0);
      // The DAY ledger still records it — the two window guards being off changes nothing there.
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(6);
    } finally {
      budget.close();
    }
  });

  it('reports the window it reserved in, so reconciliation can refund into it', async () => {
    const budget = store();
    try {
      const { ensureBudget } = gate(undefined, budget);
      const reservation = await ensureBudget('token.risk', {
        chain: 'ethereum',
        tokenAddress: '0xabc',
      });
      expect(reservation.window).toBe(velocityWindowMs(1_784_800_000_000));
    } finally {
      budget.close();
    }
  });
});

describe('Q-3 — the call limit is the only bound a ZERO-credit tier can hit', () => {
  it('the premise: a 0-cost call passes ANY credit ceiling, however low', async () => {
    const budget = store();
    try {
      // The mechanism, asserted directly. `used + 0 > ceiling` is false even against a ceiling of
      // zero, for the whole life of the bucket. This is not a bug in the ceiling — it is what
      // "denominated in credits" means, which is why the fix had to be a different unit.
      for (let i = 0; i < 50; i += 1) {
        const result = await budget.checkAndReserve(PROVIDER, DAY, 0, 0, {
          windowStartMs: WINDOW,
          ceiling: 0,
        });
        expect(result.ok, `call ${i}`).toBe(true);
      }
    } finally {
      budget.close();
    }
  });

  it('bounds exactly that traffic once a call limit is supplied', async () => {
    const budget = store();
    try {
      const limit = { windowStartMs: WINDOW, ceiling: 0, maxCalls: 5 };
      for (let i = 0; i < 5; i += 1) {
        expect((await budget.checkAndReserve(PROVIDER, DAY, 0, 0, limit)).ok, `call ${i}`).toBe(
          true,
        );
      }
      const refused = await budget.checkAndReserve(PROVIDER, DAY, 0, 0, limit);
      expect(refused.ok).toBe(false);
      expect(refused.ok ? '' : refused.reason).toContain('call rate limit reached');
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(5);
    } finally {
      budget.close();
    }
  });

  it('a CALL is not refundable, unlike a credit', async () => {
    // The vendor round trip happened. Refunding the count would let a run of cheap-then-refunded
    // calls walk straight past the limit that exists to bound that traffic.
    const budget = store();
    try {
      await budget.checkAndReserve(PROVIDER, DAY, 10, 2500, {
        windowStartMs: WINDOW,
        ceiling: 1000,
        maxCalls: 5,
      });
      await budget.recordDelta(PROVIDER, DAY, -10, WINDOW);

      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(0); // credits fully refunded
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(1); // the call still counted
    } finally {
      budget.close();
    }
  });

  it('refuses without writing either counter', async () => {
    const budget = store();
    try {
      const limit = { windowStartMs: WINDOW, ceiling: 1000, maxCalls: 1 };
      await budget.checkAndReserve(PROVIDER, DAY, 7, 2500, limit);
      const refused = await budget.checkAndReserve(PROVIDER, DAY, 7, 2500, limit);

      expect(refused.ok).toBe(false);
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(1);
      expect(await budget.getWindowUsage(PROVIDER, WINDOW)).toBe(7);
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(7);
    } finally {
      budget.close();
    }
  });

  it('the additive column migration is idempotent and preserves existing rows', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'q3-'));
    const dbPath = path.join(dir, 'cache.sqlite3');
    const providers = [{ id: PROVIDER, hosts: ['api.nansen.ai'], rateLimit: { rps: 1 } }] as never;
    try {
      const first = new SqliteBudgetStore({ dbPath, providers });
      await first.checkAndReserve(PROVIDER, DAY, 12, 2500, {
        windowStartMs: WINDOW,
        ceiling: 1000,
        maxCalls: 10,
      });
      first.close();

      // Re-opening runs the DDL and the migration again on a file that already has both.
      const second = new SqliteBudgetStore({ dbPath, providers });
      expect(await second.getWindowUsage(PROVIDER, WINDOW)).toBe(12);
      expect(await second.getWindowCalls(PROVIDER, WINDOW)).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ensureBudget refusal says it counts CALLS and that credits will not help', async () => {
    const budget = store();
    try {
      const accountState = createNansenAccountState();
      const { ensureBudget } = createNansenBudgetGate({
        budgetStore: budget,
        accountState,
        dailyCreditCap: DAILY_CAP_OFF,
        velocityCap: VELOCITY_OFF,
        maxCallsPerWindow: 2,
        now: () => 1_784_800_000_000,
        env: { NANSEN_API_KEY: 'not-a-real-key' },
        throttle: createThrottle(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ plan: 'pro', credits_remaining: 100_000 }), {
            status: 200,
          }),
      });

      await ensureBudget('entity.labels', { chain: 'ethereum', query: 'a' });
      await ensureBudget('entity.labels', { chain: 'ethereum', query: 'b' });
      const thrown = await ensureBudget('entity.labels', { chain: 'ethereum', query: 'c' }).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(thrown).toBeInstanceOf(NansenBudgetExceededError);
      expect(thrown!.message).toContain('call rate limit');
      expect(thrown!.message).toContain('counts CALLS, not credits');
      expect(thrown!.message).toContain('NANSEN_MAX_CALLS_PER_MIN');
      // The whole point: these three calls cost ZERO credits, so no credit ledger moved at all.
      expect(await budget.getUsage(PROVIDER, DAY)).toBe(0);
      expect(await budget.getWindowCalls(PROVIDER, WINDOW)).toBe(2);
    } finally {
      budget.close();
    }
  });
});
