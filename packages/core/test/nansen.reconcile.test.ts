import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNansenAccountState } from '../src/adapters/nansen/account-state.js';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import {
  NansenPaymentRequiredError,
  type NansenEndpointResult,
} from '../src/adapters/nansen/endpoints.js';
import { reconcile } from '../src/adapters/nansen/reconcile.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { createThrottle } from '../src/net/rate-limit.js';

// Post-call credit reconciliation (task 005-5, R-38). TC-UNIT-01..04/07 exercise `reconcile()`
// directly against a real in-memory `BudgetStore` (`checkAndReserve` first, to seed the exact
// `usage` row a real `ensureBudget()` reservation would have written, then `reconcile()`, then
// `getUsage`). TC-UNIT-05/06 exercise the FULL composed `adapter.fetch()` (transport-failure/402
// on a sub-call never reaches `reconcile()` at all — that's index.ts's own composition, not
// something a direct `reconcile()` unit test can prove). No live Nansen credits anywhere — every
// network call goes through an injected `fetchImpl`, and the throttle uses a real-timer-free fake
// clock (this task's own "Живые кредиты: 0").

const PROVIDER = 'nansen';
const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);

function subResponse(creditsUsedHeader: string | null): NansenEndpointResult {
  return { body: {}, creditsUsedHeader };
}

