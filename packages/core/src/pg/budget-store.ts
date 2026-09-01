import type { AdapterRegistration } from '../adapters/types.js';
import {
  DAILY_CALL_EXHAUSTED_DETAIL,
  type BudgetStore,
  type VelocityLimit,
} from '../cache/budget-store.js';
import { adapterRegistrations } from '../providers.config.js';
import type { StateClient, StateTransaction } from './state-client.js';

/** Constructor options for `PgBudgetStore`. */
export interface PgBudgetStoreOptions {
  /** The write-capable client (`createStateClient`). Required, never defaulted — the DSN is the
   * profile's decision, not this store's. */
  client: StateClient;
  /** Registrations to upsert into `onchain.providers` BEFORE any `usage` write can reference one as
   * a foreign key. Defaults to the real `adapterRegistrations` (all twelve). */
  providers?: AdapterRegistration[];
}

/**
 * How far back `onchain.usage_window` rows are kept — the SAME hour `SqliteBudgetStore` keeps
 * (`cache/budget-store.ts`, `WINDOW_RETENTION_MS`). Only the CURRENT window is ever read, so this is
 * retention for after-the-fact inspection, not for the guard.
 *
 * **Why the number is restated rather than imported.** Importing it would couple this axis to the
 * SQLite module's internals for one integer; the value is part of the counter contract of §4.2.4,
 * which both axes implement independently. The parity test asserts the two agree, so a change to
 * one that is not made to the other fails a test rather than drifting quietly.
 */
const WINDOW_RETENTION_MS = 3_600_000;

/**
 * A refusal, thrown so that the transaction rolls back, and converted straight back into a value at
 * this class's own boundary.
 *
 * **Why a throw for something that is not a failure.** `checkAndReserve` may have to abandon what
 * its first statement wrote (`system-architecture.md` §3.4.8 item 3: "A zero-row result from either
 * rolls back"), and a throw is the only exit from a transaction body that rolls back. The class is
 * private to this module and is unwrapped in the same function that throws it, so no caller of
 * `BudgetStore` ever sees a throw where the interface promises `{ok:false}`.
 */
class ReservationRefused extends Error {
  constructor(readonly refusal: { ok: false; reason: string }) {
    super(refusal.reason);
    this.name = 'ReservationRefused';
  }
}

/** One `onchain.usage` row as `pg` returns it — `BIGINT` arrives as a STRING (see `toCounter`). */
interface UsageRow {
  credits_used: unknown;
  calls_made: unknown;
}

interface WindowRow {
  credits_used: unknown;
  calls_made: unknown;
}

/**
 * Coerces one `BIGINT` counter column into a JS number.
 *
 * **Why a coercion is unavoidable.** `pg` returns `int8` as a STRING (an arbitrary `bigint` does not
 * survive a JS number). Uncoerced, `getUsage()` would return `'60'`, and the caller that computes
 * `used + cost > ceiling` would concatenate rather than add — `'60' + 1 = '601'` — which reads as a
 * budget that is 10× spent, or, one comparison later, as headroom that does not exist.
 *
 * **Why a JS number is nevertheless the right target here.** `credits_used` is a small-in-range
 * internal engine counter, not a canonical observation: `cache/ddl.ts` records exactly this
 * exemption from the `value_raw TEXT` rule of DB-SCHEMA-CONCEPT §1.7, and the interface it must
 * satisfy (`BudgetStore.getUsage`) returns `Promise<number>` on both axes.
 *
 * **Why an unparseable value refuses rather than defaults to zero.** Zero here means "nothing
 * spent", i.e. a full day's budget of free headroom — the fail-OPEN direction on a money guard. The
 * SQLite store makes the same call in the same words ("ledger value is not a finite number").
 */
function toCounter(value: unknown, column: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`pg/budget-store: ${column} is neither a number nor a string`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`pg/budget-store: ${column} is empty`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`pg/budget-store: ${column} is not a finite number`);
  }
  return parsed;
}

/**
 * An unbounded ceiling is bound as SQL `NULL`, and every statement tests for it explicitly.
 *
 * `+Infinity` is the declared "no self-imposed ceiling" sentinel (`cache/budget-store.ts:326`,
 * "may legitimately be") and has no Postgres numeric representation. The parameter is bound on
 * EVERY call and never omitted: a parameter that could be omitted would make "no ceiling" the value
 * of a mistake rather than of a decision (L-10) — and a statement missing the `$5 IS NULL` branch
 * compares `… <= NULL`, which yields `NULL`, returns zero rows, and refuses every reservation.
 */
