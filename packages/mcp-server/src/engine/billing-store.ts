import { createSqliteStateClient, ttlFor } from '@onchain-intel/core';
import type { AccessProfileReader } from '../auth/access-profile.js';
import { ulid } from '../ulid.js';
import { ClientCreditsExhaustedError, LedgerReadNotAuthoritativeError } from './billing-errors.js';
import type { EngineStore } from './pg-engine-store.js';

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
 * Task 015-08 — the replay window's own upper bound (`ADR-003` OQ-G, owner decision 2026-08-26):
 * `min(ttlSeconds of the capability, this ceiling)`. The value below is not invented here — it is
 * twice the largest declared `deadlineMs` (`data-model.md` §4.6.5's own derivation), the SAME
 * threshold the background reconcile scan (`onchain-billing-reconcile`, task 015-18) uses for a stuck
 * `reserved` row. R-5.6 names the two as one bound; this constant is declared once, HERE ONLY, so the
 * two consumers cannot silently disagree (`data-model.md` §4.6.1, "One constant, two consumers, not
 * two literals").
 */
export const REPLAY_AND_RECONCILE_CEILING_MS = 120_000;

/**
 * The replay window's own derivation (`system-architecture.md` §3.5.2a, `data-model.md` §4.6.1,
 * closes `ADR-003` OQ-G) — `min(ttlFor(capability ?? tool) * 1000, REPLAY_AND_RECONCILE_CEILING_MS)`.
 *
 * **Why TTL is the right bound, not a compromise.** Inside TTL a replay cannot make the answer worse:
 * a fresh call at that same instant would read the SAME bytes back out of the cache, because the
 * entry is still alive. Past TTL it can, invisibly — the replay does not re-check the cache's own
 * freshness contract, it just reuses the reservation.
 *
 * **The lookup key is `capability ?? tool`, reused rather than re-derived.** The price list already
 * resolves a row this SAME way (`billing/price-list.ts`, `data-model.md` §4.6.2, "The lookup key is
 * `capability ?? tool`") — one derivation over two tables, not two derivations that could disagree on
 * which row a capability-less tool (`onchain_ping`, `onchain_list_chains`, `registry.ts:473`) falls
 * back to.
 *
 * **A capability-less tool lands on the ceiling through `ttlFor`'s own miss path, not a branch added
 * here.** `ttlFor(null ?? tool)` finds no manifest row for a bare tool name and returns
 * `DEFAULT_TTL_SECONDS` (300 s, `packages/core/src/cache/ttl.ts:21`); `300_000` is then clamped down
 * to the ceiling by the SAME `Math.min` every other capability goes through.
 */
export function replayWindowMs(row: { capability: string | null; tool: string }): number {
  return Math.min(ttlFor(row.capability ?? row.tool) * 1000, REPLAY_AND_RECONCILE_CEILING_MS);
}

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
 * `settle()`/`refund()`'s own return shape (task 015-10) — the SAME split
 * `RequestTraceAppendResult.written` already makes (`request-trace-store.ts:163`), reused here for
 * the identical reason: a caller that only awaits `Promise<void>` cannot tell "this call's own
 * conditional `UPDATE` actually transitioned the row" from "the row was already terminal and this
 * call did nothing" — and the wrapper (`tools/registry.ts`) needs exactly that distinction to name a
 * late outcome on stderr (MAJOR-9, `docs/tasks/task-015-10-reservation-lifecycle.md`'s own "Правило
 * позднего исхода" — "the observable trace is a stderr line naming the row id and its state").
 *
 * **`written: false` is not an error.** It is the STATED, first-completer-wins outcome
 * (`system-architecture.md` §3.5.3): the conditional `UPDATE … WHERE state = 'reserved'` matched
 * zero rows because something else — a concurrent completer, or the background reconciliation scan
 * of `data-model.md` §4.6.5 — closed this row first.
 */
export interface BillingCompletionResult {
  readonly written: boolean;
}

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
  settle(rowId: string): Promise<BillingCompletionResult>;

  /**
   * Conditional `UPDATE … WHERE state = 'reserved'`, PLUS — under `credits_mode='metered'` — a
   * real implementation credits `priceRaw` back onto the profile's balance, in the same transaction
   * as the state transition.
   *
   * **The credit runs ONLY when this call's own conditional `UPDATE` actually returned a row**
   * (MAJOR-C, architecture review round 2) — the same "only when" `reserve()`'s own debit uses for
   * its step 2 ("Only when step 1 inserted a NEW row", `system-architecture.md` §3.5.1). A no-op,
   * not an error, on an already-terminal row — same rule as {@link BillingStore.settle} — and the
   * balance is untouched right along with the state: crediting on a zero-row `UPDATE` would return
   * `priceRaw` a second time for a row a prior completer already refunded once.
   */
  refund(rowId: string, reason: string): Promise<BillingCompletionResult>;

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

    async settle(rowId: string): Promise<BillingCompletionResult> {
      const index = rows.findIndex((row) => row.id === rowId);
      if (index === -1) return { written: false }; // unknown row — same as an UPDATE matching zero rows
      const current = rows[index];
      if (current === undefined || current.state !== 'reserved') return { written: false }; // conditional: first completer wins
      const ts = now();
      rows[index] = { ...current, state: 'settled', terminalAt: ts, updatedAt: ts };
      return { written: true };
    },

    async refund(rowId: string, reason: string): Promise<BillingCompletionResult> {
      const index = rows.findIndex((row) => row.id === rowId);
      if (index === -1) return { written: false };
      const current = rows[index];
      if (current === undefined || current.state !== 'reserved') return { written: false };
      const ts = now();
      rows[index] = {
        ...current,
        state: 'refunded',
        refundReason: reason,
        terminalAt: ts,
        updatedAt: ts,
      };
      return { written: true };
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

/* --------------------------------------------------------------------------------------------- *
 * Task 015-06 — the SQLite axis: `reserve`/`settle`/`refund` as real operators over
 * `onchain.client_usage`, `sumSettled` as a throw. `createBillingStoreStub` above is untouched —
 * task 015-07 replaces it with a factory of its own, on the Postgres axis, in this same file.
 * --------------------------------------------------------------------------------------------- */

/**
 * The idempotent insert (`data-model.md` §4.6.1, the task's own literal template). Exported so a
 * test can exercise the SAME text the store sends through the schema-qualification gate directly
 * (TC-UNIT-10) — a second, hand-typed copy in a test would drift from this one on the first edit.
 *
 * `$8` names ONE bound value three times (`reserved_at`/`created_at`/`updated_at` are pinned to the
 * SAME instant) — valid in the Postgres dialect this text is written in, and `toSqliteDialect`
 * (`@onchain-intel/core`) renames it to `@p8` in both places, which `better-sqlite3` accepts as a
 * named parameter used twice (`packages/core/test/sqlite-state-client.test.ts`, "renames a
 * parameter named twice to the SAME name, which `?` could not do").
 */
export const RESERVE_INSERT_SQL = `
INSERT INTO onchain.client_usage
  (id, principal_id, access_profile_id, client_request_id, tool, capability,
   price_raw, state, reserved_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $8, $8)
ON CONFLICT (principal_id, client_request_id) DO NOTHING
RETURNING id, state`;

/** Reads the row an `ON CONFLICT DO NOTHING` swallowed — the dedup key alone, on ANY state
 * (R-5.5, AC-10/AC-11). Carries `tool`/`capability`/`reserved_at` beyond the bare id/state (task
 * 015-08): the conflict branch needs them to compute `replayWindowMs()` and compare it against how
 * long ago the row was reserved, the SAME row `existing: true` already reads, one extra read no
 * further than the columns it already has. */
const SELECT_BY_DEDUP_KEY_SQL = `
SELECT id, state, tool, capability, reserved_at FROM onchain.client_usage
 WHERE principal_id = $1 AND client_request_id = $2`;

/**
 * The conditional completion `data-model.md` §4.6.1 declares — shared by `settle` (`$2='settled'`,
 * `$4=NULL`) and `refund` (`$2='refunded'`, `$4=`the refusal class name). `WHERE state = 'reserved'`
 * is the "first completer wins" guard (`system-architecture.md` §3.5.3): a row already in a terminal
 * state matches zero rows, which is a no-op here, never a thrown error.
 */
const COMPLETE_UPDATE_SQL = `
UPDATE onchain.client_usage
   SET state = $2, terminal_at = $3, updated_at = $3, refund_reason = $4
 WHERE id = $1 AND state = 'reserved'
RETURNING id`;

/**
 * MINOR-9 — the SQLite axis's own closer for a stuck `'reserved'` row (`data-model.md` §4.6.5's
 * Postgres-axis scan has no counterpart here). Run once per store open (below, in
 * {@link createSqliteBillingStore}), on the SAME dedicated connection every other statement in this
 * factory uses, queued through the SAME serialization queue.
 *
 * **Why this axis needs its own closer and Postgres does not.** `data-model.md` §4.6.5's scan runs
 * OUTSIDE this process (task 015-18's n8n workflow), reaching Postgres over its own network path.
 * The SQLite file is reachable only from THIS process's own connections — nothing else can ever run
 * that scan here — so without this sweep a row past R-14's own threshold would sit in `'reserved'`
 * forever on this axis, and R-3's completion guarantee would hold on Postgres and silently not hold
 * here (`CLAUDE.md` "nothing silently").
 *
 * **The threshold is `REPLAY_AND_RECONCILE_CEILING_MS`, read, never re-typed as a hand-written
 * millisecond literal** — the SAME constant `data-model.md` §4.6.5 names as shared by the
 * reconciliation scan and the replay window (TC-UNIT-10, "one constant, two consumers, not two
 * literals").
 *
 * **No balance effect.** Unlike Postgres's `refund()` (below), this axis debits no balance at
 * `reserve()` either (task 015-06 never implemented the metered branch here — `credits_mode
 * ='metered'` is not exercised on this axis in phase 0, `data-model.md` §4.6.1's own "Storage axis"
 * note), so there is nothing for this closer to credit back.
 */
const CLOSE_EXPIRED_SQL = `
UPDATE onchain.client_usage
   SET state = 'refunded', refund_reason = 'expired', terminal_at = $1, updated_at = $1
 WHERE state = 'reserved' AND reserved_at < $2`;

/** A stderr writer local to this module — the SAME EPIPE-safe shape `tools/registry.ts`'s own
 * `writeStderrLine` uses (duplicated, not imported: this is the engine layer and does not reach into
 * `src/tools/`). Used only by the closer above, whose failure has no caller to return a value to. */
function writeBillingStderrLine(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Best-effort; the fact being reported is not in question either way.
  }
}

interface ClientUsageIdState {
  readonly id: string;
  readonly state: BillingLedgerRow['state'];
}

/** `SELECT_BY_DEDUP_KEY_SQL`/`pgSelectByDedupKeySql`'s own row shape — snake_case, as returned by
 * both drivers (no camelCasing layer sits between the query and this file, same convention
 * `pgDebitUpdateSql`'s `credits_balance_raw` already follows). */
interface ClientUsageConflictRow {
  readonly id: string;
  readonly state: BillingLedgerRow['state'];
  readonly tool: string;
  readonly capability: string | null;
  readonly reserved_at: number;
}

/**
 * `reserve()`'s conflict branch, task 015-08 (`system-architecture.md` §3.5.2a) — reads the SAME row
 * `existing: true` already reads and compares ONE value against `replayWindowMs()`. The inclusive
 * boundary (`<=`, not `<`) lives HERE, once, shared by all three call sites (the SQLite axis's
 * `reserve()`, and the Postgres axis's `reserveUnlimited`/`reserveMetered`) — writing the comparison
 * separately in each would let the boundary itself drift between the two axes on the first edit to
 * either copy (this file's own "Why правило живёт одной функцией на две оси", `data-model.md` §4.6.1).
 *
 * **Why this touches no row.** The conflict branch's own caller already stopped at a SELECT — this
 * function only classifies what was read. `client_usage` gains no write on either arm: `ok: true`
 * returns the untouched row as `existing: true` (§3.5.1's ORIGINAL contract); `ok: false` reports
 * `ReplayWindowExpiredError` and leaves the row exactly as it was (R-3.5 — the reservation for an
 * expired key does not exist, so there is nothing to reverse).
 */
function replayConflictOutcome(
  existingRow: ClientUsageConflictRow,
  nowMs: number,
): BillingReserveResult {
  const windowMs = replayWindowMs({ capability: existingRow.capability, tool: existingRow.tool });
  if (nowMs - existingRow.reserved_at <= windowMs) {
    return {
      ok: true,
      reservation: { rowId: existingRow.id, state: existingRow.state, existing: true },
    };
  }
  return { ok: false, reason: 'replay window expired', refusalClass: 'ReplayWindowExpiredError' };
}

/**
 * Construction dependencies for {@link createSqliteBillingStore}, forwarded almost verbatim to
 * `createSqliteStateClient` (`@onchain-intel/core`, task 014-36/014-12).
 *
 * **Why `DatabaseCtor` is typed `unknown`, rather than imported from the driver package.** This
 * module never imports that package at all — `packages/mcp-server/test/tool-spec.test.ts`'s own
 * gate refuses ANY import statement naming it, type-only or not, from every file under `src/`
 * except `runtime.ts`. The real constructor already lives inside `@onchain-intel/core`
 * (`createSqliteStateClient`'s own default), so this field only needs to be forwarded, never named:
 * production supplies nothing and gets that default; a test supplies a capturing constructor (the
 * same seam `packages/core/test/sqlite-state-client.test.ts` and
 * `packages/mcp-server/test/helpers/sqlite-engine.ts` already use) to observe the executed
 * statement text, cast at the boundary below exactly as `pg/state-client.ts` casts its own
 * `PoolCtor`.
 */
export interface SqliteBillingStoreDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the file — `':memory:'` in a test, the real `DATA_DIR/cache.sqlite3` in production
   * (`packages/core/src/sqlite/state-client.ts:69`, forwarded verbatim, unchanged by this task). */
  readonly path?: string;
  readonly now?: () => number;
  readonly DatabaseCtor?: unknown;
}

/**
 * `BillingStore` on the SQLite axis (task 015-06, R-1.2/R-1.4/R-5.2/R-5.3/R-5.4/R-5.5/R-7.2).
 *
 * **A DEDICATED connection, not the caller's shared `EngineStore`.** `reserve()` must run inside
 * `BEGIN IMMEDIATE … COMMIT`, not the driver's default `DEFERRED`
 * (`docs/architectures/system-architecture.md`'s own `db.transaction(fn).immediate()` note; the
 * precedent is `packages/core/src/cache/budget-store.ts:420`, `return attempt.immediate();`, with
 * the WAL-specific reason at `:289`). `createSqliteStateClient`'s OWN `.transaction()` always issues
 * plain `BEGIN` for every caller of the client it returns
 * (`packages/core/src/sqlite/state-client.ts:158`), and that cannot change here —
 * `packages/core` is out of this task's scope. This store therefore takes the task's own SECOND
 * named carrier ("писатель леджера открывает свою транзакцию — второй путь к тому же файлу базы"):
 * its own `createSqliteStateClient` instance, addressing the SAME `DATA_DIR/cache.sqlite3` file
 * through a connection this store alone writes through.
 *
 * **Why `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` are sent as plain statements via `.query()`, not via
 * `.transaction()`.** The client's `.transaction()` has no parameter for the lock mode — getting
 * `BEGIN IMMEDIATE` onto the wire at all means sending it as its own autocommit statement, through
 * the SAME `assertSendable` guard (`NO_DDL_RE`/`UNQUALIFIED_TABLE_RE`) every other statement this
 * store sends passes through — none of the three transaction-control statements trip either check.
 *
 * **Why one queue serializes `reserve`/`settle`/`refund` together, not just `reserve` against
 * itself.** All three write the SAME dedicated connection. A `settle()`/`refund()` issued while a
 * `reserve()`'s manual `BEGIN IMMEDIATE` is still open would silently become part of THAT
 * transaction (same connection — no second `BEGIN` is needed to "join" one already open), and a
 * future rollback inside `reserve()` (task 015-07's balance-debit branch) would then undo an
 * unrelated `settle`/`refund`. The queue below is the same one-transaction-at-a-time discipline
 * `packages/core/src/sqlite/state-client.ts`'s own `transaction()` applies internally, reimplemented
 * here because this module cannot reach that private queue.
 */
export function createSqliteBillingStore(deps: SqliteBillingStoreDeps = {}): BillingStore {
  const now = deps.now ?? ((): number => Date.now());
  const client = createSqliteStateClient({
    env: deps.env,
    path: deps.path,
    // Cast at the DI boundary only (same convention `pg/state-client.ts` casts its own `PoolCtor`)
    // — `SqliteBillingStoreDeps.DatabaseCtor` is `unknown` on purpose (see this file's own note on
    // the interface above); `createSqliteStateClient` accepts `undefined` or its own real
    // constructor type, and `never` is assignable to either.
    DatabaseCtor: deps.DatabaseCtor as never,
  });

  // One transaction (or one autocommit statement) at a time on this dedicated connection — see the
  // factory's own docstring, "Why one queue serializes reserve/settle/refund together".
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** `BEGIN IMMEDIATE` … `fn()` … `COMMIT`, `ROLLBACK` on a throw — the manual carrier this
   * factory's own docstring names. A rollback failure is swallowed (same reasoning
   * `pg/state-client.ts` states for its own rollback catch): it must never mask the ORIGINAL error
   * rethrown below, and the connection stays open for the next queued caller either way. */
  async function withImmediateTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Swallowed on purpose — see this function's own docstring.
      }
      throw error;
    }
  }

  // MINOR-9 — queued FIRST, through the SAME `enqueue` every reserve/settle/refund call below uses:
  // this line runs synchronously, before this factory returns, so the FIRST call any caller makes on
  // the returned store already waits behind the sweep (`enqueue`'s own queue is a promise CHAIN, not
  // a background timer — nothing here needs a scheduler). A failure is named on stderr rather than
  // thrown: there is no caller of `createSqliteBillingStore` waiting on a promise to reject.
  enqueue(() => {
    const ts = now();
    return client.query(CLOSE_EXPIRED_SQL, [ts, ts - REPLAY_AND_RECONCILE_CEILING_MS]);
  }).catch((error: unknown) => {
    writeBillingStderrLine(
      `billing-store(sqlite): the stuck-reservation closer failed on open — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return {
    async reserve(input): Promise<BillingReserveResult> {
      try {
        return await enqueue(() =>
          withImmediateTransaction(async () => {
            const ts = now();
            const id = ulid(ts);
            const inserted = await client.query<ClientUsageIdState>(RESERVE_INSERT_SQL, [
              id,
              input.principalId,
              input.accessProfileId,
              // `client_request_id` is the CALLER's value, never minted here (task doc, "store не
              // минтует client_request_id"; TC-UNIT-11) — the same value `request_trace` charges
              // the same server-side request under, so the two ledgers join on it (MINOR-3 round 1).
              input.clientRequestId,
              input.tool,
              input.capability,
              input.priceRaw,
              ts,
            ]);
            const insertedRow = inserted[0];
            if (insertedRow !== undefined) {
              const reservation: BillingReservation = {
                rowId: insertedRow.id,
                state: insertedRow.state,
                existing: false,
              };
              return { ok: true, reservation };
            }

            // Empty `RETURNING`: `ON CONFLICT DO NOTHING` swallowed the insert — a row for this
            // `(principalId, clientRequestId)` pair already exists, in ANY state (R-5.5,
            // AC-10/AC-11). Read it back rather than fabricate a second answer.
            const existing = await client.query<ClientUsageConflictRow>(SELECT_BY_DEDUP_KEY_SQL, [
              input.principalId,
              input.clientRequestId,
            ]);
            const existingRow = existing[0];
            if (existingRow === undefined) {
              // The unique index reports a conflict and this SAME transaction cannot read the row
              // back — a state the storage guarantee, not this code, is supposed to make
              // unreachable. Fail closed rather than invent a reservation.
              throw new Error(
                'billing-store(sqlite): reserve() conflicted but the dedup key read back no row',
              );
            }
            // Task 015-08 — the replay window (`system-architecture.md` §3.5.2a): `ok: true` with
            // the SAME `existing: true` shape above when the row is still inside its window, `ok:
            // false`/`ReplayWindowExpiredError` past it. Neither arm writes to `client_usage`.
            return replayConflictOutcome(existingRow, now());
          }),
        );
      } catch (error) {
        // `BillingStoreUnavailableError` is returned as a VALUE, never thrown (this file's own
        // `BillingStore.reserve` docstring above; `system-architecture.md` §3.5.2 step 4) — the
        // ledger could not be reached, or the write failed for any other reason.
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          refusalClass: 'BillingStoreUnavailableError',
        };
      }
    },

    async settle(rowId: string): Promise<BillingCompletionResult> {
      const rows = await enqueue(() =>
        client.query<{ id: string }>(COMPLETE_UPDATE_SQL, [rowId, 'settled', now(), null]),
      );
      return { written: rows.length > 0 };
    },

    async refund(rowId: string, reason: string): Promise<BillingCompletionResult> {
      const rows = await enqueue(() =>
        client.query<{ id: string }>(COMPLETE_UPDATE_SQL, [rowId, 'refunded', now(), reason]),
      );
      return { written: rows.length > 0 };
    },

    // R-7.3 — authoritative on the Postgres axis only (see this file's own `BillingStore.sumSettled`
    // docstring above). A confident `'0'` here would be the legal-negative shape L-10 already named
    // the cost of: a reader of AC-4's aggregate could not tell "nothing to sum this period" from
    // "this storage axis cannot answer at all".
    async sumSettled(): Promise<string> {
      throw new LedgerReadNotAuthoritativeError();
    },
  };
}

