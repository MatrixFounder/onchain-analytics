import { ulid } from '../ulid.js';
import { LedgerReadNotAuthoritativeError } from './billing-errors.js';

/**
 * Task 015-04 — `BillingStore`: the shape, and a stub under it (`[STUB]`).
 *
 * `data-model.md` §4.6.1 owns `client_usage`, the table this interface reads and writes.
 * `system-architecture.md` §3.5.1 owns where this contract runs and why. This file declares the
 * contract once, before task 015-06 (SQLite axis) and task 015-07 (Postgres axis) each build a
 * repository under it — the same "contract before implementations" discipline task 014-02 already
 * applied to `RequestTraceStore`/`DiagnosticsStore`, and for the same reason: a contract inferred
 * from the FIRST implementation gets rewritten by the second (precedent: task 014-02, restated in
 * task 015-06's own plan entry).
 *
 * **Why this file, not `packages/core`.** `client_usage` carries `principalId`/`accessProfileId`,
 * so it belongs beside `RequestTraceStore`/`DiagnosticsStore` (`data-model.md` §4.6's own
 * package-boundary note, `security.md` §7.5.1: "`packages/core` gains no knowledge of tokens, roles
 * or headers"). `packages/core` gains no new export for T-015.
 *
 * **This task ships NO working logic.** No table is created (SQLite DDL: task 015-02, already
 * landed in `packages/core/src/cache/ddl.ts`; Postgres migration: task 015-03), no price list
 * (task 015-05), no replay-window/conflict branch (task 015-08), and `ToolContext` gains no
 * `billing` field (task 015-09). What follows is the interface, the four failure-class names it can
 * carry (`billing-errors.ts`), and an in-memory stub that enforces exactly the two properties of
 * `client_usage` a caller can observe without a database.
 */

/**
 * One row's ledger-visible state, returned from `reserve()`.
 *
 * **`existing` is REQUIRED, not optional** (closes architecture review round 1 MINOR-4). The
 * declared return shape carries it unconditionally; making it optional would have given a consumer
 * a third value, `undefined`, that this contract assigns no meaning to. `true` marks the retry case
 * (R-5.2, UC-2): a row for this `(principalId, clientRequestId)` pair already existed before this
 * call, on ANY state.
 */
export interface BillingReservation {
  readonly rowId: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  readonly existing: boolean;
}

/**
 * The three values `reserve()`'s failure arm can carry as `refusalClass` (`system-architecture.md`
 * §3.5.1's declared shape, §3.5.2's interception-point pseudocode, §3.5.2a's replay window).
 *
 * A closed union, not `string` (closes architecture review round 2 MAJOR-D): task 015-09's wrapper
 * is obligated to READ this value, never to supply a literal of its own, and a fourth value reaching
 * this field becomes a compile error here rather than an unclassified string in `request_trace`.
 */
export type BillingRefusalClass =
  'ClientCreditsExhaustedError' | 'BillingStoreUnavailableError' | 'ReplayWindowExpiredError';

/**
 * `reserve()`'s return type (`system-architecture.md:3984`, amended by this task to carry the
 * class the failure arm was always missing — closes architecture review round 2 MAJOR-D).
 *
 * **`refusalClass` is REQUIRED on the failure arm, not optional.** The precedent is
 * `ResolveFailure.refusalClass` (`packages/mcp-server/src/tools/resolve-capability.ts:200`,
 * `refusalClass: string;`), required there because `request_trace.refusal_class` is `NOT NULL`
 * behind a `CHECK` constraint on a refusal row — the same reason applies here, one layer earlier: an
 * optional field would let this failure arm be constructed without the value the wrapper (task
 * 015-09) is obligated to forward into that column.
 */
export type BillingReserveResult =
  | { ok: true; reservation: BillingReservation }
  | { ok: false; reason: string; refusalClass: BillingRefusalClass };

/**
 * `client_usage`, camelCased — the full row shape the stub holds in memory (`data-model.md` §4.6.1's
 * declared columns, minus nothing). `BillingReservation` is the SUBSET of this row a caller of
 * `reserve()` needs back; `BillingLedgerRow` is the full row a test needs to assert against, the
 * same split `RequestTraceRecord`/`RequestTraceAppendResult` already make in
 * `request-trace-store.ts`.
 */
