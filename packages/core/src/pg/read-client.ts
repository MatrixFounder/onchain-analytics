import { Pool } from 'pg';
import { DeadlineExceededError } from '../net/safe-fetch.js';

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
 * D1) — never left at `pg`'s own (looser) defaults. `statement_timeout` (WI-35) is the third: it is
 * a real `pg` `Client`/`Pool` config field, sent as a startup parameter
 * (`pg/lib/client.js` — `data.statement_timeout = String(parseInt(...))`), not a per-query `SET`. */
export type PgPoolCtor = new (config: {
  connectionString: string;
  options?: string;
  connectionTimeoutMillis?: number;
  max?: number;
  statement_timeout?: number;
}) => PgPoolLike;

export interface ReadClientDeps {
  env?: NodeJS.ProcessEnv;
  PoolCtor?: PgPoolCtor;
  /**
   * Override for the in-process query bound (WI-35), in ms — the same kind of seam
   * `createThrottle({now, wait})` exists for: a test proves the mechanism at 25 ms instead of
   * waiting out the 20 000 ms production value. Production call sites omit it.
   */
  queryTimeoutMs?: number;
}

/** Per-call options for `ReadClient.query` — today only the caller's own call deadline (WI-37). */
export interface ReadQueryOptions {
  /**
   * The ABSOLUTE moment (epoch-ms) after which this query's answer is worthless — the same
   * `deadlineAtMs` `ProviderAdapter.fetch` and `SafeFetchOptions` carry, forwarded unchanged.
   *
   * Omitted, the in-process bound is `DEFAULT_QUERY_TOTAL_TIMEOUT_MS` and nothing else changes.
   * Supplied, it can only NARROW that bound, never widen it: a caller with 40 s left does not get a
   * 40 s query.
   */
  deadlineAtMs?: number;
}

