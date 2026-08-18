import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { AdapterRegistration } from '../adapters/types.js';
import type { TokenBucketConfig } from '../net/rate-limit.js';
import {
  waitMsFor,
  type LimiterKey,
  type LimiterStore,
  type LimiterTake,
} from '../net/limiter-store.js';
import { cacheDbPath } from './data-dir.js';
import { CACHE_DDL } from './ddl.js';
import { adapterRegistrations } from '../providers.config.js';

/**
 * The limiter's bucket state on the SQLite axis — task 014-18, R-7.1/R-7.2, `data-model.md` §4.5.6.
 *
 * **What changes and what does not.** The arithmetic is the one `rate-limit.ts` has always run;
 * where it runs is what moves. Two `local` processes against one `DATA_DIR` shared nothing before
 * this class and each held the vendor's full rate, so the vendor saw double (AC-4). The bucket now
 * lives in a row both processes upsert, and it survives either of them exiting (AC-5).
 *
 * **Why it sits beside `budget-store.ts` rather than in `net/`.** This is the SQLite axis, and the
 * axis lives in this directory: the same file, the same DDL, the same busy timeout, the same
 * `IMMEDIATE` discipline. `net/limiter-store.ts` keeps the interface and the in-process fallback,
 * and importing `better-sqlite3` there would put a storage engine inside the network layer for the
 * benefit of one of three implementations.
 */

/** Constructor options for `SqliteLimiterStore` — the same pair `SqliteBudgetStoreOptions` takes. */
export interface SqliteLimiterStoreOptions {
  /** Absolute path to the sqlite file, or `':memory:'` for tests. Defaults to
   * `${DATA_DIR}/cache.sqlite3` — the SAME file the cache and budget stores open. */
  dbPath?: string;
  /** Registrations upserted into `providers` before any bucket write, because
   * `provider_buckets.provider` references it. Defaults to the real `adapterRegistrations`. */
  providers?: AdapterRegistration[];
}

interface TokensRow {
  tokens: number;
}

/**
 * How long a write waits for another connection's lock before giving up — the same 5 000 ms
 * `SqliteBudgetStore` and `sqlite/state-client.ts` apply, and for the same reason: this process
 * already holds other connections to this file, so a write here can meet a writer rather than an
 * idle database. The driver's own default is zero, which turns ordinary contention into an
 * immediate `SQLITE_BUSY`.
 */
const BUSY_TIMEOUT_MS = 5_000;

export class SqliteLimiterStore implements LimiterStore {
  private readonly db: Database.Database;
  private readonly takeStmt: Database.Statement;
  private readonly refundStmt: Database.Statement;