function ceilingParam(ceiling: number | undefined): number | null {
  if (ceiling === undefined) return null;
  return Number.isFinite(ceiling) ? ceiling : null;
}

/**
 * Postgres-backed `BudgetStore` — the SECOND implementation of the interface at
 * `packages/core/src/cache/budget-store.ts:46`, and NOT a change to it. All five methods were
 * already `Promise`-returning, and `cache/budget-store.ts:17` names this case as the reason
 * ("forward-compat with a future Postgres-backed implementation").
 *
 * **Where the atomicity lives, and why it had to move.** The SQLite guarantee rests on a
 * SYNCHRONOUS transaction body: `db.transaction(fn).immediate()` wraps a read, a comparison and a
 * write that never await, and that class's own docstring warns that "a future Postgres
 * `BudgetStore` that does real async I/O between its read and its write, INSIDE what looks like the
 * same transaction, forfeits this guarantee entirely". It is forfeited here — so the comparison
 * moves INTO the writing statement, and a refusal becomes an empty `RETURNING`
 * (`data-model.md` §4.2.4, canonical text in `system-architecture.md` §3.4.8).
 *
 * **Why a `SELECT` followed by an `INSERT` is not permitted in this dialect.** Under `READ
 * COMMITTED` two connections read the same `credits_used` and both pass the test. The conflict
 * action's row lock is the only serialization point on `(provider, day)` — which is also why
 * `SERIALIZABLE` is not required: the conditional upsert takes the lock it needs.
 *
 * **The four dialect obligations of §4.2.4, all four visible in the SQL below:**
 * 1. reconciliation is a SECOND statement carrying no ceiling bound — a refund refused by a `WHERE`
 *    would strand credits nobody spent;
 * 2. `calls_made` is monotonic — reconciliation adjusts credits and never the call count, because
 *    the vendor round trip already happened and refunding it would open a path past the limit via a
 *    run of cheap-then-refunded calls;
 * 3. the opportunistic prune of old `usage_window` rows stays INSIDE the reservation transaction,
 *    so it inherits the same lock instead of racing it;
 * 4. `MAX(x, y)` is `GREATEST(x, y)`, `INTEGER` is `BIGINT`, and every object name is
 *    schema-qualified (R-30.1) — the last one enforced at runtime by `pg/state-client.ts` and
 *    statically by the gate of `deployment.md` §10.2.1.
 *
 * **This class runs no DDL** (`system-architecture.md` §3.4.8 item 4). It upserts the twelve
 * `providers` rows so the foreign-key target exists before the first `usage` write, and creates no
 * object: a shared Postgres server is not this process's to alter.
 *
 * **On a storage failure it throws, and that IS failing closed** (§3.2, "Fail-closed, never
 * fail-open"). The SQLite axis behaves identically — `better-sqlite3` throws — and the paid call
 * does not proceed in either case. What must never happen is the other direction: a swallowed
 * failure returning `{ok:true}`.
 */
export class PgBudgetStore implements BudgetStore {
  private readonly client: StateClient;
  /**
   * The `providers` bootstrap, started at construction and awaited by every method of this class.
   *
   * **Public because it is the axis's barrier, not this class's private business.**
   * `cache_entries.provider` and `provider_buckets.provider` are foreign keys into the same twelve
   * rows, and this store is their only writer on this axis. `pg/stores.ts` hands this promise to
   * `PgCacheStore` so that the axis's first cache write cannot outrun the registry it references —
   * a race that would surface as an FK refusal, which the registry treats as a best-effort cache
   * write and swallows, leaving a process that quietly stops caching. Found by the parity suite,
   * which wrote to the cache before the bootstrap settled.
   */
  readonly ready: Promise<void>;