/* --------------------------------------------------------------------------------------------- *
 * Task 015-07 — the Postgres axis: `reserve`/`settle`/`refund`/`sumSettled` as real operators over
 * `onchain.client_usage` and `onchain.access_profiles`, over the shared `EngineStore` mechanism
 * `createRequestTraceStore` already uses (`request-trace-store.ts`). `createBillingStoreStub` and
 * `createSqliteBillingStore` above are UNTOUCHED — the same coexistence `createRequestTraceStore`
 * already establishes beside `createRequestTraceStoreStub`: a real repository is ADDED under a new
 * name, never grafted onto the stub's own identifier, so every existing consumer of the stub
 * (`billing-store-contract.test.ts`) keeps passing unedited.
 * --------------------------------------------------------------------------------------------- */

/** `price_raw`'s own shape: an unsigned integer in decimal notation, no sign, no fraction, no
 * exponent — never `-1`, never `1.5`, never `'1e2'`. */
const UNSIGNED_INTEGER_RE = /^[0-9]+$/;

/** `access_profiles.credits_balance_raw`'s own shape (migration 004's `client_usage_balance_is_integer`
 * CHECK, Postgres axis only) — a signed integer in decimal notation. Signed, unlike price: a balance
 * can legitimately go negative in the ledger's own bookkeeping sense, and the SQL comparison below is
 * what turns "negative" into a refusal, not this parse. */