export interface BillingLedgerRow {
  readonly id: string;
  readonly principalId: string;
  readonly accessProfileId: string | null;
  readonly clientRequestId: string;
  readonly tool: string;
  readonly capability: string | null;
  readonly priceRaw: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  readonly refundReason: string | null;
  readonly reservedAt: number;
  readonly terminalAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The client billing ledger T-015 charges into (`data-model.md` §4.6.1, `system-architecture.md`
 * §3.5.1, R-1/R-2/R-5/R-7).
 */
export interface BillingStore {
  /**
   * Idempotent by `(principalId, clientRequestId)` — an existing row of ANY state short-circuits a
   * new write (`data-model.md` §4.6.1: "The dedup key carries no time component", R-5.1). Under
   * `credits_mode='metered'` a real implementation ALSO debits `access_profiles.credits_balance_raw`
   * atomically, in the SAME transaction, refusing with `ClientCreditsExhaustedError` and NOTHING
   * written to either table when the balance cannot cover `priceRaw` (`data-model.md` §4.6.1's
   * "Balance arithmetic", mirroring `checkAndReserve`'s "on ok:false nothing is written" contract,
   * `packages/core/src/cache/budget-store.ts:50-51`).
   *
   * **Both `ClientCreditsExhaustedError` and `BillingStoreUnavailableError` are returned as the
   * VALUE `{ ok: false, refusalClass }`, never thrown** (`system-architecture.md` §3.5.2 step 4). A
   * throw would skip both the `request_trace` row and the `tool.refused` diagnostics event the
   * wrapper writes from `outcome` — the exact silence closing architecture review round 1 BLOCKING-3
   * removed.
   *
   * This task declares the shape and ships a stub under it. No table exists yet (015-02/015-03
   * shipped the DDL only), no balance debit runs, and the replay-window conflict branch that can
   * return `ReplayWindowExpiredError` belongs to task 015-08.
   */
  reserve(input: {
    principalId: string;
    accessProfileId: string | null;
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }): Promise<BillingReserveResult>;

  /**
   * Conditional `UPDATE … WHERE state = 'reserved'` (`data-model.md` §4.6.1) — a no-op, not an
   * error, when the row already left `'reserved'` (first completer wins, `system-architecture.md`
   * §3.5.3). No balance effect: the amount was already debited at `reserve()`.
   */
  settle(rowId: string): Promise<void>;

  /**
   * Conditional `UPDATE … WHERE state = 'reserved'`, PLUS — under `credits_mode='metered'` — a
   * real implementation credits `priceRaw` back onto the profile's balance, in the same transaction
   * as the state transition. A no-op, not an error, on an already-terminal row, same rule as
   * {@link BillingStore.settle}.
   */
  refund(rowId: string, reason: string): Promise<void>;

