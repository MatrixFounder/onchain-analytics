import type { BudgetStore } from '../../cache/budget-store.js';
import { reportVendorSpend, type VendorSpendReporter } from '../../cache/vendor-spend.js';
import type { NansenAccountState } from './account-state.js';
import type { NansenEndpointResult } from './endpoints.js';

/**
 * Deps for `reconcile()` (system-architecture.md §3.2 "Post-call reconciliation", task 005-5,
 * R-38). `subResponses` is EVERY sub-call `NansenEndpointResult` produced by ONE logical `fetch()`
 * call (1 for `entity.labels`'s `exhaustive` tier, 2 for `smart-money.flows`/`token.risk`, 2 or 3
 * for `entity.labels`'s default/token-scoped tiers) — this function is called EXACTLY ONCE per
 * logical `fetch()`, always AFTER every sub-call has already settled successfully (a sub-call
 * throwing means `fetch()`'s own composition never reaches this call at all, `index.ts`).
 * `reservedTotal`/`bucket` are the SAME values `ensureBudget()` returned for THIS logical call —
 * never recomputed here.
 */
export interface ReconcileDeps {
  subResponses: NansenEndpointResult[];
  reservedTotal: number;
  bucket: number;
  /** The velocity window the RESERVATION was written into (SEC-1), passed straight through from
   * `ensureBudget()` — never recomputed from a fresh clock here. A call that outlives its window
   * would otherwise refund into a window that never spent, which is the one way a rate brake can
   * hand a runaway loop extra headroom. `undefined` when the guard is off. */
  window?: number;
  budgetStore: BudgetStore;
  accountState: NansenAccountState;
  /**
   * Where this call's COMMITTED adjustment is reported (task 014-30, R-27.3).
   *
   * The receipt is published after `recordDelta()` resolves and carries `delta` — the signed number
   * this function actually wrote — never `actualTotal` and never `reservedTotal`. On each of the
   * three degrade branches below the adjustment is forced to `0` while both of those inputs are
   * non-zero, so reporting either one would name money the ledger never moved.
   */
  onVendorSpend?: VendorSpendReporter;
}

/**
 * Floor for the implausible-sum guard below, so a genuinely cheap call (e.g. a 0-credit
 * `entity.labels` query-only tier, where `reservedTotal * 10 === 0`) still tolerates a small
 * legitimate over-report instead of tripping the guard on every response. 200 credits is well
 * above any documented single-call cost (the dearest M2 path is the 100cr exhaustive tier).
 */
const MIN_PLAUSIBLE_ACTUAL_CEILING = 200;

/**
 * Post-call credit reconciliation (task 005-5, R-38): sums EVERY sub-response's
 * `X-Nansen-Credits-Used` header into `actualTotal`, then writes `actualTotal - reservedTotal` as
 * ONE signed adjustment against the SAME `bucket` the reservation used — the same additive-upsert
 * write path `BudgetStore` already uses for the reservation itself (data-model.md §4.2), never a
 * separate replacing write.
 *
 * **Composite-capability defect this guards against (C-1, found on review):** reconciling
 * per-response instead of once-per-`fetch()` would, for a two-sub-call capability
 * (`smart-money.flows`/`token.risk`), sum `(5-10) + (5-10) = 0` against a genuinely-spent 10 — the
 * counter would silently cancel itself out on EVERY paid call to those capabilities. Summing all
 * `subResponses` first and writing the adjustment ONCE (below) is what avoids that.
 *
 * **Fail-safe degrade, never a partial sum:** a missing (`null`), blank, non-integer, negative, or
 * unsafe-range header on ANY ONE sub-response degrades the ENTIRE adjustment to `0` — a partial
 * sum over just the sub-responses whose header DID parse would systematically under-report the
 * real spend (the same shape of error as the C-1 case above, just one-sided) — worse than a
 * conservative zero. **Domain validation, not just finiteness (M-1, adversarial review cycle 1):**
 * `Headers.get()` returns `""` (not `null`) for a present-but-empty header — legal HTTP — and
 * `Number("")`/`Number("  ")` are both `0`, which IS finite; a plain `Number.isFinite()` check
 * therefore silently accepted an empty/whitespace header as a genuine `0`, and `Number("-600")`/
 * `Number("1e21")` are finite too (a negative header wipes out other calls' legitimately recorded
 * spend; an absurdly large one self-DoSes the bucket). Every header must parse to a non-negative,
 * safe integer or the whole call degrades. The pre-existing reservation is left exactly as-is
 * (never zeroed), `accountState.markUnreconciled()` is set so the NEXT budget-gate entry is forced
 * to resync `/account` rather than trust the now-suspect local counter, and exactly one stderr
 * line records the degrade (never stdout — the JSON-RPC wire, M0 §7.3 invariant).
 *
 * **A full refund is a signal, not a fact (M-1):** even when every header DOES parse cleanly, a
 * paid capability (`reservedTotal > 0`) whose headers sum to exactly `0` is treated the same
 * way — `markUnreconciled()` + one stderr line — while STILL writing the (fully-refunding) delta,
 * since the headers themselves were individually valid. This forces a resync before the next call
 * rather than silently trusting a run of unexamined full-refund responses.
 */