const SIGNED_INTEGER_RE = /^-?[0-9]+$/;

/**
 * Parses a `TEXT` credit column into an exact `BigInt`, or `undefined` when the string is not that
 * column's own declared shape — MINOR-7 (architecture review round 2), the fail-closed half of the
 * MINOR-7 pair whose other half is migration 004's own CHECK constraint.
 *
 * **`BigInt`, never `Number` — where it actually matters.** `Number('9007199254740993')` rounds to
 * `9007199254740992` before this function even sees it return a value: past 2^53 a JS number cannot
 * represent the string it was given, so a `Number`-based version of this parser would silently accept
 * an out-of-range value AS IF it were the value asked for. `BigInt('9007199254740993')` stays exact —
 * this function's whole reason to exist is that the caller (the pre-transaction format check below)
 * must be able to trust what it parsed, not merely that parsing "succeeded". The actual debit
 * arithmetic runs in Postgres via `CAST(x AS NUMERIC)` (arbitrary precision, TC-UNIT-08), never
 * recomputed from this value in JS — this function proves the STRING is well-formed before that
 * statement is even built, it does not repeat the statement's own subtraction.
 */
function parseCreditColumn(raw: string, shape: RegExp): bigint | undefined {
  if (!shape.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    // Unreachable once `shape` has matched, kept because a parse that can throw must never be
    // trusted to only throw where a human expects it to.
    return undefined;
  }
}

