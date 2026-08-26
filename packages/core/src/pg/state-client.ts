import { Pool } from 'pg';

/**
 * The minimal shape this module needs from a `pg` `Pool` — deliberately NOT the full `pg` API, for
 * the reason `read-client.ts` gives for its own `PgPoolLike`: a narrow structural type is what lets
 * a test inject a fake pool and never open a socket (R-21 — no live Postgres in `pnpm test`). The
 * real `pg.Pool` satisfies it structurally.
 *
 * **`connect` is required here and absent there, and that difference is the whole module.** The
 * read client issues one autocommit statement per call, so a pool-level `query()` is enough. The
 * state client must run several statements on ONE checked-out connection inside one
 * `BEGIN`/`COMMIT` (`system-architecture.md` §3.4.8: "Both statements run on **one** checked-out
 * connection inside one `BEGIN` / `COMMIT`"). A pool-level `query()` gives no such promise — `pg`
 * is free to serve each call from a different connection, which would put `BEGIN` on one
 * connection and the reservation on another.
 */
export interface PgStatePoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgStateConnectionLike>;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * One checked-out connection. `release` is `pg`'s own `PoolClient.release` — it takes no argument
 * in every call this module makes, so the parameter list stays empty rather than modelling `pg`'s
 * `release(err?)` overload a fake would then have to reproduce.
 */
export interface PgStateConnectionLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** Constructor shape this module calls `new` on — the real `pg.Pool` in production, a fake in
 * tests. The four config knobs are the same ones `read-client.ts` always sets explicitly rather
 * than inheriting `pg`'s looser defaults; see each constant below for its own number. */
export type PgStatePoolCtor = new (config: {
  connectionString: string;
  options?: string;
  connectionTimeoutMillis?: number;
  max?: number;
  statement_timeout?: number;
}) => PgStatePoolLike;

export interface StateClientDeps {
  env?: NodeJS.ProcessEnv;
  PoolCtor?: PgStatePoolCtor;
  /** Override for the in-process query bound, in ms — the same test seam `ReadClientDeps` carries:
   * a test proves the mechanism at 25 ms instead of waiting out the production value. Production
   * call sites omit it. */
  queryTimeoutMs?: number;
}

/** One statement inside an open transaction. Deliberately only `query`: `COMMIT` and `ROLLBACK`
 * belong to `transaction()` itself, so a body cannot end the transaction it is running inside and
 * then keep issuing statements against a connection that is no longer in one. */
