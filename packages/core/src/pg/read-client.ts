import { Pool } from 'pg';

/**
 * The minimal shape this module actually needs from a `pg` `Pool` instance — kept narrow (not the
 * full `pg` `Pool` API surface) so tests can inject a lightweight fake pool constructor without
 * ever touching a real Postgres connection (R-21 — no live PG in tests). Real `pg`'s `Pool`
 * satisfies this structurally. `on` is OPTIONAL (only the real `pg.Pool` — an `EventEmitter` — and
 * any fake that chooses to model it need to implement it); this module only ever calls
 * `pool.on?.('error', ...)`, so a minimal fake that never emits an idle-connection error doesn't
 * need to implement it at all.
 */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** Constructor shape this module calls `new` on — production default is the real `pg.Pool`;
 * tests inject a fake that never opens a socket. `connectionTimeoutMillis`/`max` are the two
 * conservative pool-sizing knobs this module always sets explicitly (adversarial cycle 1, fix
 * D1) — never left at `pg`'s own (looser) defaults. */
export type PgPoolCtor = new (config: {
  connectionString: string;
  options?: string;
  connectionTimeoutMillis?: number;
  max?: number;
}) => PgPoolLike;

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

/** Conservative pool-sizing defaults (adversarial cycle 1, fix D1) — this is a READ-ONLY,
 * optional, single-adapter client (`pg-history`), not a general-purpose app pool: a small `max`
 * bounds how many idle connections a misbehaving/slow Postgres can accumulate, and a bounded
 * `connectionTimeoutMillis` means a dead/unreachable DSN fails fast instead of hanging a `fetch()`
 * call indefinitely. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_POOL_SIZE = 3;

/** The ONLY message ever surfaced to a caller (and, transitively, an MCP client) when the
 * underlying `pool.query()` call itself fails — the real error (which may embed the DSN's host/
 * port/user, e.g. `pg`'s own "connection to server at ... failed" text) is written to stderr ONLY
 * (adversarial cycle 1, fix D2/D10). */
const SANITIZED_QUERY_FAILURE_MESSAGE = 'pg-history: database unavailable';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazy, read-only Postgres client (ARCHITECTURE.md §3.2, R-12) — used ONLY by
 * `adapters/pg-history/index.ts` (not a separate side-channel, F-2). The underlying `pg.Pool` is
 * constructed ONLY on the first `query()` call, AND only when `ONCHAIN_PG_URL` is actually set
 * (`isAvailable()` reports the reason otherwise, WITHOUT ever including the DSN value itself in
 * that reason string — secrets are never logged, D10/§7.2). `search_path=onchain` is set via the
 * connection's own `options` (DB-SCHEMA-CONCEPT's Postgres schema-isolation convention: the
 * engine role reads/writes an explicit `onchain` schema, never `public`), not a per-query `SET`
 * statement.
 *
 * **Hardened (adversarial cycle 1, fix D):**
 * - `pool.on('error', ...)` is attached immediately after construction (once, right after `new
 *   PoolCtor(...)`) — an IDLE connection in the pool erroring out (a `pg.Pool`-documented event,
 *   fired independently of any in-flight `query()` call) is logged to stderr only and otherwise
 *   ignored; without this listener, Node treats an unhandled `'error'` event on an `EventEmitter`
 *   as an uncaught exception and CRASHES THE WHOLE PROCESS — exactly what this module must never
 *   do for an optional, best-effort history source.
 * - `connectionTimeoutMillis`/`max` (see their constants above) are always passed to `PoolCtor`.
 * - Any failure from the actual `pool.query(...)` call (as opposed to the guard clauses above,
 *   which throw their own already-safe, DSN-free messages) is logged to stderr with its full
 *   detail, then rethrown as the single sanitized `SANITIZED_QUERY_FAILURE_MESSAGE` — the DSN's
 *   host/port/user never reach the caller (and, transitively, never reach an MCP client).
 */
export function createReadClient(deps: ReadClientDeps = {}): ReadClient {
  const env = deps.env ?? process.env;
  // Cast at the DI boundary only: the real `pg.Pool` constructor's actual config type (`PoolConfig`)
  // is broader than the narrow `{connectionString, options?, connectionTimeoutMillis?, max?}`
  // shape this module ever passes it — this cast documents that intentional narrowing rather than
  // fighting structural variance.
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
        pool = new PoolCtor({
          connectionString,
          options: '-c search_path=onchain',
          connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
          max: DEFAULT_MAX_POOL_SIZE,
        });
        pool.on?.('error', (err: Error) => {
          process.stderr.write(
            `pg/read-client: idle pool error (connection details never logged): ${errorMessage(err)}\n`,
          );
        });
      }
      try {
        const result = await pool.query(sql, params);
        return result.rows as T[];
      } catch (error) {
        process.stderr.write(
          `pg/read-client: query failed (full detail on stderr only, never surfaced to the caller): ${errorMessage(error)}\n`,
        );
        // `cause` preserves the original error for local debugging/stack-trace purposes (and
        // satisfies this repo's `preserve-caught-error` lint rule) — it is NEVER read by this
        // codebase's own error handling (every catch site here only ever reads `.message`, never
        // `.cause`), so the sanitized `.message` above remains the only thing that ever reaches a
        // caller/MCP client; the raw detail already went to stderr on the line above regardless.
        throw new Error(SANITIZED_QUERY_FAILURE_MESSAGE, { cause: error });
      }
    },
  };
}