/** Shared by the unlimited write and the metered transaction's own first statement — the ORIGINAL
 * single operator of `system-architecture.md` §3.5.1, qualified through `engine.qualify(...)`, never
 * a literal `onchain.client_usage`. */
function pgReserveInsertSql(engine: EngineStore): string {
  return `INSERT INTO ${engine.qualify('client_usage')}
  (id, principal_id, access_profile_id, client_request_id, tool, capability,
   price_raw, state, reserved_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $8, $8)
ON CONFLICT (principal_id, client_request_id) DO NOTHING
RETURNING id, state`;
}

/** Reads the row an `ON CONFLICT DO NOTHING` swallowed — the dedup key alone, on ANY state (R-5.5,
 * AC-10/AC-11), the SAME read-back rule the SQLite axis already applies. */
function pgSelectByDedupKeySql(engine: EngineStore): string {
  return `SELECT id, state, tool, capability, reserved_at FROM ${engine.qualify('client_usage')}
 WHERE principal_id = $1 AND client_request_id = $2`;
}

/**
 * The metered branch's second statement (`data-model.md` §4.6.1's "Balance arithmetic", literal
 * text) — `CAST(x AS NUMERIC)` throughout, the ANSI form `pg/limiter-store.ts` already established
 * for this exact reason ("`::` is Postgres-only syntax, while `CAST(x AS t)` is standard and SQLite
 * parses it"), never Postgres's own `x::numeric` shorthand. Zero rows back means the balance could
 * not cover `$2` — the caller reads that as `ClientCreditsExhaustedError`, never re-derives it from a
 * separate read.
 */