describe('reconcile() — direct unit tests (R-38 summation/degrade/bucket-binding)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // TC-UNIT-01 — direct test on defect C-1: per-response reconciliation would record
  // (5-10) + (5-10) = -10 across TWO recordDelta calls; the real invariant is ONE call, delta 0.
  it('TC-UNIT-01 (composite success): two 5cr sub-responses against a 10cr reservation -> exactly one recordDelta(0), getUsage stays 10', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('5'), subResponse('5')],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledWith(PROVIDER, BUCKET, 0);
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(10);
    expect(accountState.isUnreconciled()).toBe(false);
  });

  // TC-UNIT-02
  it('TC-UNIT-02 (actual != reserved, over): headers 5+8=13 against reservedTotal 10 -> recordDelta(+3), getUsage becomes 13', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('5'), subResponse('8')],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(13);
  });

  // TC-UNIT-03 — negative delta case (carried-over reviewer note from 005-2: MAX(0,...) applies to
  // the upsert's DO-UPDATE branch, and this always follows a reservation that created the row).
  it('TC-UNIT-03 (negative delta): headers 2+2=4 against reservedTotal 10 -> recordDelta(-6), getUsage becomes 4 (>=0)', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('2'), subResponse('2')],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(4);
  });

  // TC-UNIT-04 — a missing header on ANY sub-response degrades the WHOLE call to delta=0, never a
  // partial sum (a partial sum here would be 5-10=-5, systematically under-counting the true spend).
  it('TC-UNIT-04 (one header missing): degrades the WHOLE reconciliation to delta=0 (never -5) + markUnreconciled + one stderr line', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('5'), subResponse(null)],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledWith(PROVIDER, BUCKET, 0);
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(10);
    expect(accountState.isUnreconciled()).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('TC-UNIT-04b (one header unparseable, not just absent): same fail-safe degrade path', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('5'), subResponse('not-a-number')],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(recordDeltaSpy).toHaveBeenCalledWith(PROVIDER, BUCKET, 0);
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(10);
    expect(accountState.isUnreconciled()).toBe(true);
  });

  // M-1 (adversarial review cycle 1) — domain validation, not just Number.isFinite(). Each of
  // these headers is individually "finite" once Number()-coerced, which is exactly why the old
  // check silently accepted them as truth (empty/whitespace -> 0, "-600" wipes other calls'
  // legitimately recorded spend, "1e21" self-DoSes the bucket) — all five must degrade to the same
  // fail-safe delta=0 + markUnreconciled() + one stderr line path as a missing/unparseable header.
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['negative integer', '-600'],
    ['absurdly large (unsafe range)', '1e21'],
    ['non-integer', '5.5'],
  ])(
    'M-1: %s header degrades to delta=0 + markUnreconciled + one stderr line, usage unchanged',
    async (_label, headerValue) => {
      const budgetStore = createBudgetStore({ dbPath: ':memory:' });
      const accountState = createNansenAccountState();
      const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
      await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

      await reconcile({
        subResponses: [subResponse('5'), subResponse(headerValue)],
        reservedTotal: 10,
        bucket: BUCKET,
        budgetStore,
        accountState,
      });

      expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
      expect(recordDeltaSpy).toHaveBeenCalledWith(PROVIDER, BUCKET, 0);
      expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(10); // reservation, untouched
      expect(accountState.isUnreconciled()).toBe(true);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    },
  );

  // M-1 — a full refund is a signal, not a fact: every header parses as a valid non-negative
  // integer and STILL sums to 0 against a paid (reservedTotal > 0) reservation. The delta IS still
  // written (the headers themselves were individually valid — this is not the degrade path), but
  // markUnreconciled() fires + one stderr line, forcing a resync before the next call.
  it('M-1: headers cleanly parse but sum to a FULL refund (0 against reservedTotal=10) -> delta still written, but markUnreconciled + one stderr line', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    await budgetStore.checkAndReserve(PROVIDER, BUCKET, 10, Number.POSITIVE_INFINITY);

    await reconcile({
      subResponses: [subResponse('0'), subResponse('0')],
      reservedTotal: 10,
      bucket: BUCKET,
      budgetStore,
      accountState,
    });

    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledWith(PROVIDER, BUCKET, -10);
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(0);
    expect(accountState.isUnreconciled()).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('FULL refund');
  });

  // TC-UNIT-07 — bucket binding: reconcile() must write to the `bucket` PARAMETER, never a bucket
  // recomputed from Date.now() at reconcile time (a cross-midnight response would otherwise write a
  // negative delta into the WRONG day's row).
  it('TC-UNIT-07 (bucket binding through midnight): writes to the passed bucket, never a Date.now()-recomputed one', async () => {
    const lateNight = Date.UTC(2026, 6, 23, 23, 59, 59, 800);
    const earlyNextDay = Date.UTC(2026, 6, 24, 0, 0, 0, 200);
    const d1 = dayBucketMs(lateNight);
    const d2 = dayBucketMs(earlyNextDay);
    expect(d1).not.toBe(d2); // sanity: they really do differ

    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    await budgetStore.checkAndReserve(PROVIDER, d1, 10, Number.POSITIVE_INFINITY);

    // Simulate the wall clock having advanced past midnight by the time this reconciliation runs —
    // reconcile() must be completely immune to this: it never reads Date.now() itself, only `bucket`.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(earlyNextDay);
    try {
      await reconcile({
        subResponses: [subResponse('5'), subResponse('5')],
        reservedTotal: 10,
        bucket: d1,
        budgetStore,
        accountState,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(await budgetStore.getUsage(PROVIDER, d1)).toBe(10);
    expect(await budgetStore.getUsage(PROVIDER, d2)).toBe(0);
  });
});

/** Real-timer-free token-bucket clock (mirrors test/rate-limit.test.ts's own `fakeClock()`) — these
 * integration tests below issue several sub-calls per `fetch()`, sometimes across TWO calls in one
 * test, which would otherwise burn real wall-clock time against the 5-capacity/1-per-second `nansen`
 * rate limit (`providers.config.ts`). */
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

describe('fetch() composition — transport-failure/402 resync path (task 005-5, R-38, UC-6)', () => {
  const UNI_ADDRESS = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

  // TC-UNIT-05 — M-2(b) (adversarial review cycle 1) supersedes this test's ORIGINAL assertion
  // ("reconcile() never runs, the full 10cr reservation stays a phantom charge forever"): that was
  // exactly the money-leak M-2 fixes. `performSubCalls` now surfaces the ONE sub-call that DID
  // complete (netflow, 5cr) before holders threw, so `reconcile()` DOES run (from the catch) with
  // that partial set — refunding the unspent 5cr instead of leaving the full 10cr reserved forever.
  it('TC-UNIT-05 (transport failure, M-2(b) fixed): partial reconcile refunds the unspent leg — usage reflects only the sub-call that actually completed, next gate entry still forces a fresh /account resync', async () => {
    const calls: string[] = [];
    let holdersCallCount = 0;
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname === '/api/v1/account') {
        return jsonResponse({ plan: 'free', credits_remaining: 100000 });
      }
      if (pathname === '/api/v1/smart-money/netflow') {
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      if (pathname === '/api/v1/tgm/holders') {
        holdersCallCount += 1;
        if (holdersCallCount === 1) {
          throw new Error('simulated network failure');
        }
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      throw new Error(`unrouted test call to ${pathname}`);
    };
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl,
      now: () => NOW,
      throttle: createThrottle(fakeClock()),
      budgetStore,
    });
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    await expect(adapter.fetch('smart-money.flows', args)).rejects.toThrow(
      /simulated network failure/,
    );

    // reconcile() DID run from the catch, with subResponses=[netflow(5cr)] against reservedTotal
    // 10 -> delta -5 (refunds the unspent holders leg): 10 (reservation) - 5 (refund) = 5.
    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledWith('nansen', BUCKET, -5);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(5);

    // The forced resync (markUnreconciled -> next ensureBudget() entry) is proven by a SECOND
    // /api/v1/account GET on the very next call — a merely same-bucket, already-reconciled snapshot
    // would have skipped it entirely (budget-gate.ts's own needsResync()).
    const accountCallsBefore = calls.filter((p) => p === '/api/v1/account').length;
    await adapter.fetch('smart-money.flows', args);
    const accountCallsAfter = calls.filter((p) => p === '/api/v1/account').length;
    expect(accountCallsAfter).toBe(accountCallsBefore + 1);
    // Second (successful) call: +10 reservation, then a normal delta-0 reconcile (both sub-calls
    // completed with their real 5cr headers) -> 5 (from the first call's refund) + 10 = 15.
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(15);
  });

  // vdd-multi cycle 4, logic L-3 + L-4 — the success-path `await reconcile(...)`.
  it('cycle-4 L-3/L-4: a ledger-write failure AFTER a paid call keeps the result and still forces a resync', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname === '/api/v1/account') {
        return jsonResponse({ plan: 'free', credits_remaining: 100000 });
      }
      if (pathname === '/api/v1/smart-money/netflow' || pathname === '/api/v1/tgm/holders') {
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      throw new Error(`unrouted test call to ${pathname}`);
    };
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    // `SQLITE_BUSY` past the 5s busy timeout is the realistic shape — budget-store.ts explicitly
    // designs for several stdio sessions sharing one cache.sqlite3.
    vi.spyOn(budgetStore, 'recordDelta').mockRejectedValue(
      new Error('SQLITE_BUSY: database is locked'),
    );
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl,
      now: () => NOW,
      throttle: createThrottle(fakeClock()),
      budgetStore,
    });
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    // (L-4) The credits are already spent and the result is valid. Letting the bookkeeping write
    // propagate made registry.ts record the adapter as failed, cache nothing, and the agent's retry
    // pay the full cost again — the post-payment-throw class normalize.ts was hardened against
    // three times, left open on the last step.
    await expect(adapter.fetch('smart-money.flows', args)).resolves.toBeDefined();

    // The reservation stays charged — never a phantom refund.
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(10);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ledger write failed'));

    // (L-3) `markUnreconciled()` used to live only in the "reconcile never ran" branch, so in
    // exactly the case its own comment described it never fired. The forced resync is what
    // self-corrects the ledger against the vendor's authoritative remainder.
    const before = calls.filter((p) => p === '/api/v1/account').length;
    await adapter.fetch('smart-money.flows', args);
    expect(calls.filter((p) => p === '/api/v1/account').length).toBe(before + 1);
    stderrSpy.mockRestore();
  });

  // TC-UNIT-06 — same M-2(b) supersession as TC-UNIT-05 above, for the 402 path specifically.
  it('TC-UNIT-06 (402, M-2(b) fixed): partial reconcile refunds the unspent leg — every subsequent gate entry keeps forcing its own fresh resync', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname === '/api/v1/account') {
        return jsonResponse({ plan: 'free', credits_remaining: 100000 });
      }
      if (pathname === '/api/v1/smart-money/netflow') {
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      if (pathname === '/api/v1/tgm/holders') {
        return jsonResponse(null, 402);
      }
      throw new Error(`unrouted test call to ${pathname}`);
    };
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl,
      now: () => NOW,
      throttle: createThrottle(fakeClock()),
      budgetStore,
    });
    const args = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

    await expect(adapter.fetch('smart-money.flows', args)).rejects.toBeInstanceOf(
      NansenPaymentRequiredError,
    );
    expect(recordDeltaSpy).toHaveBeenCalledTimes(1);
    expect(recordDeltaSpy).toHaveBeenCalledWith('nansen', BUCKET, -5);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(5);

    // A second attempt still 402s on holders (same fixture) — but it must have taken its OWN fresh
    // /account resync first (proof that markUnreconciled from the first failure forced it, and that
    // clearUnreconciled only ever follows a genuinely successful resync — this second attempt's own
    // resync succeeds, its holders sub-call then fails again, so markUnreconciled fires once more).
    const accountCallsBefore = calls.filter((p) => p === '/api/v1/account').length;
    await expect(adapter.fetch('smart-money.flows', args)).rejects.toBeInstanceOf(
      NansenPaymentRequiredError,
    );
    const accountCallsAfter = calls.filter((p) => p === '/api/v1/account').length;
    expect(accountCallsAfter).toBe(accountCallsBefore + 1);
    // Second 402 attempt: +10 reservation then another partial refund (-5) -> 5 + 10 - 5 = 10.
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(10);
  });
});