  /**
   * `data-model.md` §4.6.1's AC-4 aggregate — sum of `price_raw` over `settled` rows whose
   * `terminal_at` falls in `[periodFromMs, periodToMs)`. **Postgres axis only** (R-7.3): `client_usage`
   * follows the SAME storage axis as `CacheStore`/`BudgetStore`/`LimiterStore`
   * (`system-architecture.md` §3.4.8), so only Postgres rows are authoritative
   * (`data-model.md` §4.6.1, "Storage axis"). An implementation on the SQLite axis throws
   * {@link LedgerReadNotAuthoritativeError} rather than returning `'0'` — a confident zero is the
   * legal-negative shape L-10 already named the cost of.
   *
   * **MANDATORY, not optional** — mirrors why `ToolContext.billing` itself carries no `?`
   * (`system-architecture.md` §3.5.2).
   *
   * **Returns a `string`, never a `number`.** `price_raw` exceeds the safe 2^53 of a JS number
   * (`DB-SCHEMA-CONCEPT` §1.7); the sum is exact `BigInt`/`numeric` arithmetic, encoded as text.
   */
  sumSettled(periodFromMs: number, periodToMs: number): Promise<string>;
}

/**
 * The stub, `[STUB]` in the task title's sense: it holds rows in memory and enforces exactly the two
 * properties of `client_usage` a caller can observe without a database.
 *
 * **Why the stub enforces the dedup key.** A stub that accepted every `reserve()` call as new would
 * model a table WITHOUT its unique index, and every consumer written against it would be written
 * against a ledger that double-counts. The same argument is already recorded for the trace stub
 * (`request-trace-store.ts`, "Why the stub enforces the key at all").
 *
 * **Why the stub enforces the conditional transition.** `settle`/`refund` are `WHERE state =
 * 'reserved'` updates; a stub that always transitioned would hide the "first completer wins" rule
 * (`system-architecture.md` §3.5.3) from every test written against it.
 *
 * **What the stub deliberately does NOT model.** No balance debit/credit against
 * `access_profiles.credits_balance_raw` (015-06/015-07), no replay-window conflict branch (015-08),
 * and `sumSettled` on the Postgres axis returns a fixed `'0'` rather than summing `rows` — computing
 * that sum here would be the aggregate-read logic 015-07 owns, built against an array instead of a
 * table. `sumSettledAxis` exists so the SQLite-axis refusal (MINOR-5, AC-15) has something to test
 * before either real implementation exists.
 *
 * **Why `rows` is exposed.** A store whose effect cannot be read back can only be checked by the
 * value it returns, leaving "the row we stored is the row we were handed" unasserted — the same
 * argument already recorded for `RequestTraceStoreStub.appended`.
 */
export interface BillingStoreStub extends BillingStore {
  readonly rows: readonly BillingLedgerRow[];
}

export function createBillingStoreStub(options?: {
  now?: () => number;
  sumSettledAxis?: 'postgres' | 'sqlite';
}): BillingStoreStub {
  const now = options?.now ?? ((): number => Date.now());
  const axis = options?.sumSettledAxis ?? 'postgres';
  const rows: BillingLedgerRow[] = [];
  // The declared dedup key, `(principalId, clientRequestId)` — WITHOUT `receivedAt`, unlike
  // `request_trace`'s own key (`data-model.md` §4.6.1: "The dedup key carries no time component").
  const byKey = new Map<string, string>(); // dedup key -> rowId

  function dedupKey(principalId: string, clientRequestId: string): string {
    return JSON.stringify([principalId, clientRequestId]);
  }

  const store: BillingStoreStub = {
    rows,

    async reserve(input): Promise<BillingReserveResult> {
      const key = dedupKey(input.principalId, input.clientRequestId);
      const existingRowId = byKey.get(key);
      if (existingRowId !== undefined) {
        const existingRow = rows.find((row) => row.id === existingRowId);
        if (existingRow !== undefined) {
          return {
            ok: true,
            reservation: { rowId: existingRow.id, state: existingRow.state, existing: true },
          };
        }
      }

      const ts = now();
      const row: BillingLedgerRow = {
        id: ulid(ts),
        principalId: input.principalId,
        accessProfileId: input.accessProfileId,
        clientRequestId: input.clientRequestId,
        tool: input.tool,
        capability: input.capability,
        priceRaw: input.priceRaw,
        state: 'reserved',
        refundReason: null,
        reservedAt: ts,
        terminalAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      rows.push(row);
      byKey.set(key, row.id);
      return { ok: true, reservation: { rowId: row.id, state: row.state, existing: false } };
    },

    async settle(rowId: string): Promise<void> {
      const index = rows.findIndex((row) => row.id === rowId);
      if (index === -1) return; // unknown row — same as an UPDATE matching zero rows
      const current = rows[index];
      if (current === undefined || current.state !== 'reserved') return; // conditional: first completer wins
      const ts = now();
      rows[index] = { ...current, state: 'settled', terminalAt: ts, updatedAt: ts };
    },

    async refund(rowId: string, reason: string): Promise<void> {
      const index = rows.findIndex((row) => row.id === rowId);
      if (index === -1) return;
      const current = rows[index];
      if (current === undefined || current.state !== 'reserved') return;
      const ts = now();
      rows[index] = {
        ...current,
        state: 'refunded',
        refundReason: reason,
        terminalAt: ts,
        updatedAt: ts,
      };
    },

    // `periodFromMs`/`periodToMs` are declared on `BillingStore.sumSettled` but taken by neither
    // arm below — see this interface's own docstring on why summing `rows` here would be 015-07's
    // aggregate-read logic, built against an array instead of a table. Omitted rather than named
    // and unused (same convention as `AccessProfileStoreStub.read()`, `auth/access-profile-store.ts`).
    async sumSettled(): Promise<string> {
      if (axis === 'sqlite') {
        throw new LedgerReadNotAuthoritativeError();
      }
      return '0';
    },
  };

  return store;
}
