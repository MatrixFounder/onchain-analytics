import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { AdapterRegistration } from '../adapters/types.js';
import { cacheDbPath } from './data-dir.js';
import { CACHE_DDL, USAGE_COLUMNS, USAGE_WINDOW_COLUMNS } from './ddl.js';
import { adapterRegistrations } from '../providers.config.js';

/**
 * Provider-agnostic credit-budget ledger (task 005-2, R-34/R-35, system-architecture.md §3.2
 * "M2-дополнение: `BudgetStore`", data-model.md §4.2). Same injection pattern as `CacheStore`/
 * `SqliteCacheStore` (M1) — the interface knows nothing about any specific provider (no `nansen`
 * mention anywhere in this file outside a test), only about a bucket-relative `(provider,
 * dayBucketMs)` counter compared against an already-computed `ceiling` the caller supplies.
 *
 * `Promise<...>` on every method is an INTERFACE-level convention (consistency with `CacheStore`,
 * which `registry.ts` already `await`s, and forward-compat with a future Postgres-backed
 * implementation, D7) — it does NOT imply the concrete `SqliteBudgetStore` does real async work.
 * See that class's `checkAndReserve` docstring for the atomicity contract this signature must
 * preserve.
 */
/**
 * The SECOND, rate-denominated limit `checkAndReserve` may enforce (SEC-1) — a bucket start and a
 * ceiling, exactly like the daily pair, just with a much shorter bucket width.
 *
 * `BudgetStore` stays provider-agnostic and policy-free: it does not know the window width, how the
 * ceiling was derived, or that any of this is about credits per minute. The caller computes both
 * numbers; this interface only compares them — the same discipline `ceiling` already follows.
 */
export interface VelocityLimit {
  /** Epoch-ms UTC start of the window this cost falls in. */
  readonly windowStartMs: number;
  /** Credits this window may hold in total. */
  readonly ceiling: number;
  /**
   * Calls this window may hold in total (Q-3) — a SECOND denominator, not a variant of the first.
   *
   * A credit-denominated limit cannot refuse a call that costs zero credits: `used + 0 > ceiling`
   * is false for the entire life of any bucket, under any cap. That is not a bug in the ceiling,
   * it is what "denominated in credits" means — so the fix is a different unit, not a tighter
   * number. Omitted ⇒ calls are not bounded (the pre-Q-3 behaviour).
   */
  readonly maxCalls?: number;
}