describe('fetch() — OQ-2 structural non-bypassability (code review round 2, task 005-5; M-6, adversarial review cycle 1)', () => {
  // Code review finding: with `budgetStore` omitted and `fetchImpl` ALSO omitted, the ungated
  // fallback branch used to resolve `endpointDeps.fetchImpl = deps.fetchImpl ?? fetch` to the REAL
  // global `fetch` — a genuinely paid Nansen call with ZERO budget accounting, silently (no throw,
  // no stderr). This is the exact money-leak system-architecture.md §3.2 OQ-2's "structurally
  // non-bypassable" decision forbids. **M-6 supersedes the ORIGINAL fix here:** that branch used to
  // throw unless `fetchImpl` was ALSO explicitly injected — proven an insufficient signal in-repo
  // (`scripts/record-fixture.mjs` injects a `fetchImpl` that wraps the REAL global `fetch`); the
  // guard now requires the EXPLICIT `__ungatedForTestsOnly: true` opt-in instead, never inferred
  // from `fetchImpl` presence alone.
  it('refuses an ungated paid call when both budgetStore AND __ungatedForTestsOnly are omitted — the real transport is never reached', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error(
        'TEST BUG: real fetch() must never be reached — the OQ-2 guard should have refused first',
      );
    });

    try {
      // A REAL-looking key (isAvailable() would report {ok: true}) — deliberately proving the
      // guard fires on the (budgetStore, fetchImpl) shape alone, not on any key-based signal.
      const adapter = createNansenAdapter({ env: { NANSEN_API_KEY: 'test-key-not-real' } });

      await expect(
        adapter.fetch('smart-money.flows', {
          chain: 'ethereum',
          tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
        }),
      ).rejects.toThrow(/refusing an ungated paid call/);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // M-6 (adversarial review cycle 1) — the OLD, insufficient signal: `fetchImpl` injected, but the
  // NEW explicit opt-in flag omitted. Must still refuse — this is exactly the shape
  // `scripts/record-fixture.mjs` uses (a `fetchImpl` wrapping the REAL global `fetch`) if a future
  // caller forgot to also supply `budgetStore`.
  it('M-6: refuses even WITH a fetchImpl injected, when __ungatedForTestsOnly is not explicitly set', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error(
        'TEST BUG: transport must never be reached — the M-6 guard should refuse first',
      );
    };
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl,
      now: () => NOW,
      throttle: createThrottle(fakeClock()),
    });

    await expect(
      adapter.fetch('smart-money.flows', {
        chain: 'ethereum',
        tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      }),
    ).rejects.toThrow(/refusing an ungated paid call/);
  });

  // Sanity control: the SAME (no budgetStore) construction, but WITH both `fetchImpl` AND the
  // explicit `__ungatedForTestsOnly: true` opt-in (the legitimate isolated-HTTP-contract-testing
  // shape `nansen.contract.test.ts` itself uses) must still work exactly as before.
  it('still runs the ungated path normally when fetchImpl AND __ungatedForTestsOnly: true are both supplied', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/v1/smart-money/netflow') {
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      if (pathname === '/api/v1/tgm/holders') {
        return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
      }
      throw new Error(`unrouted test call to ${pathname}`);
    };
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl,
      now: () => NOW,
      throttle: createThrottle(fakeClock()),
      __ungatedForTestsOnly: true,
    });

    await expect(
      adapter.fetch('smart-money.flows', {
        chain: 'ethereum',
        tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      }),
    ).resolves.toBeDefined();
  });
  // --- adversarial cycle 2 (R-1): a large-but-VALID header must not poison the day bucket ---
  it('R-1: an implausibly large credits header degrades to delta=0 instead of poisoning the bucket', async () => {
    // Per-header validation only rejects the unsafe-integer range, so `999999999` passed every
    // check and was committed verbatim — after which checkAndReserve refuses every call for the
    // rest of the UTC day, and the poisoned row persists in SQLite with no in-band recovery.
    // The vendor-ceiling branch self-heals on resync, so this bit ONLY operators who set
    // NANSEN_DAILY_CREDIT_CAP — exactly the careful ones.
    const recorded: number[] = [];
    const budgetStore = {
      checkAndReserve: async () => ({ ok: true as const }),
      recordDelta: async (_p: string, _b: number, d: number) => {
        recorded.push(d);
      },
      getUsage: async () => 0,
    };
    let unreconciled = false;
    const accountState = {
      get: () => undefined,
      set: () => {},
      markUnreconciled: () => {
        unreconciled = true;
      },
      isUnreconciled: () => unreconciled,
      clearUnreconciled: () => {
        unreconciled = false;
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await reconcile({
        subResponses: [{ creditsUsedHeader: '999999999' }] as never,
        reservedTotal: 10,
        bucket: 0,
        budgetStore: budgetStore as never,
        accountState: accountState as never,
      });
    } finally {
      stderr.mockRestore();
    }
    expect(recorded).toEqual([0]);
    expect(unreconciled).toBe(true);
  });

  it('R-1: a normal over-report within the plausible band still reconciles honestly', async () => {
    const recorded: number[] = [];
    const budgetStore = {
      checkAndReserve: async () => ({ ok: true as const }),
      recordDelta: async (_p: string, _b: number, d: number) => {
        recorded.push(d);
      },
      getUsage: async () => 0,
    };
    const accountState = {
      get: () => undefined,
      set: () => {},
      markUnreconciled: () => {},
      isUnreconciled: () => false,
      clearUnreconciled: () => {},
    };
    // 12 actual against 10 reserved: a real +2 correction, well inside the guard band.
    await reconcile({
      subResponses: [{ creditsUsedHeader: '12' }] as never,
      reservedTotal: 10,
      bucket: 0,
      budgetStore: budgetStore as never,
      accountState: accountState as never,
    });
    expect(recorded).toEqual([2]);
  });
});
