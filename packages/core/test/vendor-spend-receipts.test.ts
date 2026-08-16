import { describe, expect, it, vi } from 'vitest';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { MAX_CALLS_OFF, VELOCITY_OFF } from '../src/adapters/nansen/budget-gate.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import type { VendorSpendRecord } from '../src/cache/vendor-spend.js';
import { createThrottle } from '../src/net/rate-limit.js';

/**
 * Task 014-30 — the per-call vendor-spend receipt, measured against the LEDGER WRITES it describes.
 *
 * **The invariant under test, stated once.** Every vendor number a request reports is the sum of the
 * ARGUMENTS the completed `usage`/`usage_window` writes were bound with. There is no second computer
 * of that quantity anywhere, and these cases exist to make that falsifiable rather than plausible.
 *
 * **Why the assertions compare against a store SPY and not against a recomputed number.** The defect
 * this replaces is the one `budget-meta.ts` documents about itself: an assertion whose expected value
 * is derived the same way the implementation derives it is true under every implementation, so no
 * mutation can fail it. Concretely, `expect(row.vendorDay).toBe(dayBucketMs(Date.now()))` passes
 * against an implementation that re-derives the day from its own clock — which is exactly the bug
 * the channel exists to prevent, because a follower's clock can be a full velocity window later than
 * the leader's. The spy records what `checkAndReserve`/`recordDelta` were actually called with, so
 * the expected value comes from the ledger's side of the boundary.
 *
 * No live Nansen credits: every network call goes through an injected `fetchImpl`, and the throttle
 * uses a real-timer-free fake clock. Harness shape borrowed from `nansen.singleflight.test.ts`.
 */

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
const UNI_ADDRESS = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

/** `smart-money.flows` costs 10 on the free plan: netflow 5 + tgm/holders 5. */
const FLOWS_PRICE = 10;

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

interface Fixture {
  adapter: ReturnType<typeof createNansenAdapter>;
  budgetStore: ReturnType<typeof createBudgetStore>;
  receipts: VendorSpendRecord[];
  report: (record: VendorSpendRecord) => void;
  reserveSpy: ReturnType<typeof vi.spyOn>;
  recordDeltaSpy: ReturnType<typeof vi.spyOn>;
}

function makeFixture(
  overrides: {
    dailyCreditCap?: number;
    holdersStatus?: number;
    netflowCreditsHeader?: string;
    velocityOff?: boolean;
  } = {},
): Fixture {
  const fetchImpl: typeof fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/v1/account') {
      return jsonResponse({ plan: 'free', credits_remaining: 100_000 });
    }
    if (pathname === '/api/v1/smart-money/netflow') {
      return jsonResponse({ data: [] }, 200, {
        'x-nansen-credits-used': overrides.netflowCreditsHeader ?? '5',
      });
    }
    if (pathname === '/api/v1/tgm/holders') {
      if (overrides.holdersStatus !== undefined) return jsonResponse(null, overrides.holdersStatus);
      return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
    }
    throw new Error(`unrouted test call to ${pathname}`);
  };

  const budgetStore = createBudgetStore({ dbPath: ':memory:' });
  const reserveSpy = vi.spyOn(budgetStore, 'checkAndReserve');
  const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');

  const receipts: VendorSpendRecord[] = [];
  const report = (record: VendorSpendRecord): void => {
    receipts.push(record);
  };

  const adapter = createNansenAdapter({
    env: { NANSEN_API_KEY: 'test-key-not-real' },
    fetchImpl,
    now: () => NOW,
    throttle: createThrottle(fakeClock()),
    budgetStore,
    ...(overrides.dailyCreditCap !== undefined ? { dailyCreditCap: overrides.dailyCreditCap } : {}),
    ...(overrides.velocityOff === true
      ? { velocityCap: VELOCITY_OFF, maxCallsPerWindow: MAX_CALLS_OFF }
      : {}),
  });

  return { adapter, budgetStore, receipts, report, reserveSpy, recordDeltaSpy };
}

const ARGS = { chain: 'ethereum', tokenAddress: UNI_ADDRESS };

