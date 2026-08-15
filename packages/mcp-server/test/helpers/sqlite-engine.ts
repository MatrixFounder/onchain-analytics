import Database from 'better-sqlite3';
import { CACHE_DDL } from '@onchain-intel/core';
import { createEngineStore, type EngineStore } from '../../src/engine/pg-engine-store.js';
import type { StateClient, StateTransaction } from '@onchain-intel/core';

/**
 * The engine's own statements, run against a real engine, with no Postgres anywhere.
 *
 * **How.** `data-model.md` §4.2.4 declares that the two dialects differ by exactly three
 * substitutions — `MAX(x, y)` ↔ `GREATEST(x, y)`, `INTEGER` ↔ `BIGINT`, and schema qualification —
 * and that "the keys, the columns and the arithmetic are identical". `toSqliteDialect` reverses them
 * and runs the resulting statement on an in-memory `better-sqlite3` over `CACHE_DDL`, which is the
 * SQLite declaration of the same twelve tables (task 014-36). So what runs here is the SHIPPED
 * statement text: its `ON CONFLICT` target, its `RETURNING`, its join, its `WHERE`.
 *
 * `packages/core/test/pg-store-parity.test.ts` built the same harness for the three core stores;
 * this is its sibling for the identity repositories, which live in this package because
 * `security.md` §7.5.1 keeps identity beside the transport.
 *
 * **What it cannot show, said rather than assumed.** It does not observe a row lock, it cannot tell
 * `GREATEST` from `MAX` (the translation maps one to the other), and it runs SQLite's constraint
 * engine rather than Postgres's. What it does show is that the statements parse, bind, and produce
 * the rows and the refusals they claim — against the same column declarations, the same `CHECK`s and
 * the same append-only triggers the shipped SQLite axis carries.
 */

/** The three declared substitutions of §4.2.4 applied backwards, plus `$n` → `@pn`. */
export function toSqliteDialect(sql: string): string {
  return sql
    .replace(/\bonchain\./g, '')
    .replace(/\bGREATEST\s*\(/gi, 'MAX(')
    .replace(/\$(\d+)/g, '@p$1');
}

export interface SqliteEngine {
  readonly engine: EngineStore;
  readonly db: Database.Database;
  /** Every statement the stores issued, in order — the input of the SQL-shape assertions. */
  readonly statements: { readonly text: string; readonly values: readonly unknown[] }[];
  close(): void;
}

/**
 * An in-memory SQLite database wearing the write client's interface.
 *
 * `PRAGMA foreign_keys = ON` is not decoration: SQLite does not check `REFERENCES` by default
 * (DB-SCHEMA §1.6), and `api_tokens.user_id` and `access_audit.actor_user_id` are the two references
 * this task's statements rely on. Without the pragma a token could be issued to a person who does
 * not exist and every test here would still pass.
 */
export function createSqliteEngine(): SqliteEngine {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(CACHE_DDL);

  const statements: { text: string; values: readonly unknown[] }[] = [];

  const run = (sql: string, params: readonly unknown[] = []): unknown[] => {
    statements.push({ text: sql, values: params });
    const statement = db.prepare(toSqliteDialect(sql));
    const bound =
      params.length === 0
        ? undefined
        : Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
    if (!statement.reader) {
      if (bound === undefined) statement.run();
      else statement.run(bound as never);
      return [];
    }
    return bound === undefined ? statement.all() : statement.all(bound as never);
  };

  const client: StateClient = {
    isAvailable: () => ({ ok: true }),
    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return Promise.resolve(run(sql, params ?? []) as T[]);
    },
    async transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T> {
      // Real BEGIN/COMMIT/ROLLBACK rather than better-sqlite3's `db.transaction()` wrapper: the
      // wrapper refuses an async callback, and the whole point of the case this serves — revoke's
      // update and its journal row — is that a throw between the two statements rolls the first one
      // back.
      db.exec('BEGIN');
      try {
        const result = await fn({
          query<T2>(sql: string, params?: unknown[]): Promise<T2[]> {
            return Promise.resolve(run(sql, params ?? []) as T2[]);
          },
        });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return {
    engine: createEngineStore(client),
    db,
    statements,
    close: () => db.close(),
  };
}

/** The seed profile both migrations write — `data-model.md` §4.5.3's literal ULID. */
export const PHASE_0_PROFILE_ID = '01JPHASE00000000000000000A';