  /**
   * **Why the bootstrap is a promise and not a constructor body.** A constructor cannot await, and
   * the guarantee that matters is ORDER, not synchrony: the twelve `providers` rows must exist
   * before the first `usage` write, because `usage.provider` is a foreign key and a missing target
   * makes every write a `23503` refusal. Starting it here and awaiting it in every method delivers
   * exactly that order, without a second construction step a caller could forget.
   *
   * **Why the rejection is captured with a no-op `catch` as well.** An unhandled rejection ends the
   * process on Node's default `--unhandled-rejections=throw`. Without this line, a store that is
   * constructed and then never used would kill a long-lived server because its bootstrap failed —
   * while the same failure, awaited by a method, is meant to fail that one call. The rejection is
   * not discarded: `this.ready` is awaited by every method, so it is rethrown at each use.
   */
  constructor(options: PgBudgetStoreOptions) {
    this.client = options.client;
    this.ready = this.bootstrapProviders(options.providers ?? adapterRegistrations);
    this.ready.catch(() => {
      /* see the docstring: awaited (and rethrown) by every method; this only disarms the global. */
    });
  }

  /**
   * Upserts every registration into `onchain.providers`, writing `registration.tier` into `kind` —
   * the same statement shape and the same source field both SQLite writers use, so no two writers
   * of that table can disagree about one installation.
   *
   * `notes` is left alone on conflict. It is operator-facing free text that no writer in this
   * package produces a value for, and a column no writer OWNS must not be overwritten by one of
   * them (adversarial cycle 2, F-3 — the defect where merely constructing a store erased it).
   *
   * All twelve rows go in ONE transaction: a half-applied registry would leave some providers
   * writable and others refusing on a foreign key, which is a harder state to diagnose than either
   *  a complete one or an empty one.
   */
  private async bootstrapProviders(registrations: AdapterRegistration[]): Promise<void> {
    await this.client.transaction(async (tx) => {
      for (const registration of registrations) {
        await tx.query(
          `INSERT INTO onchain.providers (id, kind, notes) VALUES ($1, $2, NULL)
           ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`,
          [registration.id, registration.tier],
        );
      }
    });
  }