/** Only the `charge` arm carries numbers; a `coalesced` receipt contributes nothing by TYPE. */
const creditsOf = (receipts: VendorSpendRecord[]): number =>
  receipts.reduce((sum, r) => sum + (r.kind === 'charge' ? r.credits : 0), 0);
const callsOf = (receipts: VendorSpendRecord[]): number =>
  receipts.reduce((sum, r) => sum + (r.kind === 'charge' ? r.calls : 0), 0);

describe('TC-UNIT-02: the receipt reports what the ledger was told, never a recomputation', () => {
  it('sums to the store arguments, and to the movement of the counters themselves', async () => {
    const { adapter, budgetStore, receipts, report, reserveSpy, recordDeltaSpy } = makeFixture();

    await adapter.fetch('smart-money.flows', ARGS, undefined, report);

    // (1) The receipts agree with what the store was CALLED with.
    const [reserveProvider, reserveDay, reserveCost, , reserveVelocity] = reserveSpy.mock
      .calls[0] as [string, number, number, number, { windowStartMs: number } | undefined];
    const [, , recordedDelta] = recordDeltaSpy.mock.calls[0] as [string, number, number, number?];

    expect(creditsOf(receipts)).toBe(reserveCost + recordedDelta);
    expect(callsOf(receipts)).toBe(1);
    for (const receipt of receipts) {
      expect(receipt.providerId).toBe(reserveProvider);
      expect(receipt.at?.dayBucketMs).toBe(reserveDay);
      expect(receipt.at?.windowStartMs).toBe(reserveVelocity?.windowStartMs);
    }

    // (2) The counters themselves moved by the same amount. (1) alone would pass against a store
    // that accepted the calls and wrote nothing; (2) alone would pass against a receipt that
    // re-read the counter instead of reporting its own contribution.
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(creditsOf(receipts));
    expect(await budgetStore.getWindowCalls('nansen', reserveVelocity!.windowStartMs)).toBe(
      callsOf(receipts),
    );
  });

  it('reports ONE call, not one per HTTP round trip', async () => {
    // `smart-money.flows` makes two paid round trips and contributes exactly 1 to
    // `usage_window.calls_made`, because `checkAndReserve` increments it once per LOGICAL call. An
    // implementation reporting `subResponses.length` would report 2 and the daily reconciliation
    // against `usage_window` would drift by the number of composite capabilities served.
    const { adapter, receipts, report } = makeFixture();
    await adapter.fetch('smart-money.flows', ARGS, undefined, report);
    expect(callsOf(receipts)).toBe(1);
  });
});

describe('TC-UNIT-15: a served call reports the reservation AND its reconciliation', () => {
  it('emits both writes, and the total differs from the reserved price', async () => {
    // The vendor reported 3 for netflow against a reserved 5, so the committed total is 8 and not
    // the 10 `costOf()` predicted. A channel that reported only the reservation — or that echoed
    // `costOf()` — would be indistinguishable from this one on a call where the vendor happens to
    // charge exactly what we reserved, which is why the header is skewed here on purpose.
    const { adapter, budgetStore, receipts, report } = makeFixture({ netflowCreditsHeader: '3' });

    await adapter.fetch('smart-money.flows', ARGS, undefined, report);

    expect(receipts.map((r) => r.kind === 'charge' && r.write)).toStrictEqual([
      'reservation',
      'reconciliation',
    ]);
    expect(creditsOf(receipts)).toBe(8);
    expect(creditsOf(receipts)).not.toBe(FLOWS_PRICE);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(8);
  });
});

describe('TC-UNIT-12: money spent by a call that then failed is still reported', () => {
  it('reports the committed 5 credits although fetch() rejects', async () => {
    // The path the four-path table of the task file used to say produces empty vendor columns:
    // the reservation committed, sub-call #2 threw, the catch reconciled the PARTIAL set, and the
    // error propagated. `usage` moved; a channel carried on the resolved value would report nothing.
    const { adapter, budgetStore, receipts, report } = makeFixture({ holdersStatus: 500 });

    await expect(adapter.fetch('smart-money.flows', ARGS, undefined, report)).rejects.toThrow();

    expect(creditsOf(receipts)).toBe(5);
    expect(callsOf(receipts)).toBe(1);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(5);
  });
});

