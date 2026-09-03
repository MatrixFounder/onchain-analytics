import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createCallGate,
  ProviderCallCeilingExceededError,
} from '../src/adapters/blockscout/call-gate.js';
import {
  DAILY_CALL_EXHAUSTED_DETAIL,
  SqliteBudgetStore,
  type BudgetStore,
} from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { RateLimitRejectedError } from '../src/net/rate-limit.js';
import { PgBudgetStore } from '../src/pg/budget-store.js';
import type { StateClient, StateTransaction } from '../src/pg/state-client.js';

/**
 * Task 015-13/015-14 — the daily call gate's CONTRACT (`docs/tasks/task-015-13-call-gate-contract-
 * stub.md`, `docs/tasks/task-015-14-daily-call-counter.md`). Every case here names its task-file
 * counterpart in a comment, TC-UNIT-01..07 plus TC-DOC-01. TC-UNIT-02 and TC-UNIT-05 were written
 * for the task 015-13 STUB and were EXPECTED to fail once task 015-14 replaced that stub's body —
 * they are updated here to assert the real (read-and-increment) behaviour instead.
 *
 * TC-UNIT-08 (packages/core reads no `process.env` for this value) is not restated here — it is
 * `packages/mcp-server/test/settings-access.gate.test.ts`'s own static gate over the WHOLE source
 * tree, and `call-gate.ts` never reads `process.env` at all, so that gate's own existing assertions
 * cover it without a second, narrower copy of the same check.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A `BudgetStore` every method of which throws if actually called — used by the CONSTRUCTION-only
 * cases below (TC-UNIT-03/04), which build a gate but never call `ensureCallBudget`, to prove that
 * construction itself never touches the store. */
function budgetStoreThatThrowsIfUsed(): BudgetStore {
  const boom = (method: string) => () => {
    throw new Error(`budgetStoreThatThrowsIfUsed: ${method} must not be called on this pass`);
  };
  return {
    checkAndReserve: boom('checkAndReserve'),
    recordDelta: boom('recordDelta'),
    getUsage: boom('getUsage'),
    getWindowUsage: boom('getWindowUsage'),
    getWindowCalls: boom('getWindowCalls'),
  } as unknown as BudgetStore;
}

/**
 * A minimal `StateClient` for the Postgres axis (TC-UNIT-01) — no network, no real SQL semantics.
 * `query` inside a transaction always answers with one row carrying `credits_used: 0`, which is
 * enough for `PgBudgetStore.checkAndReserve`'s daily-reservation statement to see a non-empty
 * `RETURNING` and proceed; `velocity` is never supplied by these tests, so no second statement is
 * issued. What this harness does NOT prove is discussed at length by `pg-store-parity.test.ts`'s
 * own dialect harness — this one exists only to prove the SIXTH PARAMETER is accepted and the call
 * completes, not that the SQL is correct (that is `pg-store-parity.test.ts`'s job).
 */