  /**
   * The money gate. Reads nothing before deciding: the daily comparison is expressed inside the
   * writing statement, whose text is the canonical one of `system-architecture.md` §3.4.8 and is
   * reproduced here verbatim rather than paraphrased.
   *
   * Order of the two statements is the refusal precedence of the SQLite axis, preserved: the daily
   * bound is tested first, so a call that breaches both reports the daily ceiling, which is the
   * refusal an operator answers by raising a number rather than by waiting a minute.
   */
  async checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
    velocity?: VelocityLimit,
    // Task 015-14 — the SAME third gate the SQLite axis's `checkAndReserve` reads, on THIS axis
    // expressed inside the writing statement's own `WHERE` (see the daily reservation SQL below
    // and `dailyRefusal()`), for the same reason the credit ceiling already is (§4.2.4, "the
    // comparison moves INTO the writing statement").
    dailyCalls?: { ceiling: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // FAIL CLOSED before anything is sent, on the comparisons no statement could decide. This is
    // the rule the SQLite store already applies (`cache/budget-store.ts:334`), moved earlier for
    // one added reason: `NaN` has no `BIGINT` binding, so sending it would produce a server error
    // (`invalid input syntax`) where the contract calls for a refusal.
    //
    // Per operand, deliberately NOT a blanket `Number.isFinite` on all three:
    // - `cost` must be finite. `costOf()` returns `+Infinity` for an unpriced capability
    //   (fail-closed by design), and `Infinity > Infinity` is `false`, i.e. APPROVED.
    // - `ceiling` may legitimately be `+Infinity` — the "no self-imposed ceiling" sentinel — so
    //   only `NaN` is rejected. A finite check here would break that contract.
    //
    // **The one place this axis's refusal TEXT differs from SQLite's, stated rather than hidden.**
    // The SQLite message also names `used`, which it has already read inside its transaction. Here
    // no statement has been issued yet, and TC-UNIT-02 requires that none is: an undecidable
    // comparison must cost zero round trips. A number that would have to be fetched to be printed
    // is not worth a query on a path that has already decided.
    if (!Number.isFinite(cost) || Number.isNaN(ceiling)) {
      return {
        ok: false,
        reason:
          `budget check failed closed for provider=${provider}: undecidable comparison ` +
          `(need ${cost}, ceiling ${ceiling})`,
      };
    }
    if (velocity !== undefined) {
      if (Number.isNaN(velocity.ceiling)) {
        return {
          ok: false,
          reason: `velocity check failed closed for provider=${provider}: undecidable comparison (need ${cost})`,
        };
      }
      if (velocity.maxCalls !== undefined && Number.isNaN(velocity.maxCalls)) {
        return {
          ok: false,
          reason: `call-rate check failed closed for provider=${provider}: undecidable comparison (window starts ${velocity.windowStartMs})`,
        };
      }
    }
    // Task 015-14 — the same fail-closed rule, one more time, for the THIRD gate. `NaN` has no
    // `BIGINT` binding here either, and `$6 IS NULL` would read a bound `NaN` as "unbounded" —
    // the fail-OPEN direction — rather than as the undecidable input it is.
    if (dailyCalls !== undefined && Number.isNaN(dailyCalls.ceiling)) {
      return {
        ok: false,
        reason: `daily call check failed closed for provider=${provider}: undecidable comparison (ceiling ${dailyCalls.ceiling})`,
      };
    }

    await this.ready;
    const now = Date.now();

    try {
      return await this.client.transaction(async (tx) => {
        // ── 1. The daily reservation. Canonical text, `system-architecture.md` §3.4.8. ──────────
        //
        // The `WHERE` is repeated on the INSERT branch on purpose: `ON CONFLICT DO UPDATE ... WHERE`
        // governs the conflict branch alone, so without the guarded `SELECT` source the first call
        // of a day would reserve a cost larger than the whole ceiling.
        //
        // Both branches name `onchain.usage.credits_used`/`calls_made` — the row version the
        // statement itself locked — rather than a value this process read earlier. A concurrent
        // transaction blocks on that lock and re-evaluates against the committed value.
        //
        // Task 015-14 — `$6`/`calls_made` is the SECOND bound in this SAME statement, not a second
        // statement: same provider, same day, same row, same transaction as the credit bound, one
        // column over. `$6 IS NULL` leaves it unbounded exactly the way `$5 IS NULL` already does
        // for credits (`ceilingParam`'s own contract) — `dailyCalls` undefined on the caller's side
        // becomes SQL NULL here, and every reservation passes this bound.
        //
        // **THE TWO CEILINGS CARRY A CAST, AND IT IS NOT DECORATION** (task 015-30, measured
        // 2026-09-01 against PostgreSQL 16.13). Uncast, this statement never prepared at all:
        // `ERROR: inconsistent types deduced for parameter $3 — text versus bigint`. PostgreSQL
        // infers a parameter's type from every context it appears in and requires them to agree.
        // `$3 <= $5` compares two PARAMETERS, so neither types the other and both fall back to
        // `text`; two lines down `onchain.usage.credits_used + $3` deduces `bigint` from the column.
        // The contradiction is fatal at PREPARE, before a single value is bound — so on the
        // `network` profile EVERY blockscout call was refused with
        // `capability unavailable: … (SQLSTATE 42P08)` while `onchain.usage` stayed empty. The daily
        // call gate this file exists to enforce was not enforcing; it was failing closed, and a gate
        // that refuses everything looks from the outside like a vendor that answers nothing.
        //
        // **Why the CEILINGS are cast and the COST is not.** One typed side is enough: with `$5`
        // and `$6` pinned, `$3` takes `bigint` from the column arithmetic and every context agrees.
        // Casting `$3` as well would be the broader change and the worse one — `CAST(0.5 AS BIGINT)`
        // ROUNDS in PostgreSQL and TRUNCATES in SQLite, so a cast on the cost would put a
        // divergence into the one value both axes must agree on.
        //
        // **Why `CAST(x AS BIGINT)` and not `x::bigint`.** `toSqliteDialect` translates by
        // substitution and strips nothing (`sqlite/state-client.ts`), so `::bigint` would reach
        // SQLite verbatim and fail to parse. The standard form runs unedited on both engines, which
        // is the rule §4.2.4 already states for every other difference here.
        //
        // SQLite is dynamically typed and ran the uncast form happily, which is why 1738 core tests
        // stayed green through it — the same asymmetry as `recordDelta` below, whose
        // `GREATEST(0, $3)` DOES pin a type and therefore needed no change. Only a live run on the
        // Postgres axis could catch this class, and that is what caught it.
        const reserved = await tx.query<UsageRow>(
          `INSERT INTO onchain.usage (provider, day, credits_used, calls_made, updated_at)
           SELECT $1, $2, $3, 1, $4
            WHERE (CAST($5 AS BIGINT) IS NULL OR $3 <= CAST($5 AS BIGINT))
              AND (CAST($6 AS BIGINT) IS NULL OR 1 <= CAST($6 AS BIGINT))
           ON CONFLICT (provider, day) DO UPDATE SET
             credits_used = onchain.usage.credits_used + $3,
             calls_made   = onchain.usage.calls_made + 1,
             updated_at   = $4
           WHERE (CAST($5 AS BIGINT) IS NULL OR onchain.usage.credits_used + $3 <= CAST($5 AS BIGINT))
             AND (CAST($6 AS BIGINT) IS NULL OR onchain.usage.calls_made + 1 <= CAST($6 AS BIGINT))
           RETURNING credits_used, calls_made`,
          [
            provider,
            dayBucketMs,
            cost,
            now,
            ceilingParam(ceiling),
            ceilingParam(dailyCalls?.ceiling),
          ],
        );
        if (reserved.length === 0) {
          // Zero rows is a REFUSAL, not a failure, and nothing was written. Neither the message nor
          // WHICH of the two bounds refused survives a zero-row result, so one extra read is issued
          // for the text alone — it cannot widen the gate, because the decision is already made.
          throw new ReservationRefused(
            await this.dailyRefusal(tx, provider, dayBucketMs, cost, ceiling, dailyCalls),
          );
        }

        if (velocity !== undefined) {
          // ── 2. The velocity counters: the same shape on `(provider, window_start)`, with TWO
          // bounds in its `WHERE` — credits per window and `calls_made + 1` per window. The second
          // is a different DENOMINATOR, not a tighter ceiling: a credit-denominated limit cannot
          // refuse a call that costs zero credits, because `used + 0 > ceiling` is false for the
          // entire life of any bucket, under any cap (Q-3).
          const windowed = await tx.query<WindowRow>(
            `INSERT INTO onchain.usage_window
               (provider, window_start, credits_used, calls_made, updated_at)
             SELECT $1, $2, $3, 1, $6
              WHERE (CAST($4 AS BIGINT) IS NULL OR $3 <= CAST($4 AS BIGINT))
                AND (CAST($5 AS BIGINT) IS NULL OR 1 <= CAST($5 AS BIGINT))
             ON CONFLICT (provider, window_start) DO UPDATE SET
               credits_used = onchain.usage_window.credits_used + $3,
               calls_made   = onchain.usage_window.calls_made + 1,
               updated_at   = $6
             WHERE (CAST($4 AS BIGINT) IS NULL OR onchain.usage_window.credits_used + $3 <= CAST($4 AS BIGINT))
               AND (CAST($5 AS BIGINT) IS NULL OR onchain.usage_window.calls_made + 1 <= CAST($5 AS BIGINT))
             RETURNING credits_used, calls_made`,
            [
              provider,
              velocity.windowStartMs,
              cost,
              ceilingParam(velocity.ceiling),
              ceilingParam(velocity.maxCalls),
              now,
            ],
          );
          if (windowed.length === 0) {
            // The zero-row result cannot say WHICH of the two bounds refused, and the two call for
            // opposite operator responses. One extra read supplies the numbers, and the daily
            // reservation above is rolled back with it (SEC-1 — the two counters never disagree).
            throw new ReservationRefused(await this.windowRefusal(tx, provider, cost, velocity));
          }

          // ── 3. The opportunistic prune, INSIDE this transaction, so it inherits the same lock
          // instead of racing it (§4.2.4, and `cache/budget-store.ts:410` on the SQLite axis). A
          // separate job would contend for the very row lock the gate depends on; a ledger that
          // grows a row per minute per provider forever is a slow leak nobody notices.
          await tx.query(
            `DELETE FROM onchain.usage_window WHERE provider = $1 AND window_start < $2`,
            [provider, velocity.windowStartMs - WINDOW_RETENTION_MS],
          );
        }

        return { ok: true } as const;
      });
    } catch (error) {
      if (error instanceof ReservationRefused) return error.refusal;
      throw error;
    }
  }

