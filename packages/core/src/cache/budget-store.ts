import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { AdapterRegistration } from '../adapters/types.js';
import { cacheDbPath } from './data-dir.js';
import { CACHE_DDL } from './ddl.js';
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
export interface BudgetStore {
  /**
   * Atomically compares `usage.credits_used(provider, dayBucketMs) + cost` against `ceiling` and,
   * only if it fits, additively reserves `cost` (same write path as `recordDelta`). On `ok:false`
   * NOTHING is written — `usage` is left bit-for-bit as it was before the call (not a rollback of
   * a partial write — there never was one).
   *
   * `ceiling` is always the caller's already-computed `effectiveCeiling` (system-architecture.md
   * §3.2 "Формула потолка бакета") — `BudgetStore` itself knows nothing about anchors/
   * `usageAtObserve`/`NansenAccountSnapshot`; it only ever compares two plain numbers.
   */
  checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Unconditional additive write of a SIGNED delta (pre-call reservation uses a positive `cost`;
   * post-call reconciliation uses `actual - reserved`, which may be negative). Never gates —
   * callers that need a ceiling check use `checkAndReserve` first.
   */
  recordDelta(provider: string, dayBucketMs: number, signedDelta: number): Promise<void>;
  /** Read-only — the current accumulated `credits_used` for `(provider, dayBucketMs)`. */
  getUsage(provider: string, dayBucketMs: number): Promise<number>;
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
}

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
 * **Why this bootstrap upsert writes `kind: 'unknown'` (deliberately NOT `SqliteCacheStore`'s
 * 'free'/'paid' `PAID_PROVIDER_IDS` classification):** replicating that classification here would
 * require hardcoding specific provider ids (starting with `'nansen'`) into this file's own
 * production code — the one thing this task's own scope note explicitly forbids ("the only
 * `'nansen'` mention allowed is in tests, as a string provider id"). `providers.kind` is already
 * documented (`ddl.ts`) as purely informational, read by no logic anywhere — this store only
 * needs the ROW to exist to satisfy the FK, never a correct classification. Uses
 * `ON CONFLICT (id) DO NOTHING` (not `DO UPDATE`, unlike `SqliteCacheStore`'s own bootstrap) so a
 * `SqliteBudgetStore` constructed against a file a `SqliteCacheStore` already correctly classified
 * never clobbers that classification with `'unknown'`.
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
      this.bootstrapProviders(options.providers ?? adapterRegistrations);

      this.selectUsageStmt = this.db.prepare(
        `SELECT credits_used FROM usage WHERE provider = ? AND day = ?`,
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
        `INSERT INTO usage (provider, day, credits_used, updated_at)
         VALUES (@provider, @day, MAX(0, @delta), @now)
         ON CONFLICT (provider, day) DO UPDATE SET
           credits_used = MAX(0, credits_used + @delta),
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

  /** See the class docstring's "Why this bootstrap upsert writes `kind: 'unknown'`" note. */
  private bootstrapProviders(registrations: AdapterRegistration[]): void {
    const insert = this.db.prepare(
      `INSERT INTO providers (id, kind, notes) VALUES (@id, 'unknown', NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const registration of registrations) {
      insert.run({ id: registration.id });
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
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const now = Date.now();
    const attempt = this.db.transaction((): { ok: true } | { ok: false; reason: string } => {
      const row = this.selectUsageStmt.get(provider, dayBucketMs) as UsageRow | undefined;
      const used = row?.credits_used ?? 0;

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

      this.upsertUsageStmt.run({ provider, day: dayBucketMs, delta: cost, now });
      return { ok: true };
    });

    return attempt.immediate();
  }

  async recordDelta(provider: string, dayBucketMs: number, signedDelta: number): Promise<void> {
    this.upsertUsageStmt.run({ provider, day: dayBucketMs, delta: signedDelta, now: Date.now() });
  }

  async getUsage(provider: string, dayBucketMs: number): Promise<number> {
    const row = this.selectUsageStmt.get(provider, dayBucketMs) as UsageRow | undefined;
    return row?.credits_used ?? 0;
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