export interface BudgetStore {
  /**
   * Atomically compares `usage.credits_used(provider, dayBucketMs) + cost` against `ceiling` and,
   * only if it fits, additively reserves `cost` (same write path as `recordDelta`). On `ok:false`
   * NOTHING is written — `usage` is left bit-for-bit as it was before the call (not a rollback of
   * a partial write — there never was one).
   *
   * `ceiling` is always the caller's already-computed `effectiveCeiling` (system-architecture.md
   * §3.2 "The bucket ceiling formula") — `BudgetStore` itself knows nothing about anchors/
   * `usageAtObserve`/`NansenAccountSnapshot`; it only ever compares two plain numbers.
   *
   * **`velocity`, when supplied, is checked and reserved IN THE SAME TRANSACTION** (SEC-1). That is
   * the whole point and not an implementation detail: two processes sharing `cache.sqlite3` — a
   * supported topology, several stdio sessions per machine — would otherwise each pass their own
   * window check against a stale read and both spend. Either BOTH limits fit and BOTH counters are
   * written, or neither is touched.
   *
   * **`dailyCalls`, when supplied, is a THIRD gate, checked and reserved in the SAME transaction**
   * (R-9, task 015-13). Not a variant of `velocity.maxCalls` — three differences, not one
   * (MINOR-7 round 1):
   * - a DIFFERENT ledger: `usage(provider, dayBucketMs)` — the same row this call's own `cost`
   *   reserves against — never `usage_window(provider, windowStartMs)`;
   * - a DIFFERENT row lifetime: the daily `usage` row lives the whole UTC day, while
   *   `usage_window` rows are pruned after `WINDOW_RETENTION_MS` (an hour, below) — restating a
   *   day's worth of calls on that ledger would mean disabling the very prune that keeps it small;
   * - no required neighbour: `dailyCalls` needs no `windowStartMs`, unlike `VelocityLimit`, whose
   *   `windowStartMs` is mandatory.
   *
   * As of task 015-14, every implementation reads `usage.calls_made` for `(provider,
   * dayBucketMs)` inside this SAME transaction, compares `+ 1` against `dailyCalls.ceiling`, and
   * — only when the call is admitted, alongside the write `cost` already makes — increments it by
   * exactly 1.
   */
  checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
    velocity?: VelocityLimit,
    dailyCalls?: { ceiling: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Unconditional additive write of a SIGNED delta (pre-call reservation uses a positive `cost`;
   * post-call reconciliation uses `actual - reserved`, which may be negative). Never gates —
   * callers that need a ceiling check use `checkAndReserve` first.
   *
   * `windowStartMs` mirrors the delta into the velocity counter. It must be the window the
   * RESERVATION was made in, never the window that happens to be current at reconcile time (SEC-1):
   * a call outliving its window would otherwise refund credits into a window that never spent them,
   * handing a runaway loop free headroom in the very next window.
   */
  recordDelta(
    provider: string,
    dayBucketMs: number,
    signedDelta: number,
    windowStartMs?: number,
  ): Promise<void>;
  /** Read-only — the current accumulated `credits_used` for `(provider, dayBucketMs)`. */
  getUsage(provider: string, dayBucketMs: number): Promise<number>;
  /** Read-only — the accumulated `credits_used` for `(provider, windowStartMs)`. Observability and
   * tests; the gate itself never needs it (the check lives inside the reservation transaction). */
  getWindowUsage(provider: string, windowStartMs: number): Promise<number>;
  /** Read-only — the accumulated `calls_made` for `(provider, windowStartMs)` (Q-3). */
  getWindowCalls(provider: string, windowStartMs: number): Promise<number>;
  /**
   * Read-only — the accumulated `usage.calls_made` for `(provider, dayBucketMs)` (task 015-14,
   * data-model.md §4.6.3). The DAILY counter `dailyCalls` compares against — the same bucket
   * `getUsage` already reads credits from, one column over. Zero when the row does not exist,
   * matching every other reader here.
   */
  getDailyCalls(provider: string, dayBucketMs: number): Promise<number>;
}

/** Constructor options for `SqliteBudgetStore` (task 005-2). */
export interface SqliteBudgetStoreOptions {
  /** Absolute path to the sqlite file, or `':memory:'` for tests. Defaults to `${DATA_DIR}/cache.sqlite3`. */
  dbPath?: string;
  /** Adapter registrations to upsert into `providers` BEFORE any `usage` write (self-sufficient
   * bootstrap — see the class docstring). Defaults to the real `adapterRegistrations`. */
  providers?: AdapterRegistration[];
}

interface UsageRow {
  credits_used: number;
  calls_made: number;
}

interface WindowRow {
  credits_used: number;
  calls_made: number;
}

/**
 * How far back `usage_window` rows are kept (SEC-1). Only the CURRENT window is ever read, so this
 * is retention for after-the-fact inspection, not for the guard. An hour is enough to see what a
 * burst looked like while keeping the table from growing a row per minute forever — the kind of
 * slow leak in a state directory nobody notices until it matters.
 */
const WINDOW_RETENTION_MS = 3_600_000;

/**
 * The DETAIL half of the daily-exhaustion refusal — deliberately WITHOUT the marker
 * `ProviderCallCeilingExceededError` (`adapters/blockscout/call-gate.ts`) itself supplies (task
 * 015-14, defect found on the shipped text 2026-08-28: "два дефекта в тексте отказа гейта").
 *
 * **Defect 1, fixed by moving the marker out of here.** That class's constructor builds
 * `daily call ceiling reached: ${reason}`. Before this constant existed, `reason` ALSO started
 * with `daily call ceiling reached for provider=…`, so the full thrown message repeated the
 * phrase twice. The class owns the marker; this store owns the detail — one phrase, one owner,
 * said once.
 *
 * **Defect 2, fixed by giving `ensureCallBudget` a value to branch on.** Every fail-closed
 * refusal from this same `checkAndReserve` (a corrupted `credits_used` or `calls_made` value) used
 * to reach the caller wrapped in the SAME class, asserting "the ceiling is reached" about a
 * refusal that never established that — the ceiling may not have been approached at all, only the
 * ledger value was unreadable. `call-gate.ts` now tests `reason.startsWith(this)` and wraps as
 * `ProviderCallCeilingExceededError` ONLY when it is true; every other refusal — including both
 * fail-closed branches below — becomes `ProviderCallGateUnavailableError` instead, which never
 * claims the ceiling was reached.
 *
 * **Exported and shared, not restated per axis.** `pg/budget-store.ts` imports this SAME binding
 * for its own daily-exceeded text (`dailyRefusal`) — one constant, so the two axes cannot drift
 * apart on the one substring `call-gate.ts` and `vendor-spend-gates.test.ts`'s AC-25 both key on.
 *
 * Deliberately does NOT contain the substring `daily call ceiling reached` — a value that did
 * would defeat the whole point of separating detail from marker.
 */
export const DAILY_CALL_EXHAUSTED_DETAIL = 'daily calls spent for provider=';

/**
 * `better-sqlite3`-backed `BudgetStore` (task 005-2, R-34/R-35, data-model.md §4.2). Opens its OWN
 * connection to the SAME cache file `SqliteCacheStore` uses (`cacheDbPath()`, `cache/data-dir.ts`)
 * — **self-sufficient bootstrap**: the constructor runs `db.exec(CACHE_DDL)` (idempotent — the
 * SAME string `SqliteCacheStore` runs, now including `usage`) and upserts every
 * `options.providers ?? adapterRegistrations` entry into `providers` itself, BEFORE any `usage`
 * write can reference one as a foreign key — it never assumes a `SqliteCacheStore` was already
 * constructed against this file first (a standalone `new SqliteBudgetStore({dbPath: ':memory:'})`
 * must work on its own, TC-UNIT-07).
 *
 * **The bootstrap upsert writes `registration.tier` (task 012-3), and the anti-clobber rule that
 * used to govern it is SUPERSEDED — not quietly dropped.** Until 012-3 this method wrote a literal
 * `kind: 'unknown'` and reconciled with `ON CONFLICT (id) DO NOTHING`, and both halves had a
 * stated reason: the classification lived in `SqliteCacheStore` as a hardcoded `PAID_PROVIDER_IDS`
 * set, replicating it here would have meant hardcoding provider ids into this file too, and
 * `DO NOTHING` then protected a row a `SqliteCacheStore` had already classified correctly from
 * being overwritten with `'unknown'` by a budget store opened against the same file afterwards.
 * ADR-002 D8 removed the premise: `tier` is a required field of every `AdapterRegistration`, so
 * **both writers now derive the same value from the same registration** and there is nothing left
 * to clobber — the "protection" would only preserve a STALE row (every pre-012-3 file has all
 * twelve rows sitting at `'unknown'` forever). Hence `ON CONFLICT (id) DO UPDATE SET
 * kind = excluded.kind`, the exact form `SqliteCacheStore.bootstrapProviders()` already used. The
 * old rule is recorded here rather than deleted because the diff otherwise reads as a protection
 * being removed, which is the one thing it must not be mistaken for.
 *
 * **`PRAGMA foreign_keys = ON` is re-issued on THIS connection** (connection-scoped, not persisted
 * in the file, DB-SCHEMA-CONCEPT §1.6) — proven by `recordDelta`/`checkAndReserve` for an
 * unregistered provider throwing (TC-UNIT-06), the same behavioral proof `SqliteCacheStore`'s own
 * test suite uses. Opens with `new Database(path, { timeout: 5000 })` — not the driver's default
 * `0`ms — since `DATA_DIR` is shared per-machine by default (system-architecture.md §"Cross-process
 * контракт" — several stdio Claude Code sessions can hold independent writer connections to the
 * same `cache.sqlite3`); a busy write now waits up to 5s instead of failing immediately.
 */
export class SqliteBudgetStore implements BudgetStore {
  private readonly db: Database.Database;
  private readonly selectUsageStmt: Database.Statement;
  private readonly upsertUsageStmt: Database.Statement;
  private readonly selectWindowStmt: Database.Statement;
  private readonly upsertWindowStmt: Database.Statement;
  private readonly pruneWindowStmt: Database.Statement;