  /**
   * Builds the velocity refusal message from the window row the refused statement did not return.
   *
   * The two reasons keep the SQLite axis's texts verbatim, because they are the operator-facing
   * strings and the two axes are meant to be indistinguishable from outside: a credit refusal names
   * the window, a call refusal names the call count, and neither can be mistaken for the daily one.
   */
  private async windowRefusal(
    tx: StateTransaction,
    provider: string,
    cost: number,
    velocity: VelocityLimit,
  ): Promise<{ ok: false; reason: string }> {
    const rows = await tx.query<WindowRow>(
      `SELECT credits_used, calls_made FROM onchain.usage_window
        WHERE provider = $1 AND window_start = $2`,
      [provider, velocity.windowStartMs],
    );
    const row = rows[0];
    const windowUsed = row === undefined ? 0 : toCounter(row.credits_used, 'credits_used');
    const windowCalls = row === undefined ? 0 : toCounter(row.calls_made, 'calls_made');

    if (windowUsed + cost > velocity.ceiling) {
      return {
        ok: false,
        reason:
          `velocity limit reached for provider=${provider}: need ${cost}, used ${windowUsed} ` +
          `of ${velocity.ceiling} in the current window (window starts ${velocity.windowStartMs})`,
      };
    }
    return {
      ok: false,
      reason:
        `call rate limit reached for provider=${provider}: ${windowCalls} of ` +
        `${String(velocity.maxCalls)} calls already made in the current window ` +
        `(window starts ${velocity.windowStartMs})`,
    };
  }