class MinimalFakeStateClient implements StateClient {
  isAvailable(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  async query<T>(): Promise<T[]> {
    return [];
  }
  async transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T> {
    const tx: StateTransaction = {
      query: async <U>(): Promise<U[]> => [{ credits_used: 0 } as unknown as U],
    };
    return fn(tx);
  }
}

describe('TC-UNIT-01 — checkAndReserve accepts the sixth `dailyCalls` parameter on BOTH axes', () => {
  it('SQLite axis: the call compiles and executes', async () => {
    const store = new SqliteBudgetStore({ dbPath: ':memory:' });
    const result = await store.checkAndReserve(
      'blockscout',
      dayBucketMs(Date.now()),
      0,
      Infinity,
      undefined,
      { ceiling: 5 },
    );
    expect(result).toEqual({ ok: true });
  });

  it('Postgres axis: the call compiles and executes', async () => {
    const store = new PgBudgetStore({ client: new MinimalFakeStateClient(), providers: [] });
    const result = await store.checkAndReserve(
      'blockscout',
      dayBucketMs(Date.now()),
      0,
      Infinity,
      undefined,
      { ceiling: 5 },
    );
    expect(result).toEqual({ ok: true });
  });
});

it('TC-UNIT-02 (task 015-14 flipped this red, the stub used to answer ok:true): a zero daily-call ceiling refuses even a zero-cost call', async () => {
  const store = new SqliteBudgetStore({ dbPath: ':memory:' });
  const result = await store.checkAndReserve(
    'blockscout',
    dayBucketMs(Date.now()),
    0,
    Infinity,
    undefined,
    { ceiling: 0 },
  );
  expect(result.ok).toBe(false);
  expect((result as { ok: false; reason: string }).reason).toContain(DAILY_CALL_EXHAUSTED_DETAIL);
});

it('TC-UNIT-03: createCallGate builds given `provider` and `budgetStore`, no override', () => {
  const gate = createCallGate({
    provider: 'blockscout',
    budgetStore: budgetStoreThatThrowsIfUsed(),
  });
  expect(typeof gate.ensureCallBudget).toBe('function');
});

it("TC-UNIT-04: createCallGate refuses to construct for a provider that declares 'none'", () => {
  let thrown: unknown;
  try {
    createCallGate({ provider: 'coingecko', budgetStore: budgetStoreThatThrowsIfUsed() });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain('coingecko');
});

describe('TC-UNIT-05 (task 015-14 flipped this red, the stub used to resolve without touching budgetStore): ensureCallBudget delegates to checkAndReserve', () => {
  it('calls checkAndReserve with cost 0, an unlimited credit ceiling, and the declared dailyCalls ceiling', async () => {
    const calls: unknown[][] = [];
    const fakeStore: BudgetStore = {
      checkAndReserve: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true };
      },
      recordDelta: async () => {},
      getUsage: async () => 0,
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 0,
    } as unknown as BudgetStore;
    const gate = createCallGate({ provider: 'blockscout', budgetStore: fakeStore });
    const fixedNow = Date.UTC(2026, 6, 23, 12, 0, 0);

    await gate.ensureCallBudget(() => fixedNow);

    expect(calls).toEqual([
      ['blockscout', dayBucketMs(fixedNow), 0, Infinity, undefined, { ceiling: 625 }],
    ]);
  });

  it('re-throws a checkAndReserve refusal as ProviderCallCeilingExceededError, carrying the reason text', async () => {
    // The DETAIL shape the store actually produces — `ensureCallBudget` branches on this head to
    // tell exhaustion from a fail-closed ledger, so a mock that skipped it would exercise the
    // other arm and prove nothing about this one.
    const refusalReason = `${DAILY_CALL_EXHAUSTED_DETAIL}blockscout: 625 of 625 calls already made today (day starts 1700000000000)`;
    const refusingStore: BudgetStore = {
      checkAndReserve: async () => ({ ok: false, reason: refusalReason }),
      recordDelta: async () => {},
      getUsage: async () => 0,
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 625,
    } as unknown as BudgetStore;
    const gate = createCallGate({ provider: 'blockscout', budgetStore: refusingStore });

    await expect(gate.ensureCallBudget(() => Date.now())).rejects.toThrow(
      ProviderCallCeilingExceededError,
    );
    await expect(gate.ensureCallBudget(() => Date.now())).rejects.toThrow(
      /daily call ceiling reached/,
    );
  });

  it('applies dailyCallCeilingOverride in place of the declared ceiling when supplied', async () => {
    const calls: unknown[][] = [];
    const fakeStore: BudgetStore = {
      checkAndReserve: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true };
      },
      recordDelta: async () => {},
      getUsage: async () => 0,
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 0,
    } as unknown as BudgetStore;
    const gate = createCallGate({
      provider: 'blockscout',
      budgetStore: fakeStore,
      dailyCallCeilingOverride: 10,
    });

    await gate.ensureCallBudget(() => Date.now());

    expect(calls[0]?.[5]).toEqual({ ceiling: 10 });
  });

  it('TC-UNIT-08 (task 015-16, R-12.1): the ceiling in force is the SMALLER of the declared ceiling and the override — an override ABOVE the declared ceiling must not widen it', async () => {
    const makeFakeStore = (): { store: BudgetStore; calls: unknown[][] } => {
      const calls: unknown[][] = [];
      const store: BudgetStore = {
        checkAndReserve: async (...args: unknown[]) => {
          calls.push(args);
          return { ok: true };
        },
        recordDelta: async () => {},
        getUsage: async () => 0,
        getWindowUsage: async () => 0,
        getWindowCalls: async () => 0,
        getDailyCalls: async () => 0,
      } as unknown as BudgetStore;
      return { store, calls };
    };

    // Declared ceiling for `blockscout` is 625 (`providers.config.ts`). Override BELOW it narrows.
    const { store: narrowStore, calls: narrowCalls } = makeFakeStore();
    const narrowingGate = createCallGate({
      provider: 'blockscout',
      budgetStore: narrowStore,
      dailyCallCeilingOverride: 3,
    });
    await narrowingGate.ensureCallBudget(() => Date.now());
    expect(narrowCalls[0]?.[5]).toEqual({ ceiling: 3 });

    // Override ABOVE the declared ceiling must stay clamped at 625 — a naive `override ?? declared`
    // would let 9000 through, widening the gate the `narrowing` settings class (§10.3.1) promises
    // can only ever restrict.
    const { store: widenStore, calls: widenCalls } = makeFakeStore();
    const wideningGate = createCallGate({
      provider: 'blockscout',
      budgetStore: widenStore,
      dailyCallCeilingOverride: 9000,
    });
    await wideningGate.ensureCallBudget(() => Date.now());
    expect(
      widenCalls[0]?.[5],
      'an override above the declared ceiling widened the effective ceiling instead of being clamped',
    ).toEqual({ ceiling: 625 });
  });
});

