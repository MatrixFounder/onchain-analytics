import type { VendorSpendRecord } from '@onchain-intel/core';

/**
 * Collapses one request's vendor-spend receipts into the five columns of `request_trace`
 * (task 014-30, `data-model.md` §4.5.7).
 *
 * **Pure, and separate from the wrapper that calls it.** The collapse rules are the part a test can
 * exercise without a server, a transport or a clock: hand it a hand-built set of receipts and read
 * the five values back. The wrapper's job is to collect and to write; deciding what the numbers mean
 * is this function's.
 */

/** The five columns, in the record's own vocabulary. */
export interface VendorSpendColumns {
  readonly vendorProvider: string | null;
  readonly vendorCredits: number | null;
  readonly vendorCalls: number | null;
  readonly vendorDay: number | null;
  readonly vendorWindowStart: number | null;
}

/** Every column absent — no vendor was involved in this request at all. */
const NO_SPEND: VendorSpendColumns = {
  vendorProvider: null,
  vendorCredits: null,
  vendorCalls: null,
  vendorDay: null,
  vendorWindowStart: null,
};

export interface VendorSpendCollapse {
  readonly columns: VendorSpendColumns;
  /**
   * Receipts that could not be represented, because the row holds one provider's coordinates and
   * this request spent at more than one.
   *
   * **Empty on every route this repository defines**, measured: two adapters are registered
   * `tier: 'paid'` and one of them appears in no route, so no traversal can enter two. It is not
   * unreachable by construction, though — an unsatisfying answer does not stop the walk and neither
   * does a throw — so the case is represented rather than assumed away, and the caller is expected
   * to make it loud rather than drop it (L-2).
   */
  readonly dropped: readonly VendorSpendRecord[];
}

/**
 * **The collapse rule: the FIRST provider that produced a receipt fills the row.**
 *
 * Deliberately not `budget-meta.ts`'s "last paid provider entered". That rule is correct for what it
 * does — reporting a CUMULATIVE day counter, where the most recently entered source is the ledger
 * closest in time to the response — and it is wrong here, because these columns carry a DELTA. Under
 * "last wins" a first provider's spend is silently replaced; under "first wins" it is kept and the
 * remainder is named in `dropped`. Neither rule is right for two providers; only one of them loses
 * money quietly.
 *
 * **A `coalesced` receipt takes the row even when charges are present.** It cannot happen today —
 * one adapter coalesces and it is the only one that spends — and the ordering is stated rather than
 * left to the array: a follower's row must carry NULL amounts, and letting a charge from some other
 * provider fill them would attribute another request's spend to this one.
 */
export function vendorSpendColumns(receipts: readonly VendorSpendRecord[]): VendorSpendCollapse {
  if (receipts.length === 0) return { columns: NO_SPEND, dropped: [] };

  const coalesced = receipts.find((r) => r.kind === 'coalesced');
  if (coalesced !== undefined) {
    return {
      columns: {
        vendorProvider: coalesced.providerId,
        // Typed `null` on the record itself, so this is a restatement rather than a decision: one
        // vendor call served two charges, and the amount sits on the leader's row.
        vendorCredits: null,
        vendorCalls: null,
        vendorDay: coalesced.at?.dayBucketMs ?? null,
        vendorWindowStart: coalesced.at?.windowStartMs ?? null,
      },
      dropped: receipts.filter((r) => r !== coalesced),
    };
  }

  const charges = receipts.filter((r) => r.kind === 'charge');
  const first = charges[0];
  if (first === undefined) return { columns: NO_SPEND, dropped: [] };

  const mine = charges.filter((r) => r.providerId === first.providerId);
  return {
    columns: {
      vendorProvider: first.providerId,
      // The SUM of what was written, not of what was intended: a reservation and its reconciliation
      // are two writes and their signed total is what the day counter received.
      vendorCredits: mine.reduce((total, r) => total + r.credits, 0),
      vendorCalls: mine.reduce((total, r) => total + r.calls, 0),
      // Coordinates come from the FIRST write, which is the reservation — the one that created the
      // buckets. Both writes of a logical call carry the same pair by construction, since
      // reconciliation is threaded the reservation's own values rather than a fresh clock.
      vendorDay: first.at.dayBucketMs,
      vendorWindowStart: first.at.windowStartMs,
    },
    dropped: charges.filter((r) => r.providerId !== first.providerId),
  };
}