  /**
   * Builds the daily refusal message from the row the refused reservation did not return (task
   * 015-14) — the SAME shape as `windowRefusal` above, one bucket width up: a zero-row result
   * cannot say WHICH of the two bounds on the SAME row refused, and the two call for opposite
   * operator responses (raise a ceiling vs. wait for the next UTC day).
   *
   * **Credits checked first, calls second** — the same precedence `cache/budget-store.ts`'s
   * `checkAndReserve` already establishes by testing the credit ceiling before the daily-call one:
   * a reservation that breaches both reports the credit refusal.
   *
   * Kept inside the same transaction, so the numbers printed are the ones the refused statement
   * compared against — no concurrent writer can move the row between the refusal and this read.
   */
  private async dailyRefusal(
    tx: StateTransaction,
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
    dailyCalls: { ceiling: number } | undefined,
  ): Promise<{ ok: false; reason: string }> {
    const rows = await tx.query<UsageRow>(
      `SELECT credits_used, calls_made FROM onchain.usage WHERE provider = $1 AND day = $2`,
      [provider, dayBucketMs],
    );
    const row = rows[0];
    const used = row === undefined ? 0 : toCounter(row.credits_used, 'credits_used');
    const usedCalls = row === undefined ? 0 : toCounter(row.calls_made, 'calls_made');

    if (used + cost > ceiling) {
      return {
        ok: false,
        reason: `budget exceeded for provider=${provider}: need ${cost}, used ${used}, ceiling ${ceiling}`,
      };
    }
    // Unreachable with `dailyCalls === undefined`: the statement's `$6 IS NULL` branch leaves the
    // call bound unconditionally satisfied, so a refusal that is not the credit one above can only
    // be this one, and `dailyCalls` must be defined for it to have fired at all.
    //
    // `DAILY_CALL_EXHAUSTED_DETAIL` — imported, not restated (task 015-14, defect found on the
    // shipped text 2026-08-28) — is the SAME binding the SQLite axis's own exceeded branch reads,
    // so the two axes cannot drift apart on the one substring `call-gate.ts` branches on.
    return {
      ok: false,
      reason:
        `${DAILY_CALL_EXHAUSTED_DETAIL}${provider}: ${usedCalls} of ` +
        `${dailyCalls?.ceiling} calls already made today (day starts ${dayBucketMs})`,
    };
  }