export interface ReadClient {
  isAvailable(): { ok: true } | { ok: false; reason: string };
  query<T>(sql: string, params?: unknown[], options?: ReadQueryOptions): Promise<T[]>;
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

/**
 * The SERVER-side bound on one statement (WI-35). Postgres cancels the statement itself and the
 * pooled connection goes back to the pool — which is the half `DEFAULT_QUERY_TOTAL_TIMEOUT_MS`
 * below cannot do, since a client that stops waiting does not stop the server from working.
 *
 * **Two numbers, per R-149.** *Measured* — the two queries this client actually issues, run with
 * `EXPLAIN (ANALYZE, BUFFERS)` against the dev VM's `onchain.snapshots` on 2026-08-05 (2 390 rows):
 * **0.87 ms** for `platform.metrics.history` (four metrics; the planner picks a Seq Scan at this row
 * count) and **0.23 ms** for `privacy.shielded_pool.history` (one metric, `idx_snapshots_series`).
 * *Applied* — **5 000 ms**, ~5 700× the worst measurement.
 *
 * The margin is not padding, it is the three things the measurement does not cover: a cold shared
 * buffer cache (every one of those 273 buffers was a hit), a table orders of magnitude larger, and
 * an unlucky plan — the four-metric query is ALREADY on a sequential scan, so the shape that degrades
 * with row count is the shipped one. What the bound must never do is fire on a healthy query; what it
 * must do is stop one connection of the three from being held indefinitely.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The IN-PROCESS bound on one `query()` call, top to bottom (WI-35).
 *
 * **Why this exists beside the server bound.** `statement_timeout` is enforced BY Postgres, so it
 * requires a server that is still listening. The failure this module cannot otherwise survive is the
 * other one: a server or network that stops answering AFTER the connection was established.
 * `connectionTimeoutMillis` has already been spent by then, no statement timeout will ever be
 * reported, and `await pool.query(...)` waits forever — in a single-threaded stdio MCP server, which
 * is why the whole process, not one capability, is what hangs.
 *
 * **Two numbers.** *Measured* — the same 0.87 ms as above, and the two bounds NESTED inside this one:
 * `connectionTimeoutMillis` (10 000) then `statement_timeout` (5 000) plus the round trip that
 * delivers the resulting error. *Applied* — **20 000 ms**.
 *
 * **The number is a sum, not a preference.** It must exceed 10 000 + 5 000, or the two inner bounds
 * become unreachable and this one absorbs both — three failures reported as one, and the two
 * diagnosable ones (a dead DSN, a slow query) traded for the one that says only "it did not answer".
 * That is the same rule `safe-fetch.ts` applies to `effectiveHopMs`: two timers that expire in the
 * same millisecond destroy the discriminator between them.
 *
 * **`pg`'s own `query_timeout` is deliberately NOT also set.** It would be a second client-side timer
 * doing this one's job, on a schedule this module does not control, and the first of the two to fire
 * would decide the message — a coin toss between our sanitized text and `pg`'s raw one. One
 * client-side bound, owned here, where `PgPoolLike` cannot take it away.
 */
const DEFAULT_QUERY_TOTAL_TIMEOUT_MS = 20_000;

/**
 * Thrown when the in-process bound above fires (WI-35) — a DISTINCT class from the sanitized
 * `SANITIZED_QUERY_FAILURE_MESSAGE` rethrow below, for the reason `safe-fetch.ts` keeps
 * `SafeFetchTimeoutError` and `DeadlineExceededError` apart: "the database answered with an error"
 * and "the database did not answer at all" are different facts about an installation, and an
 * operator acts on them differently. Collapsing this into "database unavailable" would make the one
 * failure this bound exists to surface indistinguishable from every other one.
 *
 * DSN-free by construction: the message interpolates the bound and nothing else.
 */
export class PgQueryTimeoutError extends Error {
  constructor(public readonly boundMs: number) {
    super(`pg-history: query exceeded the ${boundMs}ms in-process bound`);
    this.name = 'PgQueryTimeoutError';
  }
}

/**
 * `promise` with an upper bound on how long THIS process waits for it (WI-35).
 *
 * It does not cancel the query — nothing in the `pg` wire protocol lets a client take back a
 * statement it already sent, which is exactly why `statement_timeout` is set as well: the server
 * stops the work, this stops the waiting. On the path where this bound fires, the server is by
 * definition not answering, so the connection is already lost rather than leaked by us.
 *
 * **No extra `.catch` on `promise`, and that is checked rather than assumed:** `Promise.race`
 * attaches its own handlers to every input, so a query that rejects AFTER this bound has already
 * settled the race is handled — the rejection is ignored, not unhandled. This matters more here
 * than it reads: an unhandled rejection ends the process on Node's default
 * `--unhandled-rejections=throw`, and the consumer is a long-lived stdio MCP server (the same
 * failure mode `safe-fetch.ts`'s `raceWithTimeout` documents).
 */
function withQueryBound<T>(promise: Promise<T>, boundMs: number, reason: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(reason()), boundMs);
    // A pending bound must never be the reason the process stays alive.
    timer.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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
 *
 * **Bounded in time (WI-35).** Until this landed, `connectionTimeoutMillis` bounded ACQUIRING a
 * connection and nothing bounded using one: `await pool.query(...)` waited as long as it took, which
 * made this the only I/O path in the package with no upper bound at all while every HTTP hop carried
 * an `AbortSignal.timeout`. Two bounds now, because they stop two different things (see each
 * constant): `statement_timeout` stops the SERVER's work and returns the connection to the pool;
 * `DEFAULT_QUERY_TOTAL_TIMEOUT_MS` stops THIS process waiting, which is the only one that survives a
 * server that went silent after the connection was established.
 *
 * **Hardened further (post-M1 polish, cheap-fix backlog item 3):** `new PoolCtor(...)` itself is
 * now wrapped in the SAME sanitize-and-rethrow pattern as the `pool.query(...)` failure above — a
 * synchronous constructor throw (e.g. `pg` rejecting a malformed connection string) used to
 * propagate its raw message, which may itself embed DSN fragments, straight to the caller.
 */
export function createReadClient(deps: ReadClientDeps = {}): ReadClient {
  const env = deps.env ?? process.env;
  // Cast at the DI boundary only: the real `pg.Pool` constructor's actual config type (`PoolConfig`)
  // is broader than the narrow `{connectionString, options?, connectionTimeoutMillis?, max?}`
  // shape this module ever passes it — this cast documents that intentional narrowing rather than
  // fighting structural variance.
  const PoolCtor = deps.PoolCtor ?? (Pool as unknown as PgPoolCtor);
  const queryTimeoutMs = deps.queryTimeoutMs ?? DEFAULT_QUERY_TOTAL_TIMEOUT_MS;
  let pool: PgPoolLike | undefined;

  function dsn(): string | undefined {
    return env['ONCHAIN_PG_URL'];
  }

  return {
    isAvailable: () => (dsn() ? { ok: true } : { ok: false, reason: 'needs ONCHAIN_PG_URL' }),
    query: async <T>(
      sql: string,
      params: unknown[] = [],
      options: ReadQueryOptions = {},
    ): Promise<T[]> => {
      if (!SELECT_ONLY_RE.test(sql)) {
        throw new Error('pg/read-client: only SELECT statements are allowed (R-27)');
      }
      const connectionString = dsn();
      if (!connectionString) {
        throw new Error('pg/read-client: needs ONCHAIN_PG_URL');
      }
      // The call deadline (WI-37). Checked BEFORE the pool is touched, for the reason `safeFetch`
      // gives for its own duplicate entry check: a bound can only cut short work that was started,
      // and not starting it is what a spent deadline must produce. A pool constructed here would
      // also be a connection opened to be abandoned.
      const { deadlineAtMs } = options;
      if (deadlineAtMs !== undefined && deadlineAtMs - Date.now() <= 0) {
        throw new DeadlineExceededError('pg-history query', deadlineAtMs);
      }
      if (!pool) {
        // Lazy: constructed HERE, on the first query() call — never at module load or at
        // createReadClient()'s own call time.
        //
        // Post-M1 polish fix 3: `new PoolCtor(...)` is a SYNCHRONOUS constructor call that sits
        // outside the query-failure try/catch below — a throw from it (e.g. `pg`'s own DSN-parsing
        // validation rejecting a malformed connection string) used to propagate RAW, potentially
        // embedding the DSN's host/port/user in its own message, exactly the class of leak fix D2
        // already closed for `pool.query()` failures. Same sanitize-and-rethrow pattern applied
        // here: the raw detail goes to stderr ONLY, the caller only ever sees the single sanitized
        // `SANITIZED_QUERY_FAILURE_MESSAGE`, with `{ cause: error }` attached (same rationale as D2
        // — never read by this codebase's own error handling, satisfies `preserve-caught-error`).
        try {
          pool = new PoolCtor({
            connectionString,
            // **Convenience, NOT a correctness dependency (WI-47).** Every query this client is
            // given must name its schema itself, because this is a connection STARTUP parameter and
            // a pooler is free to ignore or replace it: Supavisor, which owns port 5432 on the
            // shipped Supabase installation, answers with its own `cvj, public, extensions` and
            // drops this entirely. It is kept because it is correct on a direct connection and
            // makes an interactive `psql` session against the same DSN behave the same way.
            options: '-c search_path=onchain',
            connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
            max: DEFAULT_MAX_POOL_SIZE,
            // WI-35. A config field rather than a second `-c` in `options`: `pg` sends it as a
            // startup parameter either way, and a number is what a test can assert on without
            // parsing a string that also carries the search_path.
            statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
          });
        } catch (error) {
          process.stderr.write(
            `pg/read-client: pool construction failed (full detail on stderr only, never surfaced to the caller): ${errorMessage(error)}\n`,
          );
          throw new Error(SANITIZED_QUERY_FAILURE_MESSAGE, { cause: error });
        }
        pool.on?.('error', (err: Error) => {
          process.stderr.write(
            `pg/read-client: idle pool error (connection details never logged): ${errorMessage(err)}\n`,
          );
        });
      }
      // The in-process bound, NARROWED by the caller's deadline when there is one (WI-37) — the
      // deadline can only make it smaller, never larger. Which of the two is binding also decides
      // which class the failure gets, and the distinction is the same one `safe-fetch.ts` draws:
      // `DeadlineExceededError` says WE ran out of time and ends the registry's traversal;
      // `PgQueryTimeoutError` says the DATABASE did not answer within our own bound, which is a fact
      // about this source alone and leaves the walk free to ask the next one.
      const remainingMs = deadlineAtMs === undefined ? Infinity : deadlineAtMs - Date.now();
      const boundMs = Math.min(queryTimeoutMs, remainingMs);
      const deadlineIsBinding = remainingMs < queryTimeoutMs;
      try {
        const result = await withQueryBound(pool.query(sql, params), boundMs, () =>
          deadlineIsBinding && deadlineAtMs !== undefined
            ? new DeadlineExceededError('pg-history query', deadlineAtMs)
            : new PgQueryTimeoutError(boundMs),
        );
        return result.rows as T[];
      } catch (error) {
        // OUR OWN typed refusals pass through unflattened — they were built here, from our own
        // numbers, and neither message can carry a DSN (`PgQueryTimeoutError` interpolates the bound;
        // `DeadlineExceededError` redacts its context inside the class and is handed `'pg-history
        // query'`, which is not a URL at all). Nothing goes to stderr on this path either: there is
        // no vendor detail being withheld, and the caller's message already says everything known.
        //
        // **This is WI-36's defect, one transport over, and it was live here for one commit.** A
        // catch that re-messages BY DEFAULT flattens the typed class into `.cause`, where
        // `instanceof` cannot see it — so `CapabilityRegistry` would read a spent deadline as "this
        // source failed, try later" and every adapter behind it would be asked with no time left.
        // The rule the two places share: sanitize what came from OUTSIDE, never what this module
        // itself constructed.
        if (error instanceof PgQueryTimeoutError || error instanceof DeadlineExceededError) {
          throw error;
        }
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