export interface StateTransaction {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface StateClient {
  isAvailable(): { ok: true } | { ok: false; reason: string };
  /** One autocommit statement. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs `fn` on ONE checked-out connection between `BEGIN` and `COMMIT`. A throw from `fn` rolls
   * back and propagates; the connection is released on every path.
   *
   * **A throw is the only way out that rolls back, and callers use it deliberately.** A refusal —
   * `checkAndReserve` returning `{ok:false}` — is a legitimate value, not a failure, but it must
   * still abandon whatever the first statement of the pair wrote. `PgBudgetStore` therefore throws
   * a class private to its own module and converts it back into a value at its own boundary, so no
   * caller of `BudgetStore` ever sees a throw for a refusal.
   */
  transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T>;
}

/**
 * The thirteen engine tables of `data-model.md` §4.4/§4.6.1, and the input of the runtime
 * schema-qualification guard below (R-30.1).
 *
 * **Why the list is here rather than derived from the SQL.** A guard that inferred table names from
 * the statement it is checking would be inferring them from the text it is supposed to police. This
 * list is compared against the UNION of `sql/migrations/002_t014_network_profile.sql` (the first
 * twelve) and `sql/migrations/004_t015_billing.sql` (the thirteenth, `client_usage` — task 015-03,
 * added as a SEPARATE file rather than an edit to 002, which is already live on the dev VM) by
 * `packages/core/test/pg-store-parity.test.ts`, so a fourteenth table added to either migration and
 * not to this list fails a test instead of silently escaping the guard.
 */
export const STATE_TABLES = [
  'providers',
  'cache_entries',
  'usage',
  'usage_window',
  'users',
  'access_profiles',
  'api_tokens',
  'access_audit',
  'provider_buckets',
  'request_trace',
  'diagnostics',
  'retention_runs',
  'client_usage',
] as const;

/**
 * Runtime schema-qualification gate (R-30.1, AC-46) — the write-side counterpart of
 * `read-client.ts`'s `SELECT_ONLY_RE`, and defense in depth beside the offline gate of
 * `deployment.md` §10.2.1 item 1.
 *
 * **Why a runtime check when a static one is planned.** `search_path` is not a correctness
 * condition on this installation and cannot be made one: Supavisor owns port 5432 on the shipped
 * Supabase deployment and answers with its own `cvj, public, extensions`, discarding the
 * `-c search_path=onchain` this module still sends (WI-47, `data-model.md` §884). An unqualified
 * `usage` would therefore not fail — it would resolve somewhere else, or be created somewhere else,
 * and the budget ledger would silently be a different table than the one the migration granted.
 *
 * The lookbehind is what makes `onchain.usage` pass and a bare `usage` fail. `usage_window` does not
 * trip the `usage` alternative because `_` is a word character, so `\busage\b` does not match inside
 * it.
 */
const UNQUALIFIED_TABLE_RE = new RegExp(`(?<!onchain\\.)\\b(?:${STATE_TABLES.join('|')})\\b`, 'i');

/**
 * The server process is not the schema's writer (`data-model.md` §4.4 item 2, `system-architecture.md`
 * §3.4.8: "`PgBudgetStore` upserts the twelve `providers` rows at construction and runs **no DDL**").
 * The numbered migration file is. This refuses the whole class at the client, so the postcondition
 * is a property of the module rather than of every future call site remembering it.
 *
 * `GRANT`/`REVOKE` are included for the same reason: a process that can widen its own grants has
 * no grant boundary. `GRANT USAGE ON SCHEMA …` is refused twice over — by this expression and by
 * the unqualified-table one — which is the correct answer either way.
 */
const NO_DDL_RE = /^\s*(?:create|drop|alter|truncate|grant|revoke|comment|reindex|vacuum)\b/i;

/**
 * Conservative pool sizing, both numbers stated with what they are and are not derived from.
 *
 * `DEFAULT_MAX_POOL_SIZE` — applied **10**, measured: none. The gate this pool serves serializes on
 * one row per provider (`system-architecture.md` §3.4.8, "the conditional upsert takes the row lock
 * it needs"), so connections beyond the first buy nothing on the contended path; what they serve is
 * the uncontended traffic beside it — cache reads of concurrent sessions. It is deliberately larger
 * than the read client's 3, because that client backs ONE optional adapter while this one backs
 * every request the process answers, and deliberately far below a shared Postgres server's own
 * `max_connections`, which this process does not own.
 *
 * `DEFAULT_CONNECTION_TIMEOUT_MS` — the same 10 000 ms and the same reason as the read client: a
 * dead or unreachable DSN must fail fast rather than hang the single-threaded server.
 */
const DEFAULT_MAX_POOL_SIZE = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The SERVER-side bound on one statement. Postgres cancels the statement and the pooled connection
 * returns to the pool — the half the in-process bound below cannot do, since a client that stops
 * waiting does not stop the server from working.
 *
 * Applied **5 000 ms**, the same value the read client uses. Measured: none for these statements —
 * every one of them is a primary-key equality upsert or read against tables whose row count is
 * bounded by providers times buckets (`data-model.md` §4.5.6, "under 500 rows permanently" for the
 * limiter; `usage` is one row per provider per day). What the bound must never do is fire on a
 * healthy statement; what it must do is stop one connection of ten being held indefinitely.
 *
 * **It bounds a statement, not a transaction.** A transaction here is two or three of these, so the
 * worst case a caller can wait is that multiple — which is why the in-process bound below is not
 * derived from this one alone.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The IN-PROCESS bound on one statement, top to bottom.
 *
 * **Why it exists beside the server bound.** `statement_timeout` is enforced BY Postgres, so it
 * needs a server that is still listening. The failure it cannot cover is the other one: a server or
 * network that goes silent AFTER the connection is established. `connectionTimeoutMillis` has been
 * spent by then, no statement timeout will ever be reported, and `await client.query(...)` waits
 * forever — in a single-threaded MCP server, which is why the whole process, not one capability, is
 * what hangs.
 *
 * **The number is a sum, not a preference** — the rule `read-client.ts` states and this module
 * inherits: it must exceed 10 000 + 5 000, or the two inner bounds become unreachable and this one
 * absorbs both, trading two diagnosable failures (a dead DSN, a slow statement) for one that says
 * only "it did not answer". Applied **20 000 ms**.
 */
const DEFAULT_QUERY_TOTAL_TIMEOUT_MS = 20_000;

/**
 * Thrown when the in-process bound fires — a DISTINCT class from the "database unavailable"
 * rethrow, for the reason `read-client.ts` keeps its own three apart: "the database answered with
 * an error", "the database did not answer at all" and "we stopped waiting" are different facts
 * about an installation and an operator acts on them differently.
 *
 * DSN-free by construction: the message interpolates the bound and nothing else.
 */
export class PgStateQueryTimeoutError extends Error {
  constructor(public readonly boundMs: number) {
    super(`pg/state-client: statement exceeded the ${boundMs}ms in-process bound`);
    this.name = 'PgStateQueryTimeoutError';
  }
}

/** A SQLSTATE is five characters from `[0-9A-Z]` (Postgres Appendix A); severity is `ERROR`,
 * `FATAL`, `PANIC` or one of the non-error levels. Both are VALIDATED rather than trusted because
 * both are server-controlled strings on their way into a caller-visible message. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const SEVERITY_RE = /^[A-Z]{3,7}$/;

/**
 * Thrown when the far end spoke Postgres back at us and the answer was an error (the WI-47
 * distinction, applied to the write path).
 *
 * **The fact it carries is "reachable".** A `23503` foreign-key violation from a `usage` write
 * whose `providers` row is missing, and an unreachable host, are the same message under a single
 * "database unavailable" — and they send an operator to opposite places. The server's own message
 * text is never surfaced: it demonstrably carries DSN fragments (`password authentication failed
 * for user "<the DSN's username>"`). Only the validated SQLSTATE and severity are interpolated.
 */
export class PgStateServerRejectedError extends Error {
  public readonly sqlstate: string;
  public readonly severity: string | undefined;