describe('TC-UNIT-06 — ProviderCallCeilingExceededError is distinguishable BY VALUE (AC-25)', () => {
  const ceilingError = new ProviderCallCeilingExceededError(
    'blockscout: 625 of 625 calls already made today (day starts 1700000000000)',
  );
  const saturationError = new RateLimitRejectedError(
    'blockscout',
    'computed wait 900ms exceeds the 30000ms cap',
    { remaining: -1, ceiling: 5, refillPerSec: 2 },
  );

  it('`daily call ceiling reached` appears ONLY in the new class', () => {
    expect(ceilingError.message).toContain('daily call ceiling reached');
    expect(saturationError.message).not.toContain('daily call ceiling reached');
  });

  it('the marker appears EXACTLY once in the message an operator reads', async () => {
    // The defect this pins, measured 2026-08-28 on the shipped text: the store's refusal began
    // with the same phrase the class prefixes, so the thrown message said
    // `daily call ceiling reached: daily call ceiling reached for provider=…`. Counting is the
    // assertion — `toContain` passed on the doubled text and would pass on it again.
    const store = new SqliteBudgetStore({ dbPath: ':memory:' });
    const gate = createCallGate({
      provider: 'blockscout',
      budgetStore: store,
      dailyCallCeilingOverride: 1,
    });
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    await gate.ensureCallBudget(() => now);

    let thrown: unknown;
    try {
      await gate.ensureCallBudget(() => now);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderCallCeilingExceededError);
    const message = (thrown as Error).message;
    expect(message.split('daily call ceiling reached').length - 1, message).toBe(1);
    expect(message).toContain(DAILY_CALL_EXHAUSTED_DETAIL);
  });

  it('a refusal that never decided the ceiling does NOT claim the ceiling was reached', async () => {
    // Second defect of the same measurement: every fail-closed refusal from the same
    // `checkAndReserve` — an unreadable `credits_used`/`calls_made` written by another process
    // sharing `cache.sqlite3`, the topology the fail-closed branch exists for — reached the
    // operator as `daily call ceiling reached: budget check failed closed …`. The ceiling may not
    // have been approached at all; only the ledger was unreadable.
    const failClosed =
      'budget check failed closed for provider=blockscout: ledger value is not a finite number (used abc)';
    const brokenStore: BudgetStore = {
      checkAndReserve: async () => ({ ok: false, reason: failClosed }),
      recordDelta: async () => {},
      getUsage: async () => 0,
      getWindowUsage: async () => 0,
      getWindowCalls: async () => 0,
      getDailyCalls: async () => 0,
    } as unknown as BudgetStore;
    const gate = createCallGate({ provider: 'blockscout', budgetStore: brokenStore });

    let thrown: unknown;
    try {
      await gate.ensureCallBudget(() => Date.now());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(
      thrown,
      'a fail-closed ledger is not an exhausted ceiling and must not be reported as one',
    ).not.toBeInstanceOf(ProviderCallCeilingExceededError);
    const message = (thrown as Error).message;
    // Task 015-15 registers the tenth failure class on `/daily call ceiling reached: /i`. A
    // fail-closed message carrying that substring would be routed as an exhausted ceiling.
    expect(message).not.toContain('daily call ceiling reached');
    expect(message, 'the real cause must survive to the reader').toContain(failClosed);
  });

  it('`throttle: rejected` appears ONLY in the existing saturation class', () => {
    expect(saturationError.message).toContain('throttle: rejected');
    expect(ceilingError.message).not.toContain('throttle: rejected');
  });

  it("neither `rate limit` nor `bucket` appears anywhere in the NEW class's text", () => {
    expect(ceilingError.message).not.toContain('rate limit');
    expect(ceilingError.message).not.toContain('bucket');
  });
});

it('TC-UNIT-07 (MINOR-7): the `dailyCalls` docstring states why VelocityLimit.maxCalls is not reused', () => {
  const source = readFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'cache', 'budget-store.ts'),
    'utf8',
  );
  const paramIdx = source.indexOf('dailyCalls?: { ceiling: number },');
  expect(paramIdx).toBeGreaterThan(-1);
  const docBlock = source.slice(Math.max(0, paramIdx - 1500), paramIdx);

  // The reason must name what carries the count (a DIFFERENT ledger from `usage_window`) and how
  // long that ledger's rows live (`WINDOW_RETENTION_MS`) — a docstring that only repeats
  // "different denominator" without naming the CARRIER and the LIFETIME restates MINOR-7's own
  // heading without answering it.
  expect(docBlock).toContain('usage_window');
  expect(docBlock).toContain('WINDOW_RETENTION_MS');
  expect(docBlock).toMatch(/MINOR-7/);
});

it('TC-DOC-01: system-architecture.md §3.5.4 declares the SAME signature as the module', () => {
  const doc = readFileSync(
    path.join(repoRoot, 'docs', 'architectures', 'system-architecture-billing.md'),
    'utf8',
  );
  const sectionStart = doc.indexOf('#### 3.5.4.');
  expect(sectionStart).toBeGreaterThan(-1);
  const declStart = doc.indexOf('export function createCallGate', sectionStart);
  expect(declStart).toBeGreaterThan(-1);
  const declEnd = doc.indexOf('\n```', declStart);
  expect(declEnd).toBeGreaterThan(declStart);
  const block = doc.slice(sectionStart, declEnd);

  expect(block).toContain('provider: string');
  expect(block).not.toContain('ensureCallBudget(provider: string');
  expect(block).toContain('deps.provider');
});
