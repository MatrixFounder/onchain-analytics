/**
 * The per-call vendor-spend receipt (task 014-30, R-27.3) — how a committed write to `usage` /
 * `usage_window` is reported to whoever needs to attribute it to one request.
 *
 * **Why this lives beside `budget-store.ts` and is named after the ledger.** The consumer is
 * `mcp-server`'s `request_trace` writer, but the FACT is about the two tables this package owns.
 * `security.md` §7.5.1 and `deployment.md` §10.2.1 keep SQL naming `onchain.request_trace` outside
 * `packages/core/src`, so the word `request_trace` does not appear in this package at all — a type
 * named after the consumer would have imported that vocabulary through the back door.
 *
 * **Why a receipt rather than a return value.** Two independent reasons, both measured on the
 * shipped nansen path:
 *
 * - A logical call can COMMIT a reservation and then reject. `adapters/nansen/index.ts`'s catch
 *   reconciles whatever sub-responses did complete and rethrows, so `usage.credits_used` moves for
 *   a call whose `fetch()` throws. A value carried on the resolved result is lost on exactly the
 *   path where the money is hardest to account for.
 * - The value `fetch()` returns flows into `normalize()` and then into `CacheStore.set()`. Ledger
 *   coordinates embedded in it would be persisted in the cache entry and replayed verbatim on every
 *   later hit, so a request that spent nothing would report the bucket of a call made days ago.
 *
 * **Why the amount is never recomputed downstream.** Each receipt is built immediately after the
 * store call it describes, from the SAME local variables that were bound into that call
 * (`checkAndReserve`'s `cost`/`dayBucketMs`/`velocity.windowStartMs`, `recordDelta`'s
 * `signedDelta`). A second computation of "what did this request spend" — reading the counter
 * before and after, re-deriving the day bucket from a fresh clock, or echoing `costOf()` — is a
 * second source of truth for a number the ledger already holds, and the two would disagree on the
 * degrade paths where `reconcile()` forces its adjustment to zero.
 */

/**
 * The bucket coordinates of ONE ledger write — the keys, never a row reference.
 *
 * **Why coordinates and not a row id.** `usage` is keyed `(provider, day)` and `usage_window` is
 * keyed `(provider, window_start)`. Both are counters over windows; there is no per-write row to
 * point at, and inventing one would mean a second table whose only job is to be pointed at.
 */
export interface VendorLedgerCoordinates {
  /** The `dayBucketMs` argument the `usage` write was bound with. */
  readonly dayBucketMs: number;
  /**
   * The `windowStartMs` argument the `usage_window` write was bound with, or `null` when no
   * `usage_window` row exists for this call.
   *
   * **Why `null` is a real state and not an omission.** `SqliteBudgetStore.checkAndReserve` writes
   * the window row only inside its `if (velocity !== undefined)` branch, and the velocity object is
   * absent when an operator sets BOTH `NANSEN_VELOCITY_CREDITS_PER_MIN=off` and
   * `NANSEN_MAX_CALLS_PER_MIN=off`. The coordinate then has no referent, and reporting a computed
   * window would name a bucket that was never written.
   *
   * `| null` rather than an optional property, for the reason `data-model.md` §4.5.3 gives about
   * pairing every limit with a mode: an omitted key is indistinguishable from a key its writer
   * forgot, while an explicit `null` is a decision that was made.
   */
  readonly windowStartMs: number | null;
}

/**
 * One COMMITTED ledger write, reported by the function that made it.
 *
 * Exactly two functions in this repository write to `usage`/`usage_window`, so exactly two
 * construct this record: `adapters/nansen/budget-gate.ts` (the reservation) and
 * `adapters/nansen/reconcile.ts` (the signed adjustment). A logical call that reaches the vendor
 * therefore produces two of these, and their `credits` sum to what the request added to the day
 * counter.
 */
export interface VendorChargeRecord {
  /**
   * Shape version.
   *
   * **Why a version on a type that has exactly one producer today.** A reader that meets an
   * unfamiliar version must REFUSE loudly rather than fall back to writing nulls. A silent
   * degrade-to-null here would be indistinguishable from "this request spent nothing", which is the
   * failure this whole channel exists to make impossible.
   */
  readonly v: 1;
  readonly kind: 'charge';
  /** The provider whose ledger moved — `usage`/`usage_window`'s own `provider` key. */
  readonly providerId: string;
  /**
   * Which of the two writes this was.
   *
   * Not a column of anything: it exists so a consumer can tell "reserved, never reconciled" from a
   * completed pair. A logical call that produced only a `reservation` receipt either failed before
   * `reconcile()` ran or hit one of `reconcile()`'s degrade branches, and that distinction is what
   * an operator needs when the day's totals look wrong.
   */
  readonly write: 'reservation' | 'reconciliation';
  readonly at: VendorLedgerCoordinates;
  /**
   * The SIGNED contribution of this write to `usage.credits_used`: the reserved `cost` for a
   * `reservation`, the `actual - reserved` adjustment for a `reconciliation`.
   *
   * Never the sum of `X-Nansen-Credits-Used` headers and never `costOf()`. Those are inputs to the
   * ledger write, not the write itself, and they diverge from it on each of `reconcile()`'s three
   * degrade branches (unparseable header, implausible sum, full refund).
   */
  readonly credits: number;
  /**
   * The contribution of this write to `usage_window.calls_made`: `1` for a reservation that created
   * or updated a window row, `0` otherwise.
   *
   * **Why this is not the number of HTTP round trips.** `checkAndReserve` increments `calls_made` by
   * a hardcoded `1` once per logical call, and `recordDelta` writes `0` by design — a call is not
   * refundable the way a credit is. `smart-money.flows` makes two HTTPS round trips and contributes
   * exactly `1`. An implementation that reported `subResponses.length` would be reporting a number
   * the ledger does not hold.
   */
  readonly calls: 0 | 1;
}

