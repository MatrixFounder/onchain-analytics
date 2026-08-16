import { describe, expect, it } from 'vitest';
import type { VendorSpendRecord } from '@onchain-intel/core';
import { vendorSpendColumns } from '../src/tools/vendor-spend-columns.js';

/**
 * Task 014-30 — the collapse from receipts to the five `request_trace` columns.
 *
 * Every case here is built by hand, with no server, transport or clock: the rules under test are
 * about MEANING, and a test that had to drive a real vendor call to reach them could not cover the
 * two-provider case at all — no route this repository defines can produce it.
 */

const DAY = 1_784_851_200_000;
const WINDOW = 1_784_851_260_000;

const charge = (over: Partial<Extract<VendorSpendRecord, { kind: 'charge' }>> = {}) =>
  ({
    v: 1,
    kind: 'charge',
    providerId: 'nansen',
    write: 'reservation',
    at: { dayBucketMs: DAY, windowStartMs: WINDOW },
    credits: 10,
    calls: 1,
    ...over,
  }) satisfies VendorSpendRecord;

const coalesced = (at: { dayBucketMs: number; windowStartMs: number | null } | null) =>
  ({
    v: 1,
    kind: 'coalesced',
    providerId: 'nansen',
    at,
    credits: null,
    calls: null,
  }) satisfies VendorSpendRecord;

describe('a request that touched no vendor', () => {
  it('leaves all five columns absent', () => {
    expect(vendorSpendColumns([])).toStrictEqual({
      columns: {
        vendorProvider: null,
        vendorCredits: null,
        vendorCalls: null,
        vendorDay: null,
        vendorWindowStart: null,
      },
      dropped: [],
    });
  });
});

describe('a leader', () => {
  it('sums the two writes and takes the coordinates from the reservation', () => {
    const { columns, dropped } = vendorSpendColumns([
      charge({ write: 'reservation', credits: 10, calls: 1 }),
      charge({ write: 'reconciliation', credits: -2, calls: 0 }),
    ]);

    expect(columns).toStrictEqual({
      vendorProvider: 'nansen',
      vendorCredits: 8,
      vendorCalls: 1,
      vendorDay: DAY,
      vendorWindowStart: WINDOW,
    });
    expect(dropped).toStrictEqual([]);
  });

  it('reports one call for a composite capability, not one per write', () => {
    // `usage_window.calls_made` is moved by the reservation alone, and by a fixed 1. A collapse that
    // counted receipts instead of summing their `calls` would report 2 here.
    const { columns } = vendorSpendColumns([
      charge({ write: 'reservation', calls: 1 }),
      charge({ write: 'reconciliation', calls: 0 }),
    ]);
    expect(columns.vendorCalls).toBe(1);
  });

  it('carries a null window through, rather than inventing one', () => {
    // Both velocity guards off: no `usage_window` row exists, so the coordinate has no referent.
    const { columns } = vendorSpendColumns([
      charge({ at: { dayBucketMs: DAY, windowStartMs: null }, calls: 0 }),
    ]);
    expect(columns.vendorWindowStart).toBeNull();
    expect(columns.vendorCalls).toBe(0);
    expect(columns.vendorCredits).toBe(10);
  });

  it('keeps a zero-credit call distinguishable from no call at all', () => {
    // `entity.labels`' query tier is priced 0 and still makes real round trips. `0` credits with a
    // filled provider is a served vendor call; NULL everywhere is a request that touched no vendor.
    const { columns } = vendorSpendColumns([charge({ credits: 0 })]);
    expect(columns.vendorProvider).toBe('nansen');
    expect(columns.vendorCredits).toBe(0);
  });
});

describe('a follower', () => {
  it('takes the leader s coordinates and no amounts', () => {
    const { columns } = vendorSpendColumns([
      coalesced({ dayBucketMs: DAY, windowStartMs: WINDOW }),
    ]);
    expect(columns).toStrictEqual({
      vendorProvider: 'nansen',
      vendorCredits: null,
      vendorCalls: null,
      vendorDay: DAY,
      vendorWindowStart: WINDOW,
    });
  });

  it('names the vendor even when the leader had published no coordinates', () => {
    // A follower whose own deadline expired before the leader reserved. `vendor_provider` is what
    // keeps this row distinguishable from a request that involved no vendor at all — without it the
    // two states are the same five NULLs.
    const { columns } = vendorSpendColumns([coalesced(null)]);
    expect(columns.vendorProvider).toBe('nansen');
    expect(columns.vendorDay).toBeNull();
    expect(columns.vendorWindowStart).toBeNull();
    expect(columns.vendorCredits).toBeNull();
  });

  it('never absorbs another provider s amounts, whatever else is in the set', () => {
    // Unreachable today and asserted anyway: the amount must stay on the leader's row, and this is
    // the mutation — "fill the nulls from whatever charge is around" — that would double the day.
    const { columns, dropped } = vendorSpendColumns([
      charge({ providerId: 'dune', credits: 99 }),
      coalesced({ dayBucketMs: DAY, windowStartMs: WINDOW }),
    ]);
    expect(columns.vendorCredits).toBeNull();
    expect(columns.vendorProvider).toBe('nansen');
    expect(dropped).toHaveLength(1);
  });
});

describe('two paid providers in one traversal', () => {
  it('keeps the FIRST provider s spend and names the rest as dropped', () => {
    // "Last wins" is what `budget-meta.ts` chose for a CUMULATIVE reading, and it is wrong for a
    // delta: it would silently replace the first provider's amount instead of reporting that the
    // row cannot hold both.
    const { columns, dropped } = vendorSpendColumns([
      charge({ providerId: 'nansen', credits: 10 }),
      charge({ providerId: 'dune', credits: 7, at: { dayBucketMs: DAY, windowStartMs: null } }),
    ]);

    expect(columns.vendorProvider).toBe('nansen');
    expect(columns.vendorCredits).toBe(10);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.providerId).toBe('dune');
  });

  it('sums only the receipts of the provider that filled the row', () => {
    // The three amounts are chosen so no two subsets share a total: nansen sums to 7, dune to 99,
    // and everything together to 106. An implementation that summed the whole array, or picked the
    // other provider, produces a number this assertion does not accept.
    const { columns } = vendorSpendColumns([
      charge({ providerId: 'nansen', write: 'reservation', credits: 10, calls: 1 }),
      charge({ providerId: 'dune', write: 'reservation', credits: 99, calls: 1 }),
      charge({ providerId: 'nansen', write: 'reconciliation', credits: -3, calls: 0 }),
    ]);
    expect(columns.vendorCredits).toBe(7);
    expect(columns.vendorCalls).toBe(1);
  });
});