  constructor(options: SqliteBudgetStoreOptions = {}) {
    const dbPath = options.dbPath ?? cacheDbPath();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath, { timeout: 5000 });

    // Mirrors SqliteCacheStore's leak-safe constructor (post-M1 polish, fix 4): every step below
    // runs AFTER the connection is already open — a throw from any of them must best-effort
    // close() the already-opened handle before rethrowing, instead of leaking a file descriptor.
    try {
      // Re-issued on EVERY connection open (DB-SCHEMA-CONCEPT §1.6) — connection-scoped, not
      // persisted in the file. Literal `PRAGMA foreign_keys = ON` via `exec()` (not
      // `.pragma('foreign_keys = ON')`), matching SqliteCacheStore's own convention so this line
      // is greppable verbatim (task 005-2 acceptance).
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.pragma('journal_mode = WAL');
      // Idempotent — IF NOT EXISTS guards every table, including a co-located SqliteCacheStore's
      // providers/cache_entries (no migration of either, R-34 acceptance).
      this.db.exec(CACHE_DDL);
      this.migrateUsageWindow();
      this.migrateUsage();
      this.bootstrapProviders(options.providers ?? adapterRegistrations);

      this.selectUsageStmt = this.db.prepare(
        `SELECT credits_used, calls_made FROM usage WHERE provider = ? AND day = ?`,
      );
      this.selectWindowStmt = this.db.prepare(
        `SELECT credits_used, calls_made FROM usage_window WHERE provider = ? AND window_start = ?`,
      );
      // Same additive-upsert shape as `usage`, and for the same reasons — see the long note on
      // `upsertUsageStmt` below for why the DO UPDATE branch binds `@delta` rather than
      // `excluded.credits_used` (clamping the VALUES expression would make the update branch
      // unable to subtract, silently breaking every reconciliation refund).
      this.upsertWindowStmt = this.db.prepare(
        // `calls` is 1 on a reservation and 0 on a reconciliation delta — a CALL is not refundable
        // the way a credit is (Q-3). The vendor round trip happened; refunding it would let a
        // sequence of cheap-then-refunded calls walk straight past the limit that exists to bound
        // exactly that traffic.
        `INSERT INTO usage_window (provider, window_start, credits_used, calls_made, updated_at)
         VALUES (@provider, @window, MAX(0, @delta), MAX(0, @calls), @now)
         ON CONFLICT (provider, window_start) DO UPDATE SET
           credits_used = MAX(0, credits_used + @delta),
           calls_made = MAX(0, calls_made + @calls),
           updated_at = @now`,
      );
      // Windows are 60s-ish and only the CURRENT one is ever read, so old rows are pure dead
      // weight. Pruned opportunistically inside the reservation transaction (bounded, indexed by
      // the primary key) rather than by a scheduled job — a credit ledger that grows a row per
      // minute per provider forever is a slow leak nobody would notice.
      this.pruneWindowStmt = this.db.prepare(
        `DELETE FROM usage_window WHERE provider = @provider AND window_start < @cutoff`,
      );
      // The SAME additive-upsert SQL serves BOTH write paths (checkAndReserve's reservation branch
      // and recordDelta) — data-model.md §4.2's literal statement, `@delta` is a signed integer.
      this.upsertUsageStmt = this.db.prepare(
        // `MAX(0, …)` on BOTH branches, and the DO UPDATE branch references the bound `@delta`
        // DIRECTLY rather than `excluded.credits_used` (adversarial cycle 1).
        //
        // Why not the obvious `VALUES (…, MAX(0, @delta), …)` while keeping `excluded` in the
        // update: in SQLite `excluded.credits_used` IS the VALUES expression, so clamping there
        // also clamps `excluded` — and the update branch could then no longer SUBTRACT, silently
        // breaking every reconciliation refund (R-38's signed delta). TC-UNIT-02/03 caught exactly
        // that. Binding `@delta` in both branches decouples them: the fresh-row INSERT stores a
        // clamped 0 instead of seeding a negative counter (which `checkAndReserve` would read as
        // free headroom), while an existing row still subtracts correctly.
        //
        // `CHECK (credits_used >= 0)` in ddl.ts is then belt-and-suspenders: unreachable in normal
        // operation because both branches clamp, but it turns any future code path that bypasses
        // this statement into a loud constraint violation rather than a silently widened budget.
        // `@calls` is 1 on a reservation and 0 on a reconciliation delta — the same discipline
        // `upsertWindowStmt` above already applies one bucket width down (task 015-14): a CALL is
        // not refundable the way a credit is, so `recordDelta` binds 0 and never moves this column.
        `INSERT INTO usage (provider, day, credits_used, calls_made, updated_at)
         VALUES (@provider, @day, MAX(0, @delta), MAX(0, @calls), @now)
         ON CONFLICT (provider, day) DO UPDATE SET
           credits_used = MAX(0, credits_used + @delta),
           calls_made = MAX(0, calls_made + @calls),
           updated_at = @now`,
      );
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Swallow — a close-time failure on an already-broken connection must never mask the
        // ORIGINAL error being rethrown below.
      }
      throw error;
    }
  }

  /**
   * Applies every additive column `usage_window` has gained since it shipped (Q-3).
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a file that already has the table, so a new column
   * needs an explicit `ALTER`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the presence check is
   * `PRAGMA table_info` — which is what makes this idempotent on every open, and what keeps the
   * migration MECHANICAL rather than a project (DB-SCHEMA-CONCEPT §1). Additive only: nothing is
   * dropped or retyped, so an older process still reading this file keeps working.
   */
  private migrateUsageWindow(): void {
    const existing = new Set(
      (this.db.pragma('table_info(usage_window)') as { name: string }[]).map((c) => c.name),
    );
    for (const column of USAGE_WINDOW_COLUMNS) {
      if (!existing.has(column.name)) this.db.exec(column.ddl);
    }
  }

  /**
   * Applies every additive column `usage` has gained since it shipped (task 015-02, data-model.md
   * §4.6.3) — the identical idempotent `PRAGMA table_info` presence check `migrateUsageWindow()`
   * above already uses, one bucket width up (DAY instead of minute). `CREATE TABLE IF NOT EXISTS`
   * is a no-op on a file that already has `usage`, so a column added after the table shipped needs
   * this explicit `ALTER`. `DEFAULT 0` means an existing row is correct with no backfill: a day
   * bucket that predates the column has, by definition, zero counted calls.
   */
  private migrateUsage(): void {
    const existing = new Set(
      (this.db.pragma('table_info(usage)') as { name: string }[]).map((c) => c.name),
    );
    for (const column of USAGE_COLUMNS) {
      if (!existing.has(column.name)) this.db.exec(column.ddl);
    }
  }

  /**
   * Upserts every registration into `providers` so the FK target exists before any `usage` write —
   * writing `registration.tier` into `kind`, and reconciling an existing row rather than leaving
   * it (see the class docstring's superseded-anti-clobber note for why the reconciliation flipped).
   *
   * **No default for a missing `tier`.** `providers.kind` is `TEXT NOT NULL` (`ddl.ts`), so a
   * registration that reaches here without one makes better-sqlite3 refuse to bind `undefined` —
   * loudly, at construction, naming the parameter. A `?? 'free'` would turn that into a silent
   * invented value, which is exactly what R-150(c) forbids: a rank that can be omitted is a rank
   * that gets defaulted (`assertValidAdapterRegistrations()` is the same guarantee, earlier).
   */
  private bootstrapProviders(registrations: AdapterRegistration[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO providers (id, kind, notes) VALUES (@id, @kind, NULL)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`,
    );
    for (const registration of registrations) {
      upsert.run({ id: registration.id, kind: registration.tier });
    }
  }

  /**
   * `db.transaction(fn).immediate()` — `IMMEDIATE`, not the driver's default `DEFERRED` (see the
   * class + interface docstrings above and system-architecture.md §"Атомарный check+reserve" for
   * the full WAL-specific rationale: `DEFERRED` lets a concurrent writer's read-then-upgrade race
   * fail with `SQLITE_BUSY_SNAPSHOT` immediately, bypassing the busy-handler/`timeout` entirely).
   * `fn` itself runs synchronously start-to-finish — it never pauses on a promise anywhere inside
   * it — which is the actual source of the atomicity guarantee (the surrounding `Promise<...>`
   * return type is purely for interface consistency with `CacheStore`; a future Postgres
   * `BudgetStore` that does real async I/O between its read and its write, INSIDE what looks like
   * the same "transaction", forfeits this guarantee entirely — the synchronicity, not the
   * `Promise` wrapper, is what matters).
   */
  async checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
    velocity?: VelocityLimit,
    // Task 015-14 — read and compared against `usage.calls_made` below, inside this SAME
    // transaction, between the credit-ceiling check and the velocity check (see the interface
    // docstring above for why this is a THIRD gate on a DIFFERENT ledger, not a variant of
    // `velocity.maxCalls`).
    dailyCalls?: { ceiling: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const now = Date.now();
    const attempt = this.db.transaction((): { ok: true } | { ok: false; reason: string } => {
      const row = this.selectUsageStmt.get(provider, dayBucketMs) as UsageRow | undefined;
      const used = row?.credits_used ?? 0;
      const usedCalls = row?.calls_made ?? 0;

      // FAIL CLOSED when the comparison below cannot decide (cycle-4 verification pass, security
      // F-6). `used + cost > ceiling` evaluates to `false` — i.e. APPROVED — whenever an operand is
      // `NaN`, and also for the `Infinity > Infinity` pair. That is the wrong direction for a money
      // guard: a `>` test must not authorise spend when it has no answer.
      //
      // Per operand, deliberately NOT a blanket `Number.isFinite` on all three:
      // - `used` must be a finite number. It comes from SQLite, which is dynamically typed, so a
      //   TEXT value written into `usage.credits_used` by anything else sharing this file survives
      //   the `CHECK (credits_used >= 0)` DDL and would turn `used + cost` into string concatenation.
      //   `cache.sqlite3` is designed as shared per-machine across sessions, so a foreign writer is
      //   a supported topology, not an exotic one.
      // - `cost` must be finite. `costOf()` returns `+Infinity` for an unpriced capability
      //   (fail-closed by design); against a `+Infinity` ceiling that would otherwise slip through
      //   as `Infinity > Infinity === false`.
      // - `ceiling` may legitimately be `+Infinity` — the explicit "no self-imposed ceiling"
      //   sentinel — so only `NaN` is rejected here. A finite check would break that contract.
      if (typeof used !== 'number' || !Number.isFinite(used)) {
        return {
          ok: false,
          reason: `budget check failed closed for provider=${provider}: ledger value is not a finite number (used ${String(used)})`,
        };
      }
      if (!Number.isFinite(cost) || Number.isNaN(ceiling)) {
        return {
          ok: false,
          reason:
            `budget check failed closed for provider=${provider}: undecidable comparison ` +
            `(need ${cost}, used ${used}, ceiling ${ceiling})`,
        };
      }

      if (used + cost > ceiling) {
        return {
          ok: false,
          reason: `budget exceeded for provider=${provider}: need ${cost}, used ${used}, ceiling ${ceiling}`,
        };
      }

      // Task 015-14 (R-9, ADR-003 D6) — the DAILY call ceiling, a THIRD gate on a DIFFERENT
      // ledger from `velocity.maxCalls` below (see the interface docstring: different row, never
      // pruned, no required `windowStartMs`). Checked here, between the credit ceiling above and
      // the velocity window below, so a call that breaches both the daily-credit and the
      // daily-call bound reports the credit refusal — the same precedence the two credit/velocity
      // checks already establish.
      //
      // `blockscout`'s `costOf` returns 0 for every capability, so `used + 0 > ceiling` is FALSE
      // for the entire life of any bucket, under any credit cap (R-9.4) — this is the ONLY
      // comparison in this function a zero-cost call cannot walk straight past.
      if (dailyCalls !== undefined) {
        // Fail closed on a ledger value that cannot be compared, the same rule `used` above
        // already follows and for the same reason: a TEXT value written into `calls_made` by
        // another writer sharing this file would turn `usedCalls + 1` into string concatenation.
        if (typeof usedCalls !== 'number' || !Number.isFinite(usedCalls)) {
          return {
            ok: false,
            reason: `daily call check failed closed for provider=${provider}: ledger value is not a finite number (calls ${String(usedCalls)})`,
          };
        }
        // `NaN` and "exceeds" share one branch and one text on purpose: both mean the SAME thing
        // to the caller — this call is not admitted today — and a caller has no different action
        // to take for either (contrast the credit/velocity checks above, whose undecidable-value
        // case is a distinct, config-level defect worth a distinct message).
        if (Number.isNaN(dailyCalls.ceiling) || usedCalls + 1 > dailyCalls.ceiling) {
          return {
            ok: false,
            reason:
              `${DAILY_CALL_EXHAUSTED_DETAIL}${provider}: ${usedCalls} of ` +
              `${dailyCalls.ceiling} calls already made today (day starts ${dayBucketMs})`,
          };
        }
      }

      // SEC-1 — the velocity check, INSIDE this same transaction and BEFORE either write. The
      // reason string names the window explicitly, because from the outside a rate refusal and a
      // daily refusal are otherwise indistinguishable, and they call for opposite operator
      // responses: wait a minute versus raise a ceiling.
      if (velocity !== undefined) {
        const windowRow = this.selectWindowStmt.get(provider, velocity.windowStartMs) as
          WindowRow | undefined;
        const windowUsed = windowRow?.credits_used ?? 0;
        const windowCalls = windowRow?.calls_made ?? 0;
        // Fail closed on an undecidable comparison, exactly as the daily check above does and for
        // the same reason: `>` answers `false` for `NaN`, and `false` here means "approved".
        if (typeof windowUsed !== 'number' || !Number.isFinite(windowUsed)) {
          return {
            ok: false,
            reason: `velocity check failed closed for provider=${provider}: window ledger value is not a finite number (used ${String(windowUsed)})`,
          };
        }
        if (Number.isNaN(velocity.ceiling)) {
          return {
            ok: false,
            reason: `velocity check failed closed for provider=${provider}: undecidable comparison (need ${cost}, window used ${windowUsed})`,
          };
        }
        if (windowUsed + cost > velocity.ceiling) {
          return {
            ok: false,
            reason:
              `velocity limit reached for provider=${provider}: need ${cost}, used ${windowUsed} ` +
              `of ${velocity.ceiling} in the current window (window starts ${velocity.windowStartMs})`,
          };
        }
        // Q-3 — the call limit, checked here so a ZERO-cost call is bounded by something. Its own
        // reason prefix, because it is a different DENOMINATOR and not a tighter ceiling: raising
        // the credit allowance would not move it at all.
        if (velocity.maxCalls !== undefined) {
          if (typeof windowCalls !== 'number' || !Number.isFinite(windowCalls)) {
            return {
              ok: false,
              reason: `call-rate check failed closed for provider=${provider}: window ledger value is not a finite number (calls ${String(windowCalls)})`,
            };
          }
          if (Number.isNaN(velocity.maxCalls) || windowCalls + 1 > velocity.maxCalls) {
            return {
              ok: false,
              reason:
                `call rate limit reached for provider=${provider}: ${windowCalls} of ` +
                `${velocity.maxCalls} calls already made in the current window ` +
                `(window starts ${velocity.windowStartMs})`,
            };
          }
        }
        this.upsertWindowStmt.run({
          provider,
          window: velocity.windowStartMs,
          delta: cost,
          calls: 1,
          now,
        });
        // Opportunistic prune of windows that can never be read again. Inside the transaction so
        // it inherits the same lock rather than racing it; bounded by the primary-key index.
        this.pruneWindowStmt.run({
          provider,
          cutoff: velocity.windowStartMs - WINDOW_RETENTION_MS,
        });
      }

      // `calls: 1` — the reservation itself IS an admitted call (task 015-14). Reached only when
      // every gate above passed, so this is the single write site for a successful reservation.
      this.upsertUsageStmt.run({ provider, day: dayBucketMs, delta: cost, calls: 1, now });
      return { ok: true };
    });

    return attempt.immediate();
  }

  async recordDelta(
    provider: string,
    dayBucketMs: number,
    signedDelta: number,
    windowStartMs?: number,
  ): Promise<void> {
    const now = Date.now();
    // Both counters move together or the velocity guard drifts tighter than configured: a refund
    // (`actual - reserved` is negative when a call cost less than its reservation, or failed
    // outright) that reached only the daily ledger would leave the window still holding credits
    // nobody spent. Written in one transaction so a crash between them cannot leave them disagreeing.
    const write = this.db.transaction(() => {
      // `calls: 0` — a reconciliation adjusts CREDITS, never the daily call count (task 015-14,
      // MINOR-5), mirroring `calls: 0` on `upsertWindowStmt` below one bucket width over. The
      // vendor round trip already happened; refunding it would let a run of cheap-then-refunded
      // calls walk past the very limit that exists to bound that traffic.
      this.upsertUsageStmt.run({ provider, day: dayBucketMs, delta: signedDelta, calls: 0, now });
      if (windowStartMs !== undefined) {
        // `calls: 0` — a reconciliation adjusts CREDITS, never the call count (Q-3). The vendor
        // round trip already happened; "refunding" it would let a run of cheap-then-refunded calls
        // walk past the very limit that exists to bound that traffic.
        this.upsertWindowStmt.run({
          provider,
          window: windowStartMs,
          delta: signedDelta,
          calls: 0,
          now,
        });
      }
    });
    write.immediate();
  }

  async getUsage(provider: string, dayBucketMs: number): Promise<number> {
    const row = this.selectUsageStmt.get(provider, dayBucketMs) as UsageRow | undefined;
    return row?.credits_used ?? 0;
  }

  async getWindowUsage(provider: string, windowStartMs: number): Promise<number> {
    const row = this.selectWindowStmt.get(provider, windowStartMs) as WindowRow | undefined;
    return row?.credits_used ?? 0;
  }

  async getWindowCalls(provider: string, windowStartMs: number): Promise<number> {
    const row = this.selectWindowStmt.get(provider, windowStartMs) as WindowRow | undefined;
    return row?.calls_made ?? 0;
  }

  async getDailyCalls(provider: string, dayBucketMs: number): Promise<number> {
    const row = this.selectUsageStmt.get(provider, dayBucketMs) as UsageRow | undefined;
    return row?.calls_made ?? 0;
  }

  /** Closes the underlying connection — callers (tests, process shutdown) own the lifecycle. */
  close(): void {
    this.db.close();
  }
}

/**
 * Factory (task 005-2 — same "factory, not module singleton" principle as `createCacheStore`,
 * ARCHITECTURE.md §8): constructs a fresh `SqliteBudgetStore`, injectable options passed straight
 * through. No two-level (hot + persistent) composition here, unlike `createCacheStore` — a credit
 * ledger has no meaningful in-memory hot layer to promote into (every read must see the latest
 * cross-process-committed value).
 */
export function createBudgetStore(options: SqliteBudgetStoreOptions = {}): BudgetStore {
  return new SqliteBudgetStore(options);
}
