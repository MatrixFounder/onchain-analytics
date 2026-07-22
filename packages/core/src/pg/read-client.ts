import { Pool } from 'pg';

/**
 * The minimal shape this module actually needs from a `pg` `Pool` instance — kept narrow (not the
 * full `pg` `Pool` API surface) so tests can inject a lightweight fake pool constructor without
 * ever touching a real Postgres connection (R-21 — no live PG in tests). Real `pg`'s `Pool`
 * satisfies this structurally.
 */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Constructor shape this module calls `new` on — production default is the real `pg.Pool`;
 * tests inject a fake that never opens a socket. */
export type PgPoolCtor = new (config: { connectionString: string; options?: string }) => PgPoolLike;

export interface ReadClientDeps {
  env?: NodeJS.ProcessEnv;
  PoolCtor?: PgPoolCtor;
}

export interface ReadClient {
  isAvailable(): { ok: true } | { ok: false; reason: string };
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Runtime SELECT-only gate (R-27) — a second, defense-in-depth check alongside the code-review
 * grep this task's acceptance runs; this module never issues a write statement regardless. */
const SELECT_ONLY_RE = /^\s*select\b/i;

/**
 * Lazy, read-only Postgres client (ARCHITECTURE.md §3.2, R-12) — used ONLY by
 * `adapters/pg-history/index.ts` (not a separate side-channel, F-2). The underlying `pg.Pool` is
 * constructed ONLY on the first `query()` call, AND only when `ONCHAIN_PG_URL` is actually set
 * (`isAvailable()` reports the reason otherwise, WITHOUT ever including the DSN value itself in
 * that reason string — secrets are never logged, D10/§7.2). `search_path=onchain` is set via the
 * connection's own `options` (DB-SCHEMA-CONCEPT's Postgres schema-isolation convention: the
 * engine role reads/writes an explicit `onchain` schema, never `public`), not a per-query `SET`
 * statement.
 */
export function createReadClient(deps: ReadClientDeps = {}): ReadClient {
  const env = deps.env ?? process.env;
  // Cast at the DI boundary only: the real `pg.Pool` constructor's actual config type (`PoolConfig`)
  // is broader than the narrow `{connectionString, options?}` shape this module ever passes it —
  // this cast documents that intentional narrowing rather than fighting structural variance.
  const PoolCtor = deps.PoolCtor ?? (Pool as unknown as PgPoolCtor);
  let pool: PgPoolLike | undefined;

  function dsn(): string | undefined {
    return env['ONCHAIN_PG_URL'];
  }

  return {
    isAvailable: () => (dsn() ? { ok: true } : { ok: false, reason: 'needs ONCHAIN_PG_URL' }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (!SELECT_ONLY_RE.test(sql)) {
        throw new Error('pg/read-client: only SELECT statements are allowed (R-27)');
      }
      const connectionString = dsn();
      if (!connectionString) {
        throw new Error('pg/read-client: needs ONCHAIN_PG_URL');
      }
      if (!pool) {
        // Lazy: constructed HERE, on the first query() call — never at module load or at
        // createReadClient()'s own call time.
        pool = new PoolCtor({ connectionString, options: '-c search_path=onchain' });
      }
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
  };
}
