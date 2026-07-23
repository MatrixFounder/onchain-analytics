import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { CacheGetResult, CacheStore } from '../adapters/cache-store.js';
import type { AdapterRegistration } from '../adapters/types.js';
import { cacheDbPath } from './data-dir.js';
import { CACHE_DDL } from './ddl.js';
import { ttlFor } from './ttl.js';

/** Constructor options for `SqliteCacheStore` (ARCHITECTURE.md §3.2/§4.2). */
export interface SqliteCacheStoreOptions {
  /** Absolute path to the sqlite file, or `':memory:'` for tests. Defaults to `${DATA_DIR}/cache.sqlite3`. */
  dbPath?: string;
  /** Adapter registrations to upsert into `providers` BEFORE any `cache_entries` write (bootstrap). */
  providers?: AdapterRegistration[];
  /** How many `set()` calls between opportunistic expired-row sweeps (adversarial cycle 1, fix H).
   * Defaults to `DEFAULT_SWEEP_EVERY_N_WRITES` (50); tests override this to a small number so the
   * sweep path is reachable without looping 50 times. */
  sweepEveryNWrites?: number;
  /** TEST-ONLY seam (post-M1 polish, cheap-fix backlog item 4) — NEVER set by production code.
   * When supplied, called as the very first post-open step, before the PRAGMA/DDL/bootstrap/
   * statement-prepare sequence below runs. Lets `test/cache.test.ts` simulate an arbitrary
   * post-open constructor failure (standing in for a real DDL-exec/bootstrap/prepare throw)
   * without needing a genuinely malformed DDL string or corrupt provider row, to prove the
   * constructor closes the already-opened `better-sqlite3` handle before rethrowing rather than
   * leaking it. */
  postOpenTestHook?: () => void;
}

/** Default sweep cadence (adversarial cycle 1, fix H) — see `sweepExpired()`'s own docstring for
 * what this does and, just as importantly, does NOT do (no retention/size cap — that's M2). */
const DEFAULT_SWEEP_EVERY_N_WRITES = 50;

/**
 * `providers.kind` classification (DDL comment: "'free' | 'paid' — informational, reflects D4
 * priority"). `AdapterRegistration` itself carries no such field (D4's "free→paid priority" is a
 * routing/config-authoring concept, not a machine-readable property of a registration) — this is a
 * small, explicit, sourced lookup instead of a guessed heuristic: ARCHITECTURE.md §3.2's own
 * nine-adapter summary table documents `dune` as the sole credit-metered (Dune Query API credits)
 * provider among the nine; every other M1 adapter is keyless or works on a free tier. Purely
 * informational — no logic reads this column yet — defaults anything not listed here to `'free'`.
 */
const PAID_PROVIDER_IDS = new Set<string>(['dune']);

interface CacheEntryRow {
  value_json: string;
  created_at: number;
  expires_at: number;
}

/**
 * `better-sqlite3`-backed persistent cache layer (ARCHITECTURE.md §3.2/§4.2, DB-SCHEMA-CONCEPT §1):
 * bootstraps `providers` from the supplied adapter registrations BEFORE any `cache_entries` write
 * can reference one as a foreign key, then serves `get`/`set` with upsert + read-time TTL-expiry
 * semantics (`cache_entries` is a recomputable projection, not an append-only log — see `ddl.ts`).
 *
 * **Leak-safe constructor (post-M1 polish, cheap-fix backlog item 4):** every step that runs AFTER
 * the connection opens (PRAGMA/DDL exec, providers bootstrap, statement prepare) is wrapped in a
 * try/catch — a throw from any of them now best-effort `close()`s the already-opened handle
 * (swallowing any close-time error) before rethrowing the original failure, instead of leaking an
 * open file descriptor/connection.
 */
export class SqliteCacheStore implements CacheStore {
  private readonly db: Database.Database;
  private readonly sweepEveryNWrites: number;
  private writeCount = 0;

  // Adversarial cycle 2, fix 5 — each of these four statements is `prepare()`d exactly ONCE, here
  // in the constructor, and reused (via `.get()`/`.run()`) on every subsequent call — `get()`/
  // `set()` used to call `this.db.prepare(...)` fresh on every single invocation, re-parsing and
  // re-planning the identical SQL text every time. `better-sqlite3`'s `Statement` objects are safe
  // to reuse across calls with different bound parameters (that's their whole purpose). The
  // one-time `providers` bootstrap upsert (below, `bootstrapProviders`) already only ever prepares
  // its own statement once per instance (it's already called at most once, from the constructor),
  // so it's left as a local `prepare()` there rather than a fifth long-lived field.
  private readonly selectStmt: Database.Statement;
  private readonly deleteStaleStmt: Database.Statement;
  private readonly upsertStmt: Database.Statement;
  private readonly sweepStmt: Database.Statement;