export async function reconcile(deps: ReconcileDeps): Promise<void> {
  const { subResponses, reservedTotal, bucket, window, budgetStore, accountState, onVendorSpend } =
    deps;

  let actualTotal = 0;
  let everyHeaderParsed = true;
  for (const subResponse of subResponses) {
    const raw = subResponse.creditsUsedHeader;
    const parsedValue = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsedValue) || parsedValue < 0 || !Number.isSafeInteger(parsedValue)) {
      everyHeaderParsed = false;
      break;
    }
    actualTotal += parsedValue;
  }

  let delta: number;
  if (!everyHeaderParsed) {
    delta = 0;
    accountState.markUnreconciled();
    process.stderr.write(
      `nansen reconcile: missing/blank/non-integer/negative/unsafe-range X-Nansen-Credits-Used on ` +
        `at least one sub-response (bucket=${bucket}, reservedTotal=${reservedTotal}) — degrading ` +
        `this call's adjustment to zero, never a partial sum\n`,
    );
  } else if (actualTotal > Math.max(reservedTotal * 10, MIN_PLAUSIBLE_ACTUAL_CEILING)) {
    // Sanity-bound the SUM, not just each header (cycle-2 review R-1). The per-header check above
    // only rejects the unsafe-integer range, so a large-but-valid `X-Nansen-Credits-Used:
    // 999999999` (a vendor bug, or a WAF/CDN injecting a numeric header) was committed verbatim and
    // POISONED the day bucket: `usage.credits_used` jumps to ~1e9, and from then on
    // `checkAndReserve` refuses every call for the rest of the UTC day. The poisoned row persists
    // in SQLite, so there is no in-band recovery short of editing the DB.
    //
    // Note the perverse blast radius this guards: the anchor-rebased vendor ceiling SELF-HEALS on
    // the next resync (`usageAtObserve + creditsRemainingAtObserve` re-reads our own ledger), so
    // the lockout bites ONLY operators who set `NANSEN_DAILY_CREDIT_CAP` — i.e. exactly the
    // careful ones. Degrade to the same zero-adjustment + resync path as an unparseable header.
    delta = 0;
    accountState.markUnreconciled();
    process.stderr.write(
      `nansen reconcile: X-Nansen-Credits-Used summed to an implausible ${actualTotal} against ` +
        `reservedTotal=${reservedTotal} (bucket=${bucket}) — refusing to poison the day bucket; ` +
        `degrading this call's adjustment to zero and forcing a resync\n`,
    );
  } else {
    delta = actualTotal - reservedTotal;
    if (actualTotal === 0 && reservedTotal > 0) {
      accountState.markUnreconciled();
      process.stderr.write(
        `nansen reconcile: X-Nansen-Credits-Used summed to a FULL refund (reservedTotal=` +
          `${reservedTotal}, bucket=${bucket}) — every header parsed as a valid non-negative ` +
          `integer, but a paid capability reporting zero spend is treated as a signal, forcing a ` +
          `resync before the next call\n`,
      );
    }
  }

  // The 4th argument is OMITTED, never passed as an explicit `undefined`, when the velocity guard
  // is off: the call is then byte-identical to the pre-SEC-1 one, so nothing that observes this
  // call has to learn about a parameter that does not apply.
  if (window === undefined) await budgetStore.recordDelta('nansen', bucket, delta);
  else await budgetStore.recordDelta('nansen', bucket, delta, window);

  // ⟵ THE RECEIPT (task 014-30, R-27.3), published only AFTER the write above resolved: a receipt
  // emitted before it would claim an adjustment that a throwing `recordDelta` never made.
  //
  // `calls: 0` restates what `recordDelta` does rather than deciding it — a reconciliation adjusts
  // CREDITS and never the call count (Q-3), because the vendor round trip already happened and
  // "refunding" it would let a run of cheap-then-refunded calls walk past the limit that bounds
  // exactly that traffic.
  //
  // The coordinates are `bucket` and `window` as they were RESERVED, threaded down from
  // `ensureBudget()` and never recomputed from a fresh clock here — the same discipline that makes
  // this function refund into the window that actually spent. A call outliving its window therefore
  // reports the leader's window on both of its receipts, which is what makes them sum.
  reportVendorSpend(onVendorSpend, {
    v: 1,
    kind: 'charge',
    providerId: 'nansen',
    write: 'reconciliation',
    at: { dayBucketMs: bucket, windowStartMs: window ?? null },
    credits: delta,
    calls: 0,
  });
}