  constructor(options: SqliteLimiterStoreOptions = {}) {
    const file = options.dbPath ?? cacheDbPath();
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { timeout: BUSY_TIMEOUT_MS });
    try {
      this.db.pragma('journal_mode = WAL');
      // DB-SCHEMA §1.6 makes the Repository responsible for this on EVERY connection, and here it
      // is load-bearing rather than belt-and-braces: `provider_buckets.provider` is the only
      // cross-group foreign key of §4.5, and a bucket written for a provider that is not in the
      // registry is a typo'd id silently getting its own private rate limit.
      this.db.pragma('foreign_keys = ON');
      this.db.exec(CACHE_DDL);
      this.bootstrapProviders(options.providers ?? adapterRegistrations);

      // §4.5.6's statement, in the SQLite dialect. The key, the columns and the arithmetic are
      // identical to the Postgres one; `MIN` is the scalar minimum there and `LEAST` is here.
      //
      // `MAX(0, …)` on the elapsed interval is NOT in the document's rendering of this statement,
      // and it is here because the in-process bucket has always clamped it
      // (`Math.max(0, nowMs - bucket.lastRefillMs)`). `Date.now()` is a wall clock and steps
      // backwards on an NTP correction; unclamped, the refill term would go negative and the
      // statement would CHARGE the caller for time that did not pass. That over-restricts rather
      // than over-admits, so it was never a money defect — but it would have been a difference
      // between the shared limiter and the bucket R-7.7 degrades to, which is the one place a
      // difference must not be.
      this.takeStmt = this.db.prepare(
        `INSERT INTO provider_buckets (provider, scope_key, tokens, last_refill_ms, updated_at)
         VALUES (@provider, @scope, @capacity - @weight, @now, @now)
         ON CONFLICT (provider, scope_key) DO UPDATE SET
           tokens = MIN(@capacity, provider_buckets.tokens
                        + MAX(0, @now - provider_buckets.last_refill_ms) / 1000.0 * @refill)
                    - @weight,
           last_refill_ms = @now,
           updated_at = @now
         RETURNING tokens`,
      );

      // The refund (§4.5.6, "The refund is a second statement"). `tokens` only: see
      // `LimiterStore.refund` for why `last_refill_ms` must not move, and why this is not `take`
      // with a negative weight.
      //
      // `UPDATE` and not an upsert: a refund with no row is a refund for a slot that was never
      // taken, and seeding a row here would need a capacity this call does not carry.
      this.refundStmt = this.db.prepare(
        `UPDATE provider_buckets SET tokens = tokens + @weight, updated_at = @now
         WHERE provider = @provider AND scope_key = @scope`,
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

  /** Upserts the FK target, exactly as `SqliteBudgetStore` does for `usage`. Without it every
   * limiter write is a foreign-key refusal and R-7.7 would degrade the process permanently
   * (§4.5.6). */
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
   * `db.transaction(fn).immediate()` — `IMMEDIATE`, not the driver's default `DEFERRED`, the same
   * discipline `checkAndReserve` uses. Under WAL, `DEFERRED` lets a concurrent writer's
   * read-then-upgrade race fail with `SQLITE_BUSY_SNAPSHOT` immediately, bypassing the
   * busy-handler and the `timeout` above entirely.
   *
   * **One statement inside a transaction is not redundant here.** The statement alone is atomic;
   * the wrapper is what takes the write lock up front, so N processes queue on the lock instead of
   * failing each other's snapshots. The `Promise` is interface consistency — `fn` runs
   * synchronously start to finish, and THAT is what makes concurrent callers in one process see
   * each other's committed state rather than race on a stale read.
   */
  take(
    key: LimiterKey,
    config: TokenBucketConfig,
    weight: number,
    nowMs: number,
  ): Promise<LimiterTake> {
    const attempt = this.db.transaction((): number => {
      const row = this.takeStmt.get({
        provider: key.providerId,
        scope: key.scopeKey,
        capacity: config.capacity,
        weight,
        now: nowMs,
        refill: config.refillPerSec,
      }) as TokensRow | undefined;
      // `RETURNING` on an upsert answers for both branches, so an absent row means the statement
      // did not run — a state this module has no reading of, and would rather refuse than paper
      // over with a full bucket.
      if (row === undefined) {
        throw new Error(
          `SqliteLimiterStore: the bucket statement returned no row for ` +
            `(${key.providerId}, ${key.scopeKey}) — the limiter has no state to decide on`,
        );
      }
      return row.tokens;
    });
    const tokensLeft = attempt.immediate();
    return Promise.resolve({ tokensLeft, waitMs: waitMsFor(tokensLeft, config.refillPerSec) });
  }

  refund(key: LimiterKey, weight: number, nowMs: number): Promise<void> {
    const write = this.db.transaction((): void => {
      this.refundStmt.run({
        provider: key.providerId,
        scope: key.scopeKey,
        weight,
        now: nowMs,
      });
    });
    write.immediate();
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

/** Factory mirroring `createBudgetStore` — the shape `pg/stores.ts` builds the axis from. */
export function createSqliteLimiterStore(
  options: SqliteLimiterStoreOptions = {},
): SqliteLimiterStore {
  return new SqliteLimiterStore(options);
}