/**
 * This request waited on another caller's in-flight vendor call and spent nothing of its own.
 *
 * **Why a follower gets a record at all.** The owner's model charges both clients (OQ-6) while one
 * vendor call served both. Without a record naming the leader's buckets, the number of charges one
 * vendor call produced cannot be recovered from the ledger, which is precisely the quantity T-015
 * reconciles against `usage` (R-27.3).
 */
export interface VendorCoalescedRecord {
  readonly v: 1;
  readonly kind: 'coalesced';
  /**
   * The adapter this call was a follower on — always known, because the follower knows which
   * adapter's in-flight call it joined.
   *
   * This is what separates "waited on a vendor call whose buckets are not yet knowable" from "no
   * vendor was involved at all": the first has a provider and null coordinates, the second has no
   * record at all.
   */
  readonly providerId: string;
  /**
   * The LEADER's coordinates, or `null` when the leader had not committed a reservation by the time
   * this follower settled.
   *
   * **Why the follower cannot compute these itself.** The leader pins its window from a SECOND
   * clock read, after a conditional `/account` resync that performs a store read, a throttle wait
   * and a real HTTPS round trip. A velocity window is 60 000 ms wide and all three nansen
   * capabilities declare `deadlineMs: 60_000`, so a follower's legal wait spans a full window: a
   * self-derived coordinate would routinely name a bucket that holds none of this spend.
   *
   * **Why `null` is reachable and not a defensive branch.** A follower whose own deadline expires
   * rejects without touching the leader, and at that instant the leader may still be inside its
   * resync. There is no honest coordinate to report, and R-27.7 forbids revising the row later.
   */
  readonly at: VendorLedgerCoordinates | null;
  /**
   * Typed `null`, never a number and never `0`.
   *
   * **Why the type, and not a rule inside the function that collapses these.** `data-model.md`
   * §4.5.7 requires NULL rather than `0` on a follower's row: zero asserts that the spend was
   * measured here and came to nothing, which is false — it sits on the leader's row. Making the
   * field structurally incapable of holding a number means "hand the follower the leader's amount"
   * cannot be written, rather than being forbidden by a comment somebody later edits. `credits ?? 0`
   * is a compile error.
   */
  readonly credits: null;
  /** Typed `null` for the same reason as {@link VendorCoalescedRecord.credits}. */
  readonly calls: null;
}

export type VendorSpendRecord = VendorChargeRecord | VendorCoalescedRecord;

/**
 * How a receipt leaves the layer that wrote the ledger.
 *
 * **A reporter must not throw.** Every call site is downstream of a COMMITTED write, so an
 * exception here would fail a call whose money is already spent — the same class of defect
 * `reconcile()`'s own L-3/L-4 handler and `budget-gate.ts`'s warn block were written against.
 * Producers wrap the invocation and degrade to one stderr line, so a faulty consumer costs a
 * diagnostic and never a paid result.
 *
 * **Synchronous, and called exactly once per write.** Awaiting a consumer would put an unbounded
 * third-party continuation between a ledger write and the code that must still run after it.
 */
export type VendorSpendReporter = (record: VendorSpendRecord) => void;

/**
 * Invokes `report` and absorbs anything it throws, naming the failure on stderr.
 *
 * Shared by the three producers so the "never fail a committed write over an observability side
 * effect" contract has ONE implementation rather than three copies that can drift. stderr and never
 * stdout — that channel is the JSON-RPC wire (M0 §7.3 invariant).
 */
export function reportVendorSpend(
  report: VendorSpendReporter | undefined,
  record: VendorSpendRecord,
): void {
  if (report === undefined) return;
  try {
    report(record);
  } catch (error) {
    try {
      process.stderr.write(
        `vendor spend: reporter threw for provider=${record.providerId} kind=${record.kind} — ` +
          `the ledger write already committed and is unaffected: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {
      // stderr can throw EPIPE once a stdio client has closed. Diagnostics are best-effort; the
      // committed write is not in question either way.
    }
  }
}
