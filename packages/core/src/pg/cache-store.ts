import { ulid } from 'ulid';
import type { CacheGetResult, CacheStore } from '../adapters/cache-store.js';
import { ttlFor } from '../cache/ttl.js';
import type { StateClient } from './state-client.js';

/** Constructor options for `PgCacheStore` (`system-architecture.md` §3.4.8). */
export interface PgCacheStoreOptions {
  /** The write-capable client (`createStateClient`). Required and not defaulted: a cache store that
   * silently built its own client would decide the DSN, and the DSN is the profile's decision. */
  client: StateClient;
  /** How many `set()` calls between opportunistic expired-row sweeps. Defaults to
   * `DEFAULT_SWEEP_EVERY_N_WRITES` (50), the same cadence `SqliteCacheStore` uses; tests override
   * it so the sweep path is reachable without looping fifty times. */
  sweepEveryNWrites?: number;
  /**
   * The `providers` bootstrap barrier — `PgBudgetStore.ready` (`pg/stores.ts` passes it).
   *
   * **Why this store waits on another store's promise.** `cache_entries.provider` is a foreign key
   * into the twelve `providers` rows, and on this axis the budget store is their only writer (one
   * writer per registry, which is the version of that arrangement that cannot drift). A cache write
   * that overtakes the bootstrap is refused with `23503` — and a refused cache WRITE is best-effort
   * by design (`packages/core/src/adapters/registry.ts:1242`), so it would be swallowed, and the
   * process would simply stop caching without saying why.
   *
   * Omitted, nothing is awaited: a caller building this store alone has taken responsibility for
   * the registry itself.
   */
  ready?: Promise<void>;
}

/** Same default and same reason as `SqliteCacheStore`'s: see `sweepExpired()` below for what this
 * does and, as importantly, does not do (no retention or size cap). */
const DEFAULT_SWEEP_EVERY_N_WRITES = 50;

/** Shape of one `onchain.cache_entries` row as `pg` hands it back. `created_at`/`expires_at` are
 * `BIGINT`, and `pg` returns `BIGINT` as a STRING — see `toEpochMs` for why that is not corrected
 * globally. */
interface CacheEntryRow {
  value_json: unknown;
  created_at: unknown;
  expires_at: unknown;
}

/**
 * Coerces one `BIGINT` column into the JS number this codebase's epoch-ms discipline expects.
 *
 * **Why the coercion exists at all.** `pg` parses `int8` to a STRING by default, because an
 * arbitrary `bigint` does not survive a JS number. Left uncoerced, `row.expires_at <= now` would
 * compare a string against a number, `now - row.created_at` would be `NaN`, and every entry would
 * look fresh forever — the failure would be silent and would look like a working cache.
 *
 * **Why it is not fixed globally with `pg.types.setTypeParser`.** That is process-wide state: it
 * would also rewrite what `pg-history` reads out of `onchain.snapshots`, where `value_raw` is
 * deliberately exact and `TEXT`-shaped precisely because credits exceed 2^53
 * (DB-SCHEMA-CONCEPT §1.7). A store must not change how another store's rows are parsed.
 *
 * **Why a non-numeric value refuses rather than defaults.** `Number('')` is `0` and `Number(null)`
 * is `0`; a `0` here reads as "written at the epoch", i.e. expired, or as "no credits used", i.e.
 * free headroom. A value the column cannot hold is a broken installation, and it says so.
 */
export function toEpochMs(value: unknown, column: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`pg/cache-store: ${column} is neither a number nor a string`);
  }
  // `Number('')` is 0, so the emptiness has to be refused before the conversion, not after it.
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`pg/cache-store: ${column} is empty`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`pg/cache-store: ${column} is not a finite number`);
  }
  return parsed;
}

/**
 * Postgres-backed persistent cache layer — the SECOND implementation of the `CacheStore` seam
 * (`packages/core/src/adapters/cache-store.ts:25`) and NOT a change to it: both of its methods were
 * already `Promise`-returning, so this axis adds an implementation and alters no signature
 * (`system-architecture.md` §3.4.8).
 *
 * **Only the persistent half moves.** `TwoLevelStore` takes its persistent layer by constructor
 * injection, so the Postgres axis constructs the same class over a different second argument, and
 * `LruHotLayer` stays in process on both axes — a shared hot layer would need a network round trip
 * per lookup, which is the cost the layer exists to avoid.
 *
 * **What the split then guarantees is restated, not preserved.** Over one Postgres table each
 * process holds its own hot layer, so a value written by process A is invisible to B's hot layer
 * until B's own entry expires. That staleness is bounded by the capability's TTL, which already
 * bounds a single process's hot hit, and `_meta.cache.ageMs` stays the age of the VALUE because a
 * promoted entry is back-dated (`cache/two-level-store.ts:70`). The freshness contract already
 * tolerated a full TTL of staleness, which is why a shared hot layer is not the fix.
 *
 * **This class runs no DDL.** A shared Postgres server is not this process's to alter; the numbered
 * migration file is the only writer of schema (`data-model.md` §4.4 item 2). Unlike
 * `SqliteCacheStore`, which execs `CACHE_DDL` on every open, the table must already exist — and if
 * it does not, the failure is a loud `PgStateServerRejectedError` naming SQLSTATE `42P01`, not a
 * table quietly created in whatever schema the pooler's `search_path` happened to name.
 *
 * **No `providers` bootstrap here, deliberately.** `cache_entries.provider` is a foreign key, and
 * `PgBudgetStore`'s construction upserts the twelve rows. Two bootstrappers of one registry is the
 * arrangement `SqliteCacheStore`/`SqliteBudgetStore` already had to reconcile once (the `notes`
 * clobber of adversarial cycle 2); one writer of that table per axis is the version of the fix that
 * cannot drift. The factory in `pg/stores.ts` constructs the pair together.
 */