  constructor(options: SqliteCacheStoreOptions = {}) {
    this.sweepEveryNWrites = options.sweepEveryNWrites ?? DEFAULT_SWEEP_EVERY_N_WRITES;
    const dbPath = options.dbPath ?? cacheDbPath();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);

    // Post-M1 polish, fix 4: every step below runs AFTER the connection is already open — a throw
    // from any of them (DDL exec, providers bootstrap, statement prepare, or the TEST-ONLY hook)
    // used to leak the already-opened `better-sqlite3` handle, since nothing closed it before the
    // exception propagated out of the constructor. Best-effort `close()` (swallowing any close-time
    // error, which must never mask the ORIGINAL failure) before rethrowing the original error
    // unchanged.
    try {
      options.postOpenTestHook?.();

      // Re-issued on EVERY connection open (DB-SCHEMA-CONCEPT §1.6) — the engine does not enforce a
      // reference column by default, and this pragma is connection-scoped, not persisted in the
      // file. Issued via `exec()` (literal `PRAGMA foreign_keys = ON`, not
      // `.pragma('foreign_keys = ON')`) so this line is greppable verbatim (task 003-3 acceptance).
      this.db.exec('PRAGMA foreign_keys = ON;');
      // Persisted in the file itself (unlike `foreign_keys`) — concurrent reads aren't blocked by a
      // write (ARCHITECTURE.md §3.2).
      this.db.pragma('journal_mode = WAL');
      this.db.exec(CACHE_DDL);

      if (options.providers) {
        this.bootstrapProviders(options.providers);
      }

      this.selectStmt = this.db.prepare(
        `SELECT value_json, created_at, expires_at FROM cache_entries
         WHERE provider = ? AND capability = ? AND args_hash = ?`,
      );
      this.deleteStaleStmt = this.db.prepare(
        `DELETE FROM cache_entries WHERE provider = ? AND capability = ? AND args_hash = ?`,
      );
      this.upsertStmt = this.db.prepare(
        `INSERT INTO cache_entries (id, provider, capability, args_hash, value_json, created_at, expires_at)
         VALUES (@id, @provider, @capability, @argsHash, @valueJson, @createdAt, @expiresAt)
         ON CONFLICT (provider, capability, args_hash) DO UPDATE SET
           value_json = excluded.value_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      );
      this.sweepStmt = this.db.prepare(`DELETE FROM cache_entries WHERE expires_at <= ?`);
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
   * Upserts every adapter registration into `providers` before any `cache_entries` row can
   * reference it (ARCHITECTURE.md §3.2/§4.2 — bootstrap from ALL 9 `adapterRegistrations`,
   * including `pg-history`, F-2).
   */
  private bootstrapProviders(registrations: AdapterRegistration[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO providers (id, kind, notes) VALUES (@id, @kind, @notes)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, notes = excluded.notes`,
    );
    for (const registration of registrations) {
      upsert.run({
        id: registration.id,
        kind: PAID_PROVIDER_IDS.has(registration.id) ? 'paid' : 'free',
        notes: null,
      });
    }
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    const row = this.selectStmt.get(provider, capability, argsHash) as CacheEntryRow | undefined;

    if (!row) return undefined;

    const now = Date.now();
    if (row.expires_at <= now) {
      // Stale — delete so a lingering expired row never shadows a subsequent write, and report a
      // miss (ARCHITECTURE.md §3.2 — expiry checked on read).
      this.deleteStaleStmt.run(provider, capability, argsHash);
      return undefined;
    }

    return { value: JSON.parse(row.value_json) as unknown, ageMs: now - row.created_at };
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    const now = Date.now();
    const expiresAt = now + ttlFor(capability) * 1000;
    this.upsertStmt.run({
      id: ulid(),
      provider,
      capability,
      argsHash,
      valueJson: JSON.stringify(value),
      createdAt: now,
      expiresAt,
    });

    this.writeCount += 1;
    if (this.writeCount % this.sweepEveryNWrites === 0) {
      this.sweepExpired();
    }
  }

  /**
   * Opportunistic expired-row sweep (adversarial cycle 1, fix H) — deletes every `cache_entries`
   * row whose `expires_at` is already in the past, via the existing `idx_cache_entries_expiry`
   * index. Run every `sweepEveryNWrites`-th `set()` call, counter-based — no timers/background
   * jobs (M1 stays single-process, no scheduler dependency for this).
   *
   * **NOT a retention/size cap** (documented M2 deferral, per this task's own scope): this only
   * keeps rows that have EXPIRED from lingering indefinitely between reads (`get()` already
   * deletes a stale row on read, but a `(provider, capability, argsHash)` key that's never read
   * again — e.g. a one-off query whose args are never repeated — would otherwise sit in the table
   * forever). A maximum row count / disk-size ceiling is a separate, not-yet-built concern.
   */
  private sweepExpired(): void {
    this.sweepStmt.run(Date.now());
  }

  /** Closes the underlying connection — callers (tests, process shutdown) own the lifecycle. */
  close(): void {
    this.db.close();
  }
}
