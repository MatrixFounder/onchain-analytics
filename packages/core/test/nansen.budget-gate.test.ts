import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetStore } from '../src/cache/budget-store.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { createThrottle } from '../src/net/rate-limit.js';
import {
  createNansenAccountState,
  type NansenAccountSnapshot,
  type NansenAccountState,
} from '../src/adapters/nansen/account-state.js';
import {
  DAILY_CAP_OFF,
  createNansenBudgetGate,
  effectiveCeilingFor,
  NansenBudgetExceededError,
  type NansenBudgetGateDeps,
} from '../src/adapters/nansen/budget-gate.js';

// Every test below either (a) pre-seeds accountState with an already-reconciled, same-bucket
// snapshot — guaranteeing ensureBudget() takes the "no resync needed" branch, so its injected
// fetchImpl is PROVABLY never called (TC-UNIT-01/02/03/04/10/11/12), or (b) deliberately exercises
// the resync branch against an injected fetchImpl fixture, never real network (TC-UNIT-05..09). No
// live Nansen credits are spent anywhere in this file (task 005-3's own "Живые кредиты: 0").

const testDir = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
const PROVIDER = 'nansen';

function loadFixture(name: 'account.free' | 'account.pro'): unknown {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'nansen', `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A reconciled, same-bucket snapshot — the "no resync needed" precondition every zero-network
 * test below relies on. */
function reconciledSnapshot(overrides: {
  plan?: 'free' | 'pro';
  creditsRemainingAtObserve: number;
  usageAtObserve: number;
  dailyCapForBucket?: number | undefined;
}): NansenAccountSnapshot {
  return {
    plan: overrides.plan ?? 'free',
    creditsRemainingAtObserve: overrides.creditsRemainingAtObserve,
    usageAtObserve: overrides.usageAtObserve,
    observedAtMs: NOW,
    dayBucketMs: BUCKET,
    // Q-2: pre-existing cases predate the derived cap and assert the VENDOR ceiling, so they pin
    // `undefined` (= no self-imposed ceiling) unless a case opts in explicitly.
    dailyCapForBucket: overrides.dailyCapForBucket,
  };
}

interface TestFixture {
  budgetStore: BudgetStore & { checkAndReserve: BudgetStore['checkAndReserve'] };
  accountState: NansenAccountState;
  fetchSpy: ReturnType<typeof vi.fn>;
  gate: ReturnType<typeof createNansenBudgetGate>;
}

function makeFixture(
  overrides: Partial<NansenBudgetGateDeps> & { fetchImpl?: typeof fetch } = {},
): TestFixture {
  const { fetchImpl: fetchImplOverride, ...restOverrides } = overrides;
  const budgetStore = createBudgetStore({ dbPath: ':memory:' });
  const accountState = createNansenAccountState();
  // `fetchSpy` wraps whichever fetchImpl this test asked for (default: the free-plan fixture) —
  // spread AFTER, never overwriting it back with the un-spied original (that was a real bug this
  // test file caught on its own first run: `...overrides` re-adding `overrides.fetchImpl` here
  // would silently replace `fetchSpy` with the unwrapped function, making every `toHaveBeenCalled`
  // assertion below false-negative).
  const fetchSpy = vi.fn(
    fetchImplOverride ?? (async () => jsonResponse(loadFixture('account.free'))),
  );

  const deps: NansenBudgetGateDeps = {
    budgetStore,
    accountState,
    now: () => NOW,
    env: { NANSEN_API_KEY: 'test-key-not-real' },
    throttle: createThrottle(), // fresh, full-capacity bucket per test — see budget-gate.ts's
    // own NansenBudgetGateDeps docstring for why this is NOT the shared production singleton.
    ...restOverrides,
    fetchImpl: fetchSpy as unknown as typeof fetch,
  };

  const gate = createNansenBudgetGate(deps);
  return { budgetStore, accountState, fetchSpy, gate };
}

describe('effectiveCeilingFor() — the anchor-rebased formula, pinned exactly (TC-UNIT-06 numeric case)', () => {
  it("rebases onto usageAtObserve BEFORE min() — the architecture doc's own 25/75 walkthrough", () => {
    const snapshot = reconciledSnapshot({ creditsRemainingAtObserve: 75, usageAtObserve: 25 });
    // The naive, defect formula would be min(75, cap ?? Infinity) = 75. Correct: 25+75=100.
    expect(effectiveCeilingFor(snapshot, undefined)).toBe(100);
  });

  it('min()s the rebased vendor ceiling against an optional self-imposed NANSEN_DAILY_CREDIT_CAP', () => {
    const snapshot = reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 });
    expect(effectiveCeilingFor(snapshot, 20)).toBe(20);
    expect(effectiveCeilingFor(snapshot, 200)).toBe(100); // cap can only ever narrow, never widen
  });
});

describe('ensureBudget() — pre-call budget gate (R-36/R-37, task 005-3)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // TC-UNIT-01 (R-37, refusal case A — 150 against a 100cr balance, the REAL UC-3 case).
  it('refuses a 150cr premium_labels request against a 100cr balance — ZERO network calls, usage untouched', async () => {
    const { gate, accountState, budgetStore, fetchSpy } = makeFixture();
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));

    const usageBefore = await budgetStore.getUsage(PROVIDER, BUCKET);
    await expect(
      gate.ensureBudget('entity.labels', { tokenAddress: '0xabc', premium_labels: true }),
    ).rejects.toBeInstanceOf(NansenBudgetExceededError);
    await expect(
      gate.ensureBudget('entity.labels', { tokenAddress: '0xabc', premium_labels: true }),
    ).rejects.toThrow(/vendor: need 150, remaining \(as of last resync\) 100/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(usageBefore);
  });

  // TC-UNIT-02 (R-37, refusal case B — 100cr against a 100cr ceiling with 5 already spent).
  it('refuses a 100cr exhaustive-escalation request when only 95 of a 100 ceiling remain — ZERO network calls', async () => {
    const { gate, accountState, budgetStore, fetchSpy } = makeFixture();
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));
    await budgetStore.recordDelta(PROVIDER, BUCKET, 5); // 5cr already spent this bucket

    const usageBefore = await budgetStore.getUsage(PROVIDER, BUCKET);
    await expect(
      gate.ensureBudget('entity.labels', { tokenAddress: '0xabc', exhaustive: true }),
    ).rejects.toThrow(/vendor: need 100, remaining \(as of last resync\) 100/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(usageBefore);
  });

  // TC-UNIT-03 (R-37, atomicity) — two DIFFERENT calls, each affordable alone, not affordable
  // together. checkAndReserve's own synchronous-transaction guarantee (task 005-2) means calling
  // both back-to-back deterministically settles exactly one true/one false — no real thread race
  // needed to prove it (see budget-store.ts's own docstring on why this holds).
  it('two different concurrent calls whose SUM exceeds the ceiling: exactly one reservation lands', async () => {
    const { gate, accountState, budgetStore, fetchSpy } = makeFixture();
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));

    const [flows, labels] = await Promise.allSettled([
      gate.ensureBudget('smart-money.flows', {}), // 10cr, fits alone
      gate.ensureBudget('entity.labels', { tokenAddress: '0xabc', exhaustive: true }), // 100cr, fits alone; NOT together (110 > 100)
    ]);

    const outcomes = [flows.status, labels.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Exactly one reservation landed — never both (220), never neither (0).
    const usage = await budgetStore.getUsage(PROVIDER, BUCKET);
    expect([10, 100]).toContain(usage);
  });

  // TC-UNIT-04 (R-37, fail-closed price) — an unrecognized capability never reaches checkAndReserve.
  it('an unrecognized capability fails closed BEFORE ever touching BudgetStore.checkAndReserve', async () => {
    const { gate, accountState, budgetStore, fetchSpy } = makeFixture();
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));
    const reserveSpy = vi.spyOn(budgetStore, 'checkAndReserve');

    await expect(gate.ensureBudget('not-a-real-capability', {})).rejects.toBeInstanceOf(
      NansenBudgetExceededError,
    );

    expect(reserveSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // TC-UNIT-05 (R-36, UC-9 — plan upgrade with ZERO code changes, only the /account fixture swaps).
  it('the SAME 150cr request that free refuses succeeds once /account reports plan:pro (fixture swap only)', async () => {
    const freeAttempt = makeFixture({
      fetchImpl: async () => jsonResponse(loadFixture('account.free')),
    });
    await expect(
      freeAttempt.gate.ensureBudget('entity.labels', {
        tokenAddress: '0xabc',
        premium_labels: true,
      }),
    ).rejects.toBeInstanceOf(NansenBudgetExceededError);

    const proAttempt = makeFixture({
      fetchImpl: async () => jsonResponse(loadFixture('account.pro')),
    });
    await expect(
      proAttempt.gate.ensureBudget('entity.labels', {
        tokenAddress: '0xabc',
        premium_labels: true,
      }),
      // CHANGED EXPECTATION (SEC-1): the reservation now also names the VELOCITY window it was
      // written into, so reconciliation can refund into that window rather than whichever one is
      // current when the call returns. `expect.any(Number)` rather than a literal — the window is a
      // function of the same injected clock the bucket is, and pinning it twice adds nothing.
    ).resolves.toEqual({ reservedTotal: 150, bucket: BUCKET, window: expect.any(Number) });
    expect(proAttempt.fetchSpy).toHaveBeenCalledTimes(1);
  });

  // TC-UNIT-06 (R-36) — end-to-end: a mid-bucket resync (triggered by markUnreconciled()) must NOT
  // collapse the ceiling back down by the amount already spent. Numbers are chosen so the naive
  // (buggy) `min(creditsRemainingAtObserve, cap)` formula would REFUSE this call (76 > 29) while
  // the correct, anchor-rebased formula PASSES it (76 <= 100) — a single call that cleanly
  // distinguishes the two formulas (the exact numeric case is pinned separately, in
  // effectiveCeilingFor()'s own direct unit test above).
  it('a resync triggered mid-bucket (markUnreconciled) does not re-subtract already-accounted spend', async () => {
    const { gate, accountState, budgetStore, fetchSpy } = makeFixture({
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: 29 }),
    });
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));
    await budgetStore.recordDelta(PROVIDER, BUCKET, 71); // 71cr already spent this bucket
    accountState.markUnreconciled(); // e.g. a prior call timed out before its response arrived

    const result = await gate.ensureBudget('entity.labels', { tokenAddress: '0xabc' }); // 5cr

    expect(fetchSpy).toHaveBeenCalledTimes(1); // the forced resync
    // CHANGED EXPECTATION (SEC-1): the reservation now also names the VELOCITY window it was
    // written into, so reconciliation can refund into that window rather than whichever one is
    // current when the call returns. `expect.any(Number)` rather than a literal — the window is a
    // function of the same injected clock the bucket is, and pinning it twice adds nothing.
    expect(result).toEqual({ reservedTotal: 5, bucket: BUCKET, window: expect.any(Number) });
    expect(accountState.get()).toMatchObject({ usageAtObserve: 71, creditsRemainingAtObserve: 29 });
    expect(accountState.isUnreconciled()).toBe(false); // cleared by the successful resync
  });

  // TC-UNIT-07 (R-36, cold start mid-bucket) — usageAtObserve on the FIRST-EVER resync of a
  // process must reflect whatever was already persisted in `usage`, not assume 0.
  it('cold start (no prior in-process snapshot) reads the ALREADY-PERSISTED bucket usage, not 0', async () => {
    const { gate, accountState, budgetStore } = makeFixture({
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: 60 }),
      // Q-2: this case is about the ANCHOR (usageAtObserve must reflect persisted spend), not about
      // the self-imposed ceiling. With the derived default active, usage 40 already exceeds the
      // derived cap (max(30, 15) = 30) and everything would refuse for a reason unrelated to what
      // is under test. `off` isolates it — and doubles as proof the disable switch works.
      dailyCreditCap: DAILY_CAP_OFF,
    });
    expect(accountState.get()).toBeUndefined(); // genuinely cold — no .set() call at all
    await budgetStore.recordDelta(PROVIDER, BUCKET, 40); // persisted by a PREVIOUS process

    await gate.ensureBudget('token.risk', { tokenAddress: '0xabc' }); // 6cr

    expect(accountState.get()).toMatchObject({ usageAtObserve: 40, creditsRemainingAtObserve: 60 });
  });

  // TC-UNIT-08 (R-36, day rollover) — a snapshot from a PAST bucket is never trusted as-is.
  it("a snapshot from yesterday's bucket forces a resync instead of carrying its remainder forward", async () => {
    const { gate, accountState, fetchSpy } = makeFixture();
    const yesterday = BUCKET - 24 * 60 * 60 * 1000;
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 3, usageAtObserve: 0 }));
    accountState.set({
      ...(accountState.get() as ReturnType<typeof reconciledSnapshot>),
      dayBucketMs: yesterday,
    });

    await gate.ensureBudget('token.risk', {}); // 6cr — would refuse against yesterday's stale "3"

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(accountState.get()?.dayBucketMs).toBe(BUCKET);
  });

  // TC-UNIT-09 (R-36, resync failure — fail-closed).
  it('a failed /account resync throws BEFORE checkAndReserve is ever reached', async () => {
    const { gate, budgetStore } = makeFixture({
      fetchImpl: async () => jsonResponse({ error: 'boom' }, 503),
    });
    const reserveSpy = vi.spyOn(budgetStore, 'checkAndReserve');

    await expect(gate.ensureBudget('token.risk', {})).rejects.toThrow(/resync failed/);

    expect(reserveSpy).not.toHaveBeenCalled();
  });

  // TC-UNIT-10 (R-37, NANSEN_DAILY_CREDIT_CAP — self-imposed, narrower than the live vendor ceiling).
  it('a self-imposed NANSEN_DAILY_CREDIT_CAP refuses before the vendor ceiling would, and says so', async () => {
    const { gate, accountState } = makeFixture({ dailyCreditCap: 20 });
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));

    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    });
    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    });
    await expect(gate.ensureBudget('smart-money.flows', {})).rejects.toThrow(
      /self-imposed cap \(configured\): need 10, allows 20/,
    );
  });

  // TC-UNIT-11 (R-37, warn threshold — one stderr line per crossing per bucket, stdout untouched).
  it('emits exactly one stderr warn line on crossing the ratio, never a second in the same bucket, never stdout', async () => {
    const { gate, accountState, budgetStore } = makeFixture({ budgetWarnRatio: 0.8 });
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));
    await budgetStore.recordDelta(PROVIDER, BUCKET, 75); // pre-existing spend

    await gate.ensureBudget('smart-money.flows', {}); // +10 => 85/100 = 0.85 >= 0.8: crosses
    await gate.ensureBudget('token.risk', {}); // +6 => 91/100 = 0.91 >= 0.8: still crossed, no 2nd line

    const warnLines = stderrSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('nansen budget warn'),
    );
    expect(warnLines).toHaveLength(1);
    expect(String(warnLines[0]?.[0])).toContain('ratio=0.85');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // TC-UNIT-12 (R-37, bucket binding) — the bucket is fixed at ENTRY and is immune to `now()`
  // changing later (e.g. crossing midnight) while the resync's own network round trip is pending.
  it('binds dayBucketMs at entry — a `now()` change mid-flight during the resync never re-targets the reservation', async () => {
    const lateNight = Date.UTC(2026, 6, 23, 23, 59, 59, 800);
    const earlyNextDay = Date.UTC(2026, 6, 24, 0, 0, 0, 200);
    let nowMs = lateNight;

    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    const gate = createNansenBudgetGate({
      budgetStore,
      accountState,
      now: () => nowMs,
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      throttle: createThrottle(),
      fetchImpl: async () => {
        nowMs = earlyNextDay; // simulate wall-clock advancing past midnight mid-request
        return jsonResponse(loadFixture('account.free'));
      },
    });

    const result = await gate.ensureBudget('token.risk', {});

    const expectedBucket = dayBucketMs(lateNight);
    expect(dayBucketMs(earlyNextDay)).not.toBe(expectedBucket); // sanity: they really do differ
    expect(result.bucket).toBe(expectedBucket);
    expect(await budgetStore.getUsage(PROVIDER, expectedBucket)).toBe(6);
    expect(await budgetStore.getUsage(PROVIDER, dayBucketMs(earlyNextDay))).toBe(0);
  });

  // M-2(a) (adversarial review cycle 1) — the warn-block's own stderr.write() must never be able
  // to fail an already-committed reservation. Crosses the warn ratio (so the warn block's body
  // actually runs and reaches its own `process.stderr.write()` call, simulated here to throw —
  // e.g. EPIPE once the stdio client has closed) — proving `ensureBudget()` still resolves
  // normally and the reservation stands, instead of rejecting AFTER the credits were already spent.
  it('M-2(a): a throw from stderr.write() inside the post-commit warn block never fails ensureBudget() — the reservation still stands', async () => {
    const { gate, accountState, budgetStore } = makeFixture({ budgetWarnRatio: 0.8 });
    accountState.set(reconciledSnapshot({ creditsRemainingAtObserve: 100, usageAtObserve: 0 }));
    await budgetStore.recordDelta(PROVIDER, BUCKET, 75); // pre-existing spend -> warn block WILL run

    let warnWriteAttempted = false;
    stderrSpy.mockImplementation(((chunk: unknown) => {
      if (String(chunk).includes('nansen budget warn')) {
        warnWriteAttempted = true;
        throw new Error('simulated EPIPE: stdio client already closed');
      }
      return true;
    }) as typeof process.stderr.write);

    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    });

    expect(warnWriteAttempted).toBe(true); // the throwing write WAS attempted, and swallowed
    // The reservation is still there — a swallowed warn-block failure must never roll it back.
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(85);
  });

  // M-7 (adversarial review cycle 1) — usageAtObserve must be sampled BEFORE the vendor round
  // trip, never after: a reservation that commits DURING the (simulated) network delay must NOT be
  // double-counted into both usageAtObserve (read after) and the vendor's own credits_remaining.
  it('M-7: usageAtObserve is read BEFORE the /account round trip — a reservation racing the resync is not double-counted', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const accountState = createNansenAccountState();
    await budgetStore.recordDelta(PROVIDER, BUCKET, 10); // 10cr already spent, pre-resync

    const gate = createNansenBudgetGate({
      budgetStore,
      accountState,
      now: () => NOW,
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      throttle: createThrottle(),
      fetchImpl: async () => {
        // Simulate a reservation committing WHILE this /account round trip is in flight — with the
        // M-7 fix, usageAtObserve was already sampled (10) before this ran, so this concurrent +5
        // must NOT also leak into usageAtObserve.
        await budgetStore.recordDelta(PROVIDER, BUCKET, 5);
        return jsonResponse({ plan: 'free', credits_remaining: 100 });
      },
    });

    const result = await gate.ensureBudget('token.risk', {}); // 6cr

    // usageAtObserve must be 10 (sampled before the round trip), not 15 (10 + the racing +5).
    expect(accountState.get()).toMatchObject({
      usageAtObserve: 10,
      creditsRemainingAtObserve: 100,
    });
    // CHANGED EXPECTATION (SEC-1): the reservation now also names the VELOCITY window it was
    // written into, so reconciliation can refund into that window rather than whichever one is
    // current when the call returns. `expect.any(Number)` rather than a literal — the window is a
    // function of the same injected clock the bucket is, and pinning it twice adds nothing.
    expect(result).toEqual({ reservedTotal: 6, bucket: BUCKET, window: expect.any(Number) });
    // Final usage reflects BOTH the racing +5 and this reservation's own +6 — checkAndReserve()
    // itself always reads the CURRENT counter fresh, so the race is never lost, only kept OUT of
    // the anchor `usageAtObserve` rebases against.
    expect(await budgetStore.getUsage(PROVIDER, BUCKET)).toBe(21);
  });
  // --- Q-2: derived-by-default, pinned per bucket, disableable via .env ---
  it('applies a DERIVED ceiling by default (NANSEN_DAILY_CREDIT_CAP unset) — the guard is on out of the box', async () => {
    // balance 100 -> derived cap max(30, 25) = 30. The vendor would have allowed 100.
    const { gate } = makeFixture({
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: 100 }),
    });
    await gate.ensureBudget('smart-money.flows', {}); // 10 -> usage 10
    await gate.ensureBudget('smart-money.flows', {}); // 10 -> usage 20
    await gate.ensureBudget('smart-money.flows', {}); // 10 -> usage 30 (exactly at the cap)
    await expect(gate.ensureBudget('smart-money.flows', {})).rejects.toThrow(
      /self-imposed cap \(derived\): need 10, allows 30/,
    );
  });

  it('NANSEN_DAILY_CREDIT_CAP=off restores vendor-only bounding (the escape hatch)', async () => {
    const { gate } = makeFixture({
      dailyCreditCap: DAILY_CAP_OFF,
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: 100 }),
    });
    // Past the 30 the derived default would have imposed — only the vendor's 100 binds now.
    for (let i = 0; i < 5; i += 1) await gate.ensureBudget('smart-money.flows', {});
    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    });
  });

  it('PINS the derived cap for the bucket — a mid-bucket resync must not shrink it (Q-2)', async () => {
    // Recomputing on every resync makes a "daily" ceiling shrink during the day: at balance 200 the
    // operator is told 50, then gets locked out after 40. Here the balance falls 200 -> 150 between
    // resyncs; the pinned cap must stay 50, so the 5th 10cr call still fits.
    let remaining = 200;
    const { gate, accountState } = makeFixture({
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: remaining }),
    });
    await gate.ensureBudget('smart-money.flows', {}); // cold-start resync pins cap = 50
    expect(accountState.get()?.dailyCapForBucket).toBe(50);

    remaining = 150; // vendor balance has dropped
    accountState.markUnreconciled(); // force a mid-bucket resync on the next entry
    await gate.ensureBudget('smart-money.flows', {});
    expect(accountState.get()?.dailyCapForBucket).toBe(50); // NOT re-derived to 37

    await gate.ensureBudget('smart-money.flows', {});
    await gate.ensureBudget('smart-money.flows', {});
    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    }); // 50th credit — reachable only because the cap stayed pinned at 50
  });

  // --- vdd-multi cycle 4, logic L-2: the pin alone was never enough ---
  it('derives the cap from the bucket-START anchor, so a mid-day restart cannot lock the day out', async () => {
    // Session 1 saw balance 1000 at 00:00 and was told the ceiling is 250; it spent 200. The MCP
    // server then exited — every Claude Code session boundary does — and the pin lives in memory
    // only. Session 2 cold-starts against a POST-spend balance of 800. Deriving from that raw
    // remainder gives max(30, 200) = 200, and `used(200) + 10 > 200` refused EVERY paid call for
    // the rest of the UTC day. Anchored on `usageAtObserve + remaining` = 1000, it derives 250
    // again — the same rebasing `effectiveCeilingFor()` already applies to the vendor ceiling.
    const { gate, accountState, budgetStore } = makeFixture({
      fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: 800 }),
    });
    await budgetStore.recordDelta(PROVIDER, BUCKET, 200); // persisted by the PREVIOUS process

    await expect(gate.ensureBudget('smart-money.flows', {})).resolves.toMatchObject({
      reservedTotal: 10,
    });
    expect(accountState.get()?.dailyCapForBucket).toBe(250);
  });

  it('derives the SAME cap at any point in the bucket — repeated restarts cannot compound it downward', async () => {
    // The pre-fix formula walked the cap down on every restart (250 -> 200 -> 150), so the real
    // daily allowance degraded from 25% of the balance toward 20% and could trip anywhere between.
    for (const [spent, remaining] of [
      [0, 1000],
      [200, 800],
      [400, 600],
    ] as const) {
      const { gate, accountState, budgetStore } = makeFixture({
        fetchImpl: async () => jsonResponse({ plan: 'free', credits_remaining: remaining }),
      });
      await budgetStore.recordDelta(PROVIDER, BUCKET, spent);
      // At spent=400 the reservation is CORRECTLY refused (400 is past the 250 ceiling) — the
      // resync still ran first, which is what pins the snapshot this asserts on.
      await gate.ensureBudget('smart-money.flows', {}).catch(() => undefined);
      expect(accountState.get()?.dailyCapForBucket).toBe(250);
    }
  });

  // --- vdd-multi cycle 4, security S-1: the one field that defines the ceiling ---
  it('refuses a non-finite credits_remaining instead of pinning an unbounded ceiling for the day', async () => {
    // `1e999` is valid JSON and `JSON.parse` yields Infinity — no throw. A bare `typeof === number`
    // check admitted it, the value got PINNED for the bucket, `effectiveCeilingFor()` became
    // Infinity, and `used + cost > Infinity` approved every reservation for the rest of the day;
    // a later healthy resync could not repair it, because the pin carries forward.
    const { gate, accountState, budgetStore } = makeFixture({
      fetchImpl: async () =>
        new Response('{"plan":"free","credits_remaining":1e999}', { status: 200 }),
    });
    const reserveSpy = vi.spyOn(budgetStore, 'checkAndReserve');

    await expect(gate.ensureBudget('smart-money.flows', {})).rejects.toThrow(
      /credits_remaining is missing or not a non-negative safe integer/,
    );
    expect(reserveSpy).not.toHaveBeenCalled(); // fail-closed: no reservation, no snapshot
    expect(accountState.get()).toBeUndefined();
  });

  it('refuses a credits_remaining beyond the safe-integer range or below zero', async () => {
    for (const body of [
      '{"plan":"free","credits_remaining":1e21}',
      '{"plan":"free","credits_remaining":-5}',
    ]) {
      const { gate } = makeFixture({ fetchImpl: async () => new Response(body, { status: 200 }) });
      await expect(gate.ensureBudget('smart-money.flows', {})).rejects.toThrow(
        /credits_remaining is missing or not a non-negative safe integer/,
      );
    }
  });
});