function pgDebitUpdateSql(engine: EngineStore): string {
  return `UPDATE ${engine.qualify('access_profiles')}
   SET credits_balance_raw = CAST(CAST(credits_balance_raw AS NUMERIC) - CAST($2 AS NUMERIC) AS TEXT)
 WHERE id = $1 AND CAST(credits_balance_raw AS NUMERIC) >= CAST($2 AS NUMERIC)
RETURNING credits_balance_raw`;
}

/**
 * Shared by `settle`/`refund` — the SAME conditional transition the SQLite axis's own
 * `COMPLETE_UPDATE_SQL` declares, qualified here through `engine.qualify(...)` instead of a literal.
 *
 * **`RETURNING` carries `access_profile_id, price_raw` beyond the bare `id`** (task 015-10,
 * MAJOR-A/MAJOR-C) — `refund()` below needs both to decide whether, and how much, to credit back,
 * and reads them from THIS row rather than a second, independent lookup: the row this UPDATE just
 * transitioned is the ONLY authority on what it was reserved for. `settle()` uses the same text and
 * ignores the extra columns — no balance effect there (`priceRaw` was already spent at `reserve()`).
 */
function pgCompleteUpdateSql(engine: EngineStore): string {
  return `UPDATE ${engine.qualify('client_usage')}
   SET state = $2, terminal_at = $3, updated_at = $3, refund_reason = $4
 WHERE id = $1 AND state = 'reserved'
RETURNING id, access_profile_id, price_raw`;
}