describe('TC-UNIT-13: a refused reservation reports nothing, and moves nothing', () => {
  it('emits no receipt when the budget gate refuses before committing', async () => {
    // The negative half of TC-UNIT-02. Without it, "no receipt" would be indistinguishable from
    // "the reporter was never wired", and every case above would pass against a channel that is
    // silently disconnected on some other path.
    const { adapter, budgetStore, receipts, report } = makeFixture({ dailyCreditCap: 1 });

    await expect(adapter.fetch('smart-money.flows', ARGS, undefined, report)).rejects.toThrow(
      /budget/i,
    );

    expect(receipts).toStrictEqual([]);
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(0);
  });
});

describe('TC-UNIT-14: with both velocity guards off there is no window to name', () => {
  it('reports a null window and zero calls, and writes no usage_window row', async () => {
    // `0` here means "the counter exists and this call added nothing to it", which is true: with no
    // velocity object `checkAndReserve` touches no window row at all. The broken case it could mask
    // is a velocity guard that stopped working, so the assertion pairs it with the table being
    // empty — and the default-configuration case above pairs a filled window with a real row.
    const { adapter, budgetStore, receipts, report } = makeFixture({ velocityOff: true });

    await adapter.fetch('smart-money.flows', ARGS, undefined, report);

    expect(creditsOf(receipts)).toBeGreaterThan(0);
    expect(callsOf(receipts)).toBe(0);
    for (const receipt of receipts) expect(receipt.at?.windowStartMs).toBeNull();
    expect(await budgetStore.getWindowUsage('nansen', BUCKET)).toBe(0);
  });
});

describe('TC-UNIT-03: one vendor call, two charges — the follower carries coordinates, not money', () => {
  it('gives the follower the leader s buckets and typed nulls for the amounts', async () => {
    const { adapter, budgetStore, report, receipts, reserveSpy } = makeFixture();
    const followerReceipts: VendorSpendRecord[] = [];

    // No `await` between the two starts, so the second call finds the first in flight.
    const leader = adapter.fetch('smart-money.flows', ARGS, undefined, report);
    const follower = adapter.fetch('smart-money.flows', ARGS, undefined, (record) => {
      followerReceipts.push(record);
    });
    await Promise.all([leader, follower]);

    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(followerReceipts).toHaveLength(1);
    const coalesced = followerReceipts[0]!;
    expect(coalesced.kind).toBe('coalesced');
    expect(coalesced.providerId).toBe('nansen');
    // The join key T-015 needs: the follower names the buckets that hold the leader's spend.
    expect(coalesced.at).toStrictEqual(receipts[0]!.at);
    // Explicit, because this is the whole reason the arm is typed rather than merely documented:
    // duplicating the leader's amount here is what would double-count the day.
    expect(coalesced.credits).toBeNull();
    expect(coalesced.calls).toBeNull();

    // And the day was charged exactly once, by the leader.
    expect(creditsOf([...receipts, ...followerReceipts])).toBe(
      await budgetStore.getUsage('nansen', BUCKET),
    );
  });
});

describe('a broken consumer never fails a paid call', () => {
  it('absorbs a throwing reporter and still returns the result', async () => {
    // Every reporter call site sits downstream of a COMMITTED write, so letting a consumer's
    // exception propagate would reject a call whose credits are already gone — the same defect
    // class as reconcile s L-3/L-4 handler and the budget gate s warn block.
    const { adapter } = makeFixture();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(
      adapter.fetch('smart-money.flows', ARGS, undefined, () => {
        throw new Error('consumer is broken');
      }),
    ).resolves.toBeDefined();

    expect(
      stderr.mock.calls.some(([line]) => String(line).includes('vendor spend: reporter threw')),
    ).toBe(true);
    stderr.mockRestore();
  });
});
