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
}

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
 */
export class SqliteCacheStore implements CacheStore {
  private readonly db: Database.Database;

  constructor(options: SqliteCacheStoreOptions = {}) {
    const dbPath = options.dbPath ?? cacheDbPath();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    // Re-issued on EVERY connection open (DB-SCHEMA-CONCEPT §1.6) — the engine does not enforce a
    // reference column by default, and this pragma is connection-scoped, not persisted in the file.
    // Issued via `exec()` (literal `PRAGMA foreign_keys = ON`, not `.pragma('foreign_keys = ON')`)
    // so this line is greppable verbatim (task 003-3 acceptance).
    this.db.exec('PRAGMA foreign_keys = ON;');
    // Persisted in the file itself (unlike `foreign_keys`) — concurrent reads aren't blocked by a
    // write (ARCHITECTURE.md §3.2).
    this.db.pragma('journal_mode = WAL');
    this.db.exec(CACHE_DDL);

    if (options.providers) {
      this.bootstrapProviders(options.providers);
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
    const row = this.db
      .prepare(
        `SELECT value_json, created_at, expires_at FROM cache_entries
         WHERE provider = ? AND capability = ? AND args_hash = ?`,
      )
      .get(provider, capability, argsHash) as CacheEntryRow | undefined;

    if (!row) return undefined;

    const now = Date.now();
    if (row.expires_at <= now) {
      // Stale — delete so a lingering expired row never shadows a subsequent write, and report a
      // miss (ARCHITECTURE.md §3.2 — expiry checked on read).
      this.db
        .prepare(
          `DELETE FROM cache_entries WHERE provider = ? AND capability = ? AND args_hash = ?`,
        )
        .run(provider, capability, argsHash);
      return undefined;
    }

    return { value: JSON.parse(row.value_json) as unknown, ageMs: now - row.created_at };
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    const now = Date.now();
    const expiresAt = now + ttlFor(capability) * 1000;
    this.db
      .prepare(
        `INSERT INTO cache_entries (id, provider, capability, args_hash, value_json, created_at, expires_at)
         VALUES (@id, @provider, @capability, @argsHash, @valueJson, @createdAt, @expiresAt)
         ON CONFLICT (provider, capability, args_hash) DO UPDATE SET
           value_json = excluded.value_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run({
        id: ulid(),
        provider,
        capability,
        argsHash,
        valueJson: JSON.stringify(value),
        createdAt: now,
        expiresAt,
      });
  }

  /** Closes the underlying connection — callers (tests, process shutdown) own the lifecycle. */
  close(): void {
    this.db.close();
  }
}
