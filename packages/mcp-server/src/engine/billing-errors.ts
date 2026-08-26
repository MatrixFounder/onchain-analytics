/**
 * Task 015-04 — the four failure classes T-015's billing gate can produce
 * (`system-architecture.md` §3.5.1/§3.5.2/§3.5.2a).
 *
 * Three of them feed `BillingReserveResult`'s failure arm as the value of `refusalClass`
 * (`billing-store.ts`) — the SAME field name `request_trace.refusal_class` and
 * `ResolveFailure.refusalClass` already use (`packages/mcp-server/src/tools/resolve-capability.ts:200`).
 * The fourth, {@link LedgerReadNotAuthoritativeError}, never reaches that column: it is a refusal of
 * an accounting READ (`sumSettled`), not of a request, and it is not a member of `BillingRefusalClass`.
 *
 * **`ClientCreditsExhaustedError` and `BillingStoreUnavailableError` are returned as a VALUE, never
 * thrown** (`system-architecture.md` §3.5.1's own docstring on `reserve()`; §3.5.2 step 4). They are
 * declared as `class … extends Error` anyway, for the same reason `DeadlineWideningRefusedError` and
 * `CapabilityManifestMissingError` are in `resolve-capability.ts` even though a handler never lets
 * either escape a `throw`: the class keeps the name that lands in a database column in one place
 * with the text that explains it, and `this.name` is assigned explicitly so the value survives
 * bundling.
 *
 * **`ReplayWindowExpiredError` names the third value of the same field.** The conflict-detection
 * branch that decides when to return it belongs to task 015-08 (`system-architecture.md`
 * §3.5.2a, `:4162-4176`); this file only declares the class its name comes from.
 *
 * **Why `sumSettled`'s refusal is a fourth, separate class rather than a fourth `BillingRefusalClass`
 * value.** A request refusal and a read refusal answer different questions — whether a CALL was
 * admitted, versus whether an AGGREGATE READ is authoritative on this storage axis — and only the
 * first is ever written to `request_trace.refusal_class`.
 */

/** R-3.3, closes `ADR-003` OQ-2 — the metered profile's balance cannot cover `priceRaw` at
 * `reserve()` time. Returned as `{ ok: false, refusalClass: 'ClientCreditsExhaustedError' }`, never
 * thrown (see this file's own docstring above). */
export class ClientCreditsExhaustedError extends Error {
  constructor(message = 'client credits exhausted') {
    super(message);
    this.name = 'ClientCreditsExhaustedError';
  }
}

/** R-3.7, closes `ADR-003` OQ-9 — the ledger itself could not be reached at `reserve()` time (the
 * `AccessProfileReader` unreachable, the transaction's connection lost). Fail-closed: no call is
 * served for free because the ledger could not answer. Returned as a value, same rule as
 * {@link ClientCreditsExhaustedError}. */
export class BillingStoreUnavailableError extends Error {
  constructor(message = 'billing store unavailable') {
    super(message);
    this.name = 'BillingStoreUnavailableError';
  }
}

/** R-5.7, closes `ADR-003` OQ-G — a conflicting `client_request_id` arrived after its own replay
 * window (`data-model.md` §4.6.1's derived `windowMs`) had already closed. Task 015-08 owns the
 * branch that throws/returns this; this class only declares the name that branch produces. */
export class ReplayWindowExpiredError extends Error {
  constructor(message = 'replay window expired') {
    super(message);
    this.name = 'ReplayWindowExpiredError';
  }
}

/**
 * R-7.3, AC-15 — `sumSettled` is authoritative on the Postgres axis only (`data-model.md` §4.6.1,
 * "Storage axis — only Postgres rows are authoritative"). The SQLite-axis implementation (task
 * 015-06) throws this rather than returning `'0'`.
 *
 * **Why a throw, not a confident `'0'`.** A legal-negative return is the shape L-10 already paid
 * for: 43 networks answered a confident zero and the eval stayed green through it. A reader of
 * AC-4's aggregate could not tell "nothing to sum this period" from "this storage axis cannot
 * answer at all" if both returned the same string.
 */
export class LedgerReadNotAuthoritativeError extends Error {
  constructor(message = 'sumSettled is authoritative on the Postgres axis only') {
    super(message);
    this.name = 'LedgerReadNotAuthoritativeError';
  }
}
