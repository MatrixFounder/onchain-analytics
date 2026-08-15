import Database from 'better-sqlite3';
import { cacheDbPath, resolveDataDir } from '../cache/data-dir.js';
import { CACHE_DDL } from '../cache/ddl.js';
import { STATE_TABLES, type StateClient, type StateTransaction } from '../pg/state-client.js';

/**
 * The engine's own state on the SQLite axis — the second implementation of `StateClient`.
 *
 * **Why it exists.** `security.md` §7.5.4 says the `network-sqlite` profile authenticates every
 * request exactly as `network` does, against the SQLite tables, and calls it "not an authentication
 * exception" because a debugging combination that skipped the token would be the one configuration
 * whose refusal path never runs. Task 014-36 declared the tables in `CACHE_DDL` and task 014-07 wrote
 * the repositories against `StateClient` — what was missing between them was this adapter, and until
 * it existed `network-sqlite` could only refuse to start.
 *
 * **Why the callers do not change.** They emit ONE statement text, schema-qualified and in the
 * Postgres dialect, and this module reverses the three substitutions `data-model.md` §4.2.4 declares
 * — `onchain.` qualification, `GREATEST` for `MAX`, and (a binding detail rather than a dialect one)
 * `$n` for a named parameter. So what runs here is the SHIPPED statement: its `ON CONFLICT` target,
 * its `RETURNING`, its join, its `WHERE`.
 *
 * **Why the guards run BEFORE the translation.** The incoming SQL is checked for DDL and for an
 * unqualified table name exactly as the Postgres client checks it, and only then rewritten. Both axes
 * therefore accept the same statements: a repository that forgot its schema qualifier fails here too,
 * rather than passing on the axis that has no schemas and failing on the one that does — which is the
 * shape where an engine move stops being mechanical.
 */

/** The three declared substitutions of §4.2.4, applied backwards, plus `$n` → `@pn`. */
export function toSqliteDialect(sql: string): string {
  return sql
    .replace(/\bonchain\./g, '')
    .replace(/\bGREATEST\s*\(/gi, 'MAX(')
    .replace(/\$(\d+)/g, '@p$1');
}

const UNQUALIFIED_TABLE_RE = new RegExp(`(?<!onchain\\.)\\b(?:${STATE_TABLES.join('|')})\\b`, 'i');

const NO_DDL_RE = /^\s*(?:create|drop|alter|truncate|grant|revoke|comment|reindex|vacuum)\b/i;

/** The constructor shape this module calls `new` on — the real `better-sqlite3` in production. */
export type SqliteCtor = new (
  path: string,
  options?: { readonly timeout?: number },
) => Database.Database;

export interface SqliteStateClientDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the file. `':memory:'` in tests; production resolves `DATA_DIR/cache.sqlite3`. */
  readonly path?: string;
  readonly DatabaseCtor?: SqliteCtor;
}

/**
 * How long a write waits for another connection's lock before giving up.
 *
 * The same 5 000 ms `SqliteBudgetStore` applies, and for the same reason: this process already holds
 * two other connections to this file (the cache store and the budget store), so a write here can
 * meet a writer rather than an idle database. The driver's own default is zero, which turns ordinary
 * contention into an immediate `SQLITE_BUSY`.
 */
const BUSY_TIMEOUT_MS = 5_000;

export function createSqliteStateClient(deps: SqliteStateClientDeps = {}): StateClient {
  const DatabaseCtor = deps.DatabaseCtor ?? (Database as unknown as SqliteCtor);
  // The SAME file the cache store opens (`data-model.md` §4.5: `network-sqlite` keeps its four
  // counter tables in `DATA_DIR/cache.sqlite3`), resolved through the same helper so a `DATA_DIR`
  // override moves both.
  const file = deps.path ?? cacheDbPath(resolveDataDir(deps.env ?? process.env));
  let db: Database.Database | undefined;
  let failure: string | undefined;

  /**
   * One transaction at a time.
   *
   * **Why a lock and not a pool.** `better-sqlite3` is synchronous over ONE connection, so there is
   * nothing to check out; two overlapping `transaction()` calls would issue a second `BEGIN` inside
   * the first, which SQLite refuses — and the failure would arrive as a puzzle at whichever caller
   * happened to be second. The Postgres client has no such problem because it checks a connection
   * out of a pool per transaction; the difference is a property of the driver, not of the design, so
   * it is handled here rather than pushed to the callers.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function open(): Database.Database {
    if (db) return db;
    const opened = new DatabaseCtor(file, { timeout: BUSY_TIMEOUT_MS });
    opened.pragma('journal_mode = WAL');
    // SQLite does not check `REFERENCES` by default, and DB-SCHEMA §1.6 makes the Repository
    // responsible for the pragma on EVERY connection. `api_tokens.user_id` and
    // `access_audit.actor_user_id` are the references the identity repositories rely on.
    //
    // **Measured: `better-sqlite3` already opens with it ON**, so this line is not what makes the
    // constraint hold today — a mutation removing it failed nothing. It is kept because the canon
    // assigns the guarantee to this module rather than to a driver default, and a default is exactly
    // the kind of thing a minor release changes. The state is ASSERTED in the test rather than
    // inferred from this call, so the invariant is measured whoever set it.
    opened.pragma('foreign_keys = ON');
    // Idempotent, and the declaration is the SAME string the cache store applies. Applied here too
    // because this client must not depend on which store happened to open the file first.
    opened.exec(CACHE_DDL);
    db = opened;
    return opened;
  }

  function assertSendable(sql: string): void {
    if (NO_DDL_RE.test(sql)) {
      throw new Error(
        'sqlite/state-client: the server process issues no DDL — the tables come from CACHE_DDL at open (data-model.md §4.4)',
      );
    }
    if (UNQUALIFIED_TABLE_RE.test(sql)) {
      throw new Error(
        'sqlite/state-client: every object name must be schema-qualified as onchain.<name> (R-30.1), even on the axis that has no schemas',
      );
    }
  }

  function run<T>(database: Database.Database, sql: string, params: readonly unknown[]): T[] {
    assertSendable(sql);
    const statement = database.prepare(toSqliteDialect(sql));
    const bound =
      params.length === 0
        ? undefined
        : Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
    if (!statement.reader) {
      if (bound === undefined) statement.run();
      else statement.run(bound as never);
      return [];
    }
    return (bound === undefined ? statement.all() : statement.all(bound as never)) as T[];
  }

  return {
    isAvailable(): { ok: true } | { ok: false; reason: string } {
      try {
        open();
        return { ok: true };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // The path is named and the reason is the driver's; neither is a secret, and an operator
        // debugging `network-sqlite` needs both.
        return { ok: false, reason: `sqlite/state-client: cannot open ${file}: ${failure}` };
      }
    },

    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      try {
        return Promise.resolve(run<T>(open(), sql, params ?? []));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T> {
      const next = queue.then(async () => {
        const database = open();
        database.exec('BEGIN');
        try {
          const result = await fn({
            query<T2>(sql: string, params?: unknown[]): Promise<T2[]> {
              try {
                return Promise.resolve(run<T2>(database, sql, params ?? []));
              } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error(String(error)));
              }
            },
          });
          database.exec('COMMIT');
          return result;
        } catch (error) {
          // A throw is the only way out that rolls back, and callers use it deliberately — the same
          // contract `StateClient.transaction` states for the Postgres axis.
          database.exec('ROLLBACK');
          throw error;
        }
      });
      // The queue must survive a rejection, or one failed transaction would wedge every later one.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