export class PgCacheStore implements CacheStore {
  private readonly client: StateClient;
  private readonly sweepEveryNWrites: number;
  private readonly ready: Promise<void>;
  private writeCount = 0;

  constructor(options: PgCacheStoreOptions) {
    this.client = options.client;
    this.sweepEveryNWrites = options.sweepEveryNWrites ?? DEFAULT_SWEEP_EVERY_N_WRITES;
    this.ready = options.ready ?? Promise.resolve();
  }

  /**
   * One indexed equality read on `(provider, capability, args_hash)`; a stale row is deleted on the
   * same path `SqliteCacheStore.get` deletes it, so a lingering expired row never shadows a
   * subsequent write.
   *
   * **Why expiry is decided here and not in the `WHERE` clause.** The SQLite store reads the row,
   * compares against `Date.now()` and deletes — comparing in SQL would move the clock to the
   * database server, and this project's canon is that time is an epoch-ms integer the APPLICATION
   * supplies (DB-SCHEMA-CONCEPT §1.2, "no DB time functions in application logic"). Two axes
   * reading two clocks is also how a cache entry becomes fresh on one host and stale on another.
   */
  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    const rows = await this.client.query<CacheEntryRow>(
      `SELECT value_json, created_at, expires_at FROM onchain.cache_entries
        WHERE provider = $1 AND capability = $2 AND args_hash = $3`,
      [provider, capability, argsHash],
    );
    const row = rows[0];
    if (!row) return undefined;

    const now = Date.now();
    if (toEpochMs(row.expires_at, 'expires_at') <= now) {
      await this.client.query(
        `DELETE FROM onchain.cache_entries
          WHERE provider = $1 AND capability = $2 AND args_hash = $3`,
        [provider, capability, argsHash],
      );
      return undefined;
    }

    if (typeof row.value_json !== 'string') {
      throw new Error('pg/cache-store: value_json is not TEXT');
    }
    return {
      value: JSON.parse(row.value_json) as unknown,
      ageMs: now - toEpochMs(row.created_at, 'created_at'),
    };
  }

  /**
   * The upsert of §3.2 on `(provider, capability, args_hash)`, with `excluded.*` in the update
   * branch: a recomputed value replaces the stale one rather than being pinned by a
   * conflict-do-nothing insert.
   *
   * **`excluded.*` is correct HERE and wrong in the budget store, and the difference is the write
   * semantics.** `cache_entries` is a recomputable projection, so the new row IS the intended value.
   * `usage.credits_used` is an additive counter, where `excluded` would be the clamped VALUES
   * expression and would make the update branch unable to subtract (`cache/ddl.ts` records that
   * defect). Two upserts, two shapes, both deliberate.
   */
  async set(
    provider: string,
    capability: string,
    argsHash: string,
    value: unknown,
    ttlSecondsOverride?: number,
  ): Promise<void> {
    // The foreign-key target must exist before the row that references it — see `ready`'s own
    // docstring for what a race here looks like from the outside (nothing).
    await this.ready;
    const now = Date.now();
    const expiresAt = now + (ttlSecondsOverride ?? ttlFor(capability)) * 1000;
    await this.client.query(
      `INSERT INTO onchain.cache_entries
         (id, provider, capability, args_hash, value_json, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider, capability, args_hash) DO UPDATE SET
         value_json = excluded.value_json,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
      // The id is an app-generated ULID (DB-SCHEMA-CONCEPT §1.3) — nothing here relies on the
      // engine's own row numbering, which is what keeps an engine move mechanical.
      [ulid(), provider, capability, argsHash, JSON.stringify(value), now, expiresAt],
    );

    this.writeCount += 1;
    if (this.writeCount % this.sweepEveryNWrites === 0) {
      await this.sweepExpired();
    }
  }

  /**
   * Opportunistic expired-row sweep — counter-based and indexed, exactly as on the SQLite axis, so
   * no timer runs inside the server process (`system-architecture.md` §3.4.8 item 3).
   *
   * **NOT a retention or size cap.** It only keeps rows that have already EXPIRED from lingering:
   * `get()` deletes a stale row on read, but a key that is never read again would otherwise sit in
   * the table forever. A maximum row count is a separate, not-yet-built concern.
   *
   * **Why the failure is swallowed and the write is not.** A sweep is housekeeping; a caller that
   * successfully stored its value must not be told the store failed because the cleanup after it
   * did. The registry already treats a cache write as best-effort
   * (`packages/core/src/adapters/registry.ts:1242`), so this only keeps that decision from being
   * re-made by an unrelated statement.
   */
  private async sweepExpired(): Promise<void> {
    try {
      await this.client.query(`DELETE FROM onchain.cache_entries WHERE expires_at <= $1`, [
        Date.now(),
      ]);
    } catch (error) {
      process.stderr.write(
        `pg/cache-store: expired-row sweep failed, entries stay until the next attempt: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}