  constructor(sqlstate: string, severity?: string, options?: ErrorOptions) {
    const safeState = SQLSTATE_RE.test(sqlstate) ? sqlstate : 'unknown';
    const safeSeverity =
      severity !== undefined && SEVERITY_RE.test(severity) ? severity : undefined;
    super(
      `pg/state-client: database reachable, request rejected (SQLSTATE ${safeState}${
        safeSeverity === undefined ? '' : `, ${safeSeverity}`
      })`,
      options,
    );
    this.name = 'PgStateServerRejectedError';
    this.sqlstate = safeState;
    this.severity = safeSeverity;
  }
}

/**
 * Duck-typed "did this come from a Postgres ErrorResponse?" — structural because `PgStatePoolLike`
 * is structural: `instanceof pg.DatabaseError` would be unassertable by any fake pool, which is the
 * whole reason this module is testable without a database (R-21).
 *
 * Both fields are required, which is a measurement rather than caution (recorded in
 * `read-client.ts`): `code` alone is not a discriminator, because Node's own `EPIPE` — a socket
 * dying mid-write, i.e. precisely a NOT-reachable failure — is also five uppercase characters.
 */
function serverErrorFields(error: unknown): { sqlstate: string; severity?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  if (typeof code !== 'string' || !SQLSTATE_RE.test(code)) return undefined;
  if (typeof severity !== 'string' || severity.length === 0) return undefined;
  return { sqlstate: code, severity };
}

/** The message a caller (and, transitively, an MCP client) sees when a statement fails and NOTHING
 * answered. The real error — which may embed the DSN's host/port/user — goes to stderr only. */
const SANITIZED_FAILURE_MESSAGE = 'pg/state-client: database unavailable';

/**
 * Detail for the STDERR line only — never for a caller. It unwraps `AggregateError` because that is
 * the shape the most ordinary failure takes: a dead port arrives as an `AggregateError` whose own
 * `message` is the EMPTY STRING, with `ECONNREFUSED` hidden in `.errors`. A diagnostic that logs a
 * line ending in a colon is not a diagnostic.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [];
  if (error.message.length > 0) parts.push(error.message);
  const { code, errors } = error as Error & { code?: unknown; errors?: unknown };
  if (typeof code === 'string' && code.length > 0) parts.push(`code=${code}`);
  if (Array.isArray(errors) && errors.length > 0) {
    parts.push(`aggregated: [${errors.map((inner) => errorMessage(inner)).join('; ')}]`);
  }
  return parts.length > 0 ? parts.join(' ') : `${error.name} (no detail)`;
}

/**
 * `promise` with an upper bound on how long THIS process waits for it.
 *
 * It does not cancel the statement — nothing in the `pg` wire protocol lets a client take back one
 * it already sent, which is exactly why `statement_timeout` is set as well: the server stops the
 * work, this stops the waiting.
 *
 * **No extra `.catch` on `promise`, and that is checked rather than assumed:** `Promise.race`
 * attaches its own handlers to every input, so a statement that rejects AFTER this bound settled
 * the race is handled, not unhandled — which matters more than it reads, since an unhandled
 * rejection ends the process on Node's default `--unhandled-rejections=throw`, and the consumer is
 * a long-lived server.
 */
function withQueryBound<T>(promise: Promise<T>, boundMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PgStateQueryTimeoutError(boundMs)), boundMs);
    // A pending bound must never be the reason the process stays alive.
    timer.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Lazy, WRITE-CAPABLE Postgres client for the engine's own state (`system-architecture.md` §3.4.8,
 * `deployment.md` §10.5.1). The SECOND client of this package, and second on purpose.
 *
 * **Why a second client and not a widened one.** Both clients address schema `onchain`, and the read
 * client must stay UNABLE to write to it: `pg/read-client.ts:63` declares
 * `const SELECT_ONLY_RE = /^\s*select\b/i;` and enforces it on every call. Widening that module
 * would delete the guarantee rather than extend it. Two clients means two DSNs
 * (`ONCHAIN_PG_URL` read-only, `ONCHAIN_STATE_PG_URL` read-write) and two roles, and the two roles
 * hold different table grants — the read role may not read `onchain.api_tokens`, and the state role
 * may not read the snapshotter's `onchain.snapshots` (`deployment.md` §10.5.1).
 *
 * **What is duplicated from `read-client.ts`, and why deliberately.** The sanitize-and-rethrow
 * discipline, the two typed failure classes and the in-process bound are re-implemented here rather
 * than shared. Sharing them would mean exporting that module's internals, which turns one
 * SELECT-only module into one module with two capabilities — the exact property the split exists to
 * preserve. The duplication is ~60 lines and is inert; the guarantee it protects is not.
 *
 * **Two guards, both refusing before the statement leaves the process:** `NO_DDL_RE` (the server
 * process never writes schema) and `UNQUALIFIED_TABLE_RE` (R-30.1 — every object name carries its
 * schema, because `search_path` is not a correctness condition on a pooled installation).
 */