  /**
   * Unconditional additive write of a SIGNED delta — obligations 1, 2 and 4 of §4.2.4 in one place.
   *
   * **No statement here binds a ceiling.** Reconciliation is a second statement and carries no
   * ceiling bound: a refund refused by a `WHERE` would strand credits nobody spent
   * (`data-model.md:582-583`).
   *
   * **`calls_made` never receives the delta.** A CALL is not refundable the way a credit is: the
   * vendor round trip happened, and refunding it would let a run of cheap-then-refunded calls walk
   * straight past the limit that exists to bound that traffic. The insert branch writes a literal
   * `0` and the update branch assigns the column to ITSELF — spelled out rather than omitted,
   * because "this statement leaves the call count alone" is then a property of the text a reader (or
   * a static gate) can check, instead of an absence they have to notice.
   *
   * **Both counters move inside one `BEGIN`.** A refund that reached only the daily ledger would
   * leave the window holding credits nobody spent, and the next reconciliation would compound the
   * drift (SEC-1).
   *
   * **`GREATEST(0, …)` on BOTH branches of BOTH upserts, and the update branch binds `$3` rather
   * than `excluded.credits_used`.** In Postgres, as in SQLite, `excluded.credits_used` IS the
   * (already clamped) VALUES expression, so referencing it in the update branch would make that
   * branch unable to SUBTRACT — silently breaking every reconciliation refund. `cache/ddl.ts`
   * records that the SQLite store shipped this defect once; the shape is not "restored for
   * consistency" here either.
   */
  async recordDelta(
    provider: string,
    dayBucketMs: number,
    signedDelta: number,
    windowStartMs?: number,
  ): Promise<void> {
    if (!Number.isFinite(signedDelta)) {
      // A non-finite delta has no `BIGINT` binding, and silently writing zero would be a refund
      // that never happened. Loud, and before the connection is taken.
      throw new Error(
        `pg/budget-store: recordDelta needs a finite delta for provider=${provider} (got ${signedDelta})`,
      );
    }
    await this.ready;
    const now = Date.now();
    await this.client.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO onchain.usage (provider, day, credits_used, calls_made, updated_at)
         VALUES ($1, $2, GREATEST(0, $3), 0, $4)
         ON CONFLICT (provider, day) DO UPDATE SET
           credits_used = GREATEST(0, onchain.usage.credits_used + $3),
           calls_made   = onchain.usage.calls_made,
           updated_at   = $4`,
        [provider, dayBucketMs, signedDelta, now],
      );
      if (windowStartMs !== undefined) {
        await tx.query(
          `INSERT INTO onchain.usage_window
             (provider, window_start, credits_used, calls_made, updated_at)
           VALUES ($1, $2, GREATEST(0, $3), 0, $4)
           ON CONFLICT (provider, window_start) DO UPDATE SET
             credits_used = GREATEST(0, onchain.usage_window.credits_used + $3),
             calls_made   = onchain.usage_window.calls_made,
             updated_at   = $4`,
          [provider, windowStartMs, signedDelta, now],
        );
      }
    });
  }

  /** Read-only — the accumulated `credits_used` for `(provider, dayBucketMs)`; zero when the row
   * does not exist, which is what "nothing spent today" looks like before the first call. */
  async getUsage(provider: string, dayBucketMs: number): Promise<number> {
    await this.ready;
    const row = await this.readDaily(provider, dayBucketMs);
    return row === undefined ? 0 : toCounter(row.credits_used, 'credits_used');
  }

  /** Read-only — the accumulated `usage.calls_made` for `(provider, dayBucketMs)` (task 015-14,
   * data-model.md §4.6.3). The DAILY counter `dailyCalls` compares against, one column over from
   * `credits_used`; zero when the row does not exist, matching every other reader here. */
  async getDailyCalls(provider: string, dayBucketMs: number): Promise<number> {
    await this.ready;
    const row = await this.readDaily(provider, dayBucketMs);
    return row === undefined ? 0 : toCounter(row.calls_made, 'calls_made');
  }

  private async readDaily(provider: string, dayBucketMs: number): Promise<UsageRow | undefined> {
    const rows = await this.client.query<UsageRow>(
      `SELECT credits_used, calls_made FROM onchain.usage WHERE provider = $1 AND day = $2`,
      [provider, dayBucketMs],
    );
    return rows[0];
  }

  /** Read-only — the accumulated `credits_used` for `(provider, windowStartMs)`. The gate never
   * needs it (the check lives inside the reservation statement); this is the only way to read the
   * window counter from OUTSIDE that transaction. */
  async getWindowUsage(provider: string, windowStartMs: number): Promise<number> {
    await this.ready;
    const row = await this.readWindow(provider, windowStartMs);
    return row === undefined ? 0 : toCounter(row.credits_used, 'credits_used');
  }

  /** Read-only — the accumulated `calls_made` for `(provider, windowStartMs)` (Q-3). */
  async getWindowCalls(provider: string, windowStartMs: number): Promise<number> {
    await this.ready;
    const row = await this.readWindow(provider, windowStartMs);
    return row === undefined ? 0 : toCounter(row.calls_made, 'calls_made');
  }

  private async readWindow(
    provider: string,
    windowStartMs: number,
  ): Promise<WindowRow | undefined> {
    const rows = await this.client.query<WindowRow>(
      `SELECT credits_used, calls_made FROM onchain.usage_window
        WHERE provider = $1 AND window_start = $2`,
      [provider, windowStartMs],
    );
    return rows[0];
  }
}