/**
 * `refund()`'s own credit statement (task 015-10, MAJOR-A/MAJOR-C) — the mirror of
 * {@link pgDebitUpdateSql}, addition instead of subtraction, same `CAST(x AS NUMERIC)` ANSI form for
 * the same cross-dialect reason. No floor check: crediting `priceRaw` back can never push a balance
 * below where it stood before the debit that is being reversed, so there is no analogue of the
 * debit's own `>= CAST($2 AS NUMERIC)` guard.
 */
function pgCreditUpdateSql(engine: EngineStore): string {
  return `UPDATE ${engine.qualify('access_profiles')}
   SET credits_balance_raw = CAST(CAST(credits_balance_raw AS NUMERIC) + CAST($2 AS NUMERIC) AS TEXT)
 WHERE id = $1
RETURNING credits_balance_raw`;
}

/** AC-4's aggregate (`data-model.md` §4.6.1, literal text) — `CAST(... AS NUMERIC)`/`CAST(... AS
 * TEXT)` for the same reason the debit statement uses that form rather than `::`. */
function pgSumSettledSql(engine: EngineStore): string {
  return `SELECT CAST(COALESCE(SUM(CAST(price_raw AS NUMERIC)), 0) AS TEXT) AS total
  FROM ${engine.qualify('client_usage')}
 WHERE state = 'settled' AND terminal_at >= $1 AND terminal_at < $2`;
}

/**
 * `BillingStore` on the Postgres axis (task 015-07, R-1/R-2/R-5/R-7).
 *
 * **Order inside `reserve()`, matching `system-architecture.md` §3.5.1's own numbered list.**
 * 1. `priceRaw` is validated BEFORE anything else — TC-UNIT-07, "ни одного оператора не отправлено".
 * 2. `accessProfileId === null` skips `AccessProfileReader` entirely and proceeds as `unlimited`
 *    (R-6.2, `system-architecture.md:4098-4100`: "the stdio principal's `accessProfileId` is `null`,
 *    so this step is skipped for it").
 * 3. Otherwise `profiles.read(accessProfileId)` decides the mode. `metered` additionally validates
 *    `creditsBalanceRaw`'s shape before the transaction opens (MINOR-7) — a value that does not parse
 *    refuses BY NAME (`accessProfileId` in the reason) and touches neither table.
 * 4. `unlimited` runs the single `INSERT … ON CONFLICT DO NOTHING` — no `engine.transaction(...)`
 *    wrapper, matching the task's own "Ветвь `unlimited` — один оператор" heading literally: the
 *    WRITE is one round trip, and the conflict branch's read-back is a second, independent one, never
 *    a shared transaction with the write.
 * 5. `metered` runs `engine.transaction(...)`: the SAME conditional INSERT first (idempotency-first,
 *    §3.5.1's own "Why идемпотентность стоит первой" — a retry must never re-reach the debit), and
 *    only a NEWLY inserted row reaches the debit `UPDATE`. Zero rows back from the debit throws
 *    {@link ClientCreditsExhaustedError} — private to this transaction body, unwrapped at the
 *    `reserve()` boundary below, the same pattern `PgBudgetStore`'s own `ReservationRefused` already
 *    applies (`packages/core/src/pg/budget-store.ts`) — so the ROLLBACK it triggers undoes the
 *    INSERT too, leaving both tables byte-for-byte as they were (TC-UNIT-03).
 * 6. Any OTHER throw — `AccessProfileReader` unreachable, the engine's connection lost, the internal
 *    "conflicted but read back no row" invariant — is caught at the SAME boundary and returned as
 *    `BillingStoreUnavailableError`, never re-thrown (R-3.7, fail-closed; `system-architecture.md`
 *    §3.5.2 step 4: both money classes are a VALUE, never a throw, to the caller of `reserve()`).
 *
 * **`settle`/`refund` — task 015-07 deferred their wiring to this task's own owner (015-10): "Их
 * размещение относительно `withTrace` и условие кредитования баланса принадлежат задаче 015-10".**
 * Both are the conditional `UPDATE … WHERE state = 'reserved'` `data-model.md` §4.6.1 declares —
 * first completer wins, a no-op rather than an error on an already-terminal row. `settle` carries no
 * balance effect (the amount was already debited at `reserve()`); `refund` credits `priceRaw` back,
 * in the SAME `engine.transaction(...)` as the state transition, ONLY when this call's own
 * conditional `UPDATE` actually returned a row (see `refund`'s own docstring below).
 */
