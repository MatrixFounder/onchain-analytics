import type { CapabilityWalk } from '@onchain-intel/core';
import { isPaidProvider } from './budget-meta.js';

/**
 * Detecting a free→paid escalation on one request (task 014-28, R-28, AC-43).
 *
 * **The condition, decided 2026-08-20 (`OQ-014-28-A`).** A free source was ENTERED on a walk and a
 * paid one was entered after it. That is `data-model.md` §4.5.7's reading; the alternative in R-28.1
 * — "the free source was EXHAUSTED" — was rejected because AT THE TIME this engine kept no counter
 * for it: `blockscout`'s PRO key meters credits at the VENDOR, and `ADR-003` assigned the counter
 * that reading needed to T-015. Under the rejected reading the mechanism would have shipped and
 * never fired once, which is a green criterion over a dead feature.
 *
 * **T-015 (tasks 015-12..015-15) has since built that counter** — `usage.calls_made`, behind the
 * daily call-ceiling gate at `adapters/blockscout/call-gate.ts` — and this function still does not
 * read it. Not an oversight, and not the rejected reading revived: that counter measures admitted
 * CALLS against OUR OWN declared ceiling — an estimate of the vendor's undisclosed budget — never
 * the vendor-metered CREDITS R-28.1 actually asked about, and the tier-based condition below already
 * classifies the one route (`gas.price`) an exhaustion-based signal would get wrong (see "Why the
 * classification is `tier`" below). A counter existing is not by itself a reason to key a settled
 * decision on it.
 *
 * **"Entered and then a paid one was entered" already implies the free one did not satisfy.** A walk
 * stops at the source that answers, so a free adapter that satisfied is never followed by a paid
 * one. The single exception would be a merge walk, and `assertMergeParticipantsAreFree` makes every
 * merge participant free — so no merge can reach a paid source at all.
 *
 * **Why the classification is `tier` and never the presence of a spend receipt.** `ADR-003` D6
 * extends the call counter to every provider, so `gas.price` — `['rpc-evm', 'blockscout']`, both
 * `tier: 'free'` — produces receipts with no paid participant anywhere. Inferring paid-ness from
 * spend would set `escalated_to_paid = 1` on a walk whose own `_meta.budget` is absent, because
 * `paidProviderToReport` found no `tier: 'paid'` among the entered. One classification, `ADR-002` D8.
 */

export interface Escalation {
  readonly capability: string;
  readonly chain: string;
  /** The free source that was entered and did not satisfy. */
  readonly from: string;
  /** The paid source entered after it. */
  readonly to: string;
}

/**
 * The first escalation among this request's walks, or `null`.
 *
 * **The pair reported is the paid source and the free one entered immediately before it**, not the
 * first free of the route. `adapterIds` order encodes spend priority (free/cheap first), so the
 * adapter directly ahead of the paid one is the last cheaper option that was tried — which is the
 * one an operator would look at to ask why it did not answer.
 *
 * **A paid source that was entered and then FAILED still counts** (decided 2026-08-20). The rule is
 * "entered", the same rule `paidProviderToReport` applies, and for the same reason: a source that
 * was entered can have committed a reservation. The escalation happened; whether it produced an
 * answer is a different column.
 */
export function detectEscalation(walks: readonly CapabilityWalk[]): Escalation | null {
  for (const walk of walks) {
    // The FIRST paid source, which is what makes the predecessor search unnecessary: everything
    // ahead of it is non-paid by construction. An earlier draft scanned backwards for a free source
    // and re-tested each candidate — two conditions no test could distinguish from their own
    // removal, which is the same shape as a dead line.
    const paidAt = walk.tried.findIndex((attempt) => isPaidProvider(attempt.adapterId));
    const paid = walk.tried[paidAt];
    // `paidAt - 1` is the whole condition, and it needs no guard of its own: `-1` (no paid source)
    // and `0` (a paid source escalated FROM nothing) both index outside the array and answer
    // `undefined`. An explicit `if (paidAt <= 0) continue;` above this was tried and removed — no
    // test could tell it from its own deletion, which is the same shape as a dead line.
    const before = walk.tried[paidAt - 1];
    if (paid === undefined || before === undefined) continue;
    return {
      capability: walk.capability,
      chain: walk.chain,
      from: before.adapterId,
      to: paid.adapterId,
    };
  }
  return null;
}