export function createStateClient(deps: StateClientDeps = {}): StateClient {
  const env = deps.env ?? process.env;
  // Cast at the DI boundary only: the real `pg.Pool` constructor's `PoolConfig` is broader than the
  // narrow shape this module ever passes it. Same narrowing `read-client.ts` documents.
  const PoolCtor = deps.PoolCtor ?? (Pool as unknown as PgStatePoolCtor);
  const queryTimeoutMs = deps.queryTimeoutMs ?? DEFAULT_QUERY_TOTAL_TIMEOUT_MS;
  let pool: PgStatePoolLike | undefined;

  function dsn(): string | undefined {
    return env['ONCHAIN_STATE_PG_URL'];
  }

  /** Both guards, applied to every statement this module sends — including the ones issued inside a
   * transaction, which is why they live here and not in `query()` alone. */
  function assertSendable(sql: string): void {
    if (NO_DDL_RE.test(sql)) {
      throw new Error(
        'pg/state-client: the server process issues no DDL or DCL — schema is written by the numbered migration alone (data-model.md §4.4)',
      );
    }
    if (UNQUALIFIED_TABLE_RE.test(sql)) {
      throw new Error(
        'pg/state-client: every object name must be schema-qualified as onchain.<name> (R-30.1)',
      );
    }
  }

  function ensurePool(): PgStatePoolLike {
    if (pool) return pool;
    const connectionString = dsn();
    if (!connectionString) {
      throw new Error('pg/state-client: needs ONCHAIN_STATE_PG_URL');
    }
    try {
      pool = new PoolCtor({
        connectionString,
        // Convenience, NOT a correctness dependency: a pooler is free to replace it (WI-47), which
        // is precisely why `UNQUALIFIED_TABLE_RE` exists. Kept because it is correct on a direct
        // connection and makes an interactive `psql` against the same DSN behave the same way.
        options: '-c search_path=onchain',
        connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
        max: DEFAULT_MAX_POOL_SIZE,
        statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      });
    } catch (error) {
      // A synchronous constructor throw (e.g. `pg` rejecting a malformed connection string) may
      // itself embed DSN fragments in its message — the same leak the query path closes.
      process.stderr.write(
        `pg/state-client: pool construction failed (full detail on stderr only, never surfaced to the caller): ${errorMessage(error)}\n`,
      );
      throw new Error(SANITIZED_FAILURE_MESSAGE, { cause: error });
    }
    pool.on?.('error', (err: Error) => {
      // An idle connection erroring out is a `pg.Pool`-documented event fired independently of any
      // in-flight statement. Without this listener Node treats an unhandled `'error'` on an
      // `EventEmitter` as an uncaught exception and CRASHES THE PROCESS.
      process.stderr.write(
        `pg/state-client: idle pool error (connection details never logged): ${errorMessage(err)}\n`,
      );
    });
    return pool;
  }

  /**
   * One statement against an already-chosen executor (the pool for autocommit, a checked-out
   * connection inside a transaction), bounded and sanitized identically on both paths.
   *
   * OUR OWN typed refusal passes through unflattened — the WI-36 rule, one transport over: a catch
   * that re-messages by default hides the class inside `.cause`, where `instanceof` cannot see it.
   * Sanitize what came from OUTSIDE, never what this module itself constructed.
   */
  async function run<T>(
    executor: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    try {
      const result = await withQueryBound(executor.query(sql, params), queryTimeoutMs);
      return result.rows as T[];
    } catch (error) {
      if (error instanceof PgStateQueryTimeoutError) throw error;
      process.stderr.write(
        `pg/state-client: statement failed (full detail on stderr only, never surfaced to the caller): ${errorMessage(error)}\n`,
      );
      const fields = serverErrorFields(error);
      if (fields) {
        throw new PgStateServerRejectedError(fields.sqlstate, fields.severity, { cause: error });
      }
      throw new Error(SANITIZED_FAILURE_MESSAGE, { cause: error });
    }
  }

  return {
    isAvailable: () => (dsn() ? { ok: true } : { ok: false, reason: 'needs ONCHAIN_STATE_PG_URL' }),

    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      assertSendable(sql);
      return run<T>(ensurePool(), sql, params);
    },

    transaction: async <T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T> => {
      const acquired = ensurePool();
      let connection: PgStateConnectionLike;
      try {
        // `connectionTimeoutMillis` (10 000) normally settles this long before the 20 000 ms bound,
        // so the bound here covers only the residue: a pool that ignores its own configuration, or
        // one that never settles at all. That residue is the reason it is still applied — an
        // unbounded await in a single-threaded server hangs the whole process, not one call.
        connection = await withQueryBound(acquired.connect(), queryTimeoutMs);
      } catch (error) {
        if (error instanceof PgStateQueryTimeoutError) throw error;
        process.stderr.write(
          `pg/state-client: could not check out a connection (full detail on stderr only): ${errorMessage(error)}\n`,
        );
        throw new Error(SANITIZED_FAILURE_MESSAGE, { cause: error });
      }
      try {
        await run(connection, 'BEGIN', []);
        const result = await fn({
          query: async <T2>(sql: string, params: unknown[] = []): Promise<T2[]> => {
            assertSendable(sql);
            return run<T2>(connection, sql, params);
          },
        });
        await run(connection, 'COMMIT', []);
        return result;
      } catch (error) {
        try {
          await run(connection, 'ROLLBACK', []);
        } catch {
          // Swallowed on purpose: a rollback failure on an already-broken connection must never
          // mask the ORIGINAL error being rethrown below — and the connection is discarded anyway.
        }
        throw error;
      } finally {
        // Every path releases, including the one where `fn` threw a control-flow refusal. A leaked
        // connection is a pool of ten that becomes a pool of nine, permanently and invisibly.
        connection.release();
      }
    },
  };
}