export interface PgBillingStoreDeps {
  /** Overrides the clock `reserve()` stamps `reserved_at`/`created_at`/`updated_at` with AND compares
   * against in the replay-window conflict branch (task 015-08). Defaults to `Date.now` — the same
   * "production supplies nothing, a test supplies a fake" convention {@link SqliteBillingStoreDeps.now}
   * already uses on the other axis. */
  readonly now?: () => number;
}

export function createBillingStore(
  engine: EngineStore,
  profiles: AccessProfileReader,
  deps: PgBillingStoreDeps = {},
): BillingStore {
  const now = deps.now ?? ((): number => Date.now());

  /** The unlimited write — ONE operator on the common path, a second read-back only on conflict.
   * Shared by `accessProfileId === null` and by an actual `credits_mode = 'unlimited'` profile. */
  async function reserveUnlimited(input: {
    principalId: string;
    accessProfileId: string | null;
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }): Promise<BillingReserveResult> {
    const ts = now();
    const id = ulid(ts);
    const inserted = await engine.query<ClientUsageIdState>(pgReserveInsertSql(engine), [
      id,
      input.principalId,
      input.accessProfileId,
      input.clientRequestId,
      input.tool,
      input.capability,
      input.priceRaw,
      ts,
    ]);
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return {
        ok: true,
        reservation: { rowId: insertedRow.id, state: insertedRow.state, existing: false },
      };
    }
    const existing = await engine.query<ClientUsageConflictRow>(pgSelectByDedupKeySql(engine), [
      input.principalId,
      input.clientRequestId,
    ]);
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw new Error(
        'billing-store(postgres): reserve() conflicted but the dedup key read back no row',
      );
    }
    // Task 015-08 — the replay window (`system-architecture.md` §3.5.2a); see this file's own
    // `replayConflictOutcome` docstring for why the comparison lives in ONE function shared by both
    // storage axes rather than written out here a second time.
    return replayConflictOutcome(existingRow, now());
  }

  /** The metered transaction — idempotency-first: insert, THEN (only for a NEW row) debit. */
  async function reserveMetered(
    accessProfileId: string,
    input: {
      principalId: string;
      accessProfileId: string | null;
      clientRequestId: string;
      tool: string;
      capability: string | null;
      priceRaw: string;
    },
  ): Promise<BillingReserveResult> {
    return engine.transaction(async (tx) => {
      const ts = now();
      const id = ulid(ts);
      const inserted = await tx.query<ClientUsageIdState>(pgReserveInsertSql(engine), [
        id,
        input.principalId,
        input.accessProfileId,
        input.clientRequestId,
        input.tool,
        input.capability,
        input.priceRaw,
        ts,
      ]);
      const insertedRow = inserted[0];
      if (insertedRow === undefined) {
        // Existing row answers this client_request_id — the balance is NOT touched, and the
        // transaction completes as a read (§3.5.1's own "транзакция завершается чтением").
        const existing = await tx.query<ClientUsageConflictRow>(pgSelectByDedupKeySql(engine), [
          input.principalId,
          input.clientRequestId,
        ]);
        const existingRow = existing[0];
        if (existingRow === undefined) {
          throw new Error(
            'billing-store(postgres): reserve() conflicted but the dedup key read back no row',
          );
        }
        // Task 015-08 — the replay window. Inside it: `ok: true`/`existing: true`, the balance
        // untouched (this branch never reaches the debit below). Past it: `ok: false` with
        // `ReplayWindowExpiredError`, still without touching the balance — the transaction commits
        // as a pure read either way (`replayConflictOutcome`'s own docstring, "Why this touches no
        // row").
        return replayConflictOutcome(existingRow, now());
      }

      const debited = await tx.query<{ credits_balance_raw: string }>(pgDebitUpdateSql(engine), [
        accessProfileId,
        input.priceRaw,
      ]);
      if (debited.length === 0) {
        // Thrown so `engine.transaction(...)` rolls back the INSERT above too (TC-UNIT-03), and
        // caught at `reserve()`'s own boundary below — never seen as a throw by a caller of
        // `BillingStore.reserve()` (system-architecture.md §3.5.2 step 4).
        throw new ClientCreditsExhaustedError(
          `client credits exhausted for access profile ${accessProfileId}`,
        );
      }
      return {
        ok: true,
        reservation: { rowId: insertedRow.id, state: insertedRow.state, existing: false },
      };
    });
  }

  return {
    async reserve(input): Promise<BillingReserveResult> {
      const price = parseCreditColumn(input.priceRaw, UNSIGNED_INTEGER_RE);
      if (price === undefined) {
        // TC-UNIT-07 — "перед транзакцией", literally: nothing below this line has run yet.
        return {
          ok: false,
          reason: `billing store cannot decide: priceRaw ${JSON.stringify(input.priceRaw)} is not an unsigned decimal integer`,
          refusalClass: 'BillingStoreUnavailableError',
        };
      }

      try {
        if (input.accessProfileId === null) {
          return await reserveUnlimited(input);
        }
        const profile = await profiles.read(input.accessProfileId);
        if (profile.creditsMode === 'unlimited') {
          return await reserveUnlimited(input);
        }
        // credits_mode === 'metered' — MINOR-7: the balance's own shape is checked BEFORE the
        // transaction opens, by name, without spending a round trip on a comparison Postgres's own
        // `numeric` cannot decide either (a `'NaN'` balance sorts above every price).
        const balance =
          profile.creditsBalanceRaw === null
            ? undefined
            : parseCreditColumn(profile.creditsBalanceRaw, SIGNED_INTEGER_RE);
        if (balance === undefined) {
          return {
            ok: false,
            reason: `billing store cannot decide: access profile ${input.accessProfileId} credits_balance_raw is not a valid integer`,
            refusalClass: 'BillingStoreUnavailableError',
          };
        }
        return await reserveMetered(input.accessProfileId, input);
      } catch (error) {
        if (error instanceof ClientCreditsExhaustedError) {
          return { ok: false, reason: error.message, refusalClass: 'ClientCreditsExhaustedError' };
        }
        // Every other failure — `AccessProfileReader` unreachable, the engine's connection lost, the
        // internal read-back invariant — refuses fail-closed as a VALUE (R-3.7), never a throw.
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          refusalClass: 'BillingStoreUnavailableError',
        };
      }
    },

    // No balance effect (`priceRaw` was already debited at `reserve()`) — ONE statement, no
    // `engine.transaction(...)` wrapper, matching `settle()`'s own declared "баланса не трогает".
    async settle(rowId: string): Promise<BillingCompletionResult> {
      const rows = await engine.query<{ id: string }>(pgCompleteUpdateSql(engine), [
        rowId,
        'settled',
        Date.now(),
        null,
      ]);
      return { written: rows.length > 0 };
    },

    /**
     * Task 015-10 — MAJOR-A (`pg-engine-store.ts`'s own `transaction()`/`qualify()`, cited by the
     * task doc) + MAJOR-C (the conditional). The state transition and the balance credit run in ONE
     * `engine.transaction(...)`, matching `data-model.md` §4.6.1's own "in the same transaction as
     * the row's transition to 'refunded'" and `reserve()`'s own metered branch just above (insert,
     * THEN — only for a row THIS call actually transitioned — the money movement).
     */
    async refund(rowId: string, reason: string): Promise<BillingCompletionResult> {
      return engine.transaction(async (tx) => {
        const rows = await tx.query<{
          id: string;
          access_profile_id: string | null;
          price_raw: string;
        }>(pgCompleteUpdateSql(engine), [rowId, 'refunded', Date.now(), reason]);
        const row = rows[0];
        if (row === undefined) {
          // MAJOR-9 — zero rows: the conditional `WHERE state = 'reserved'` matched nothing, because
          // this row already left `'reserved'` (a concurrent completer, or `data-model.md` §4.6.5's
          // own background reconciliation scan). First completer wins — a late outcome credits
          // nothing and does not reopen what that first completer already closed.
          return { written: false };
        }
        if (row.access_profile_id !== null) {
          // MAJOR-A/MAJOR-C — credited ONLY because THIS call's own conditional `UPDATE` actually
          // transitioned the row (the mirror of `reserve()`'s "Only when step 1 inserted a NEW
          // row"), and only for a principal that reaches a profile at all (R-7.5 — the local
          // principal's `access_profile_id` is `NULL`, and there is nothing to credit).
          await tx.query(pgCreditUpdateSql(engine), [row.access_profile_id, row.price_raw]);
        }
        return { written: true };
      });
    },

    // R-7.3, AC-15 — the Postgres axis IS the authoritative one; unlike the SQLite axis above, this
    // never throws `LedgerReadNotAuthoritativeError`.
    async sumSettled(periodFromMs: number, periodToMs: number): Promise<string> {
      const rows = await engine.query<{ total: string }>(pgSumSettledSql(engine), [
        periodFromMs,
        periodToMs,
      ]);
      return rows[0]?.total ?? '0';
    },
  };
}
