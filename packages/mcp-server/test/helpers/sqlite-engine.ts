import Database from 'better-sqlite3';
import { createSqliteStateClient } from '@onchain-intel/core';
import { createEngineStore, type EngineStore } from '../../src/engine/pg-engine-store.js';

/**
 * The engine's own statements, run against a real engine, with no Postgres anywhere.
 *
 * **The dialect translation is the SHIPPED one.** This helper used to carry its own copy of the
 * three substitutions of `data-model.md` §4.2.4; it now builds the production
 * `createSqliteStateClient` over an in-memory database, so what these suites exercise is the client
 * the `network-sqlite` profile runs. A second copy would have agreed with the first exactly until
 * one of them was edited — and the edited one would have been the production copy, tested by
 * nothing.
 *
 * **What it cannot show, said rather than assumed.** It does not observe a row lock, and it cannot
 * tell `GREATEST` from `MAX` because the translation maps one to the other. What it does show is
 * that the statements parse, bind, and produce the rows and the refusals they claim — against the
 * same column declarations, the same `CHECK`s and the same append-only triggers the shipped SQLite
 * axis carries.
 */

export interface SqliteEngine {
  readonly engine: EngineStore;
  /** The underlying database, for assertions a repository has no method for. */
  readonly db: Database.Database;
  /** Every statement the stores issued, in order — the input of the SQL-shape assertions. */
  readonly statements: { readonly text: string; readonly values: readonly unknown[] }[];
  close(): void;
}

export function createSqliteEngine(): SqliteEngine {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  let opened: Database.Database | undefined;

  /**
   * A constructor that captures the instance and records what runs.
   *
   * The recording sits on `prepare` rather than around the client, because the assertions are about
   * the statement text the STORES emit — before translation — and that is what reaches the client's
   * own `query`. The wrapper below therefore records the translated text; the shape assertions read
   * `statements`, which the engine store fills with the untranslated one.
   */
  const DatabaseCtor = function (path: string, options?: { timeout?: number }): Database.Database {
    opened = new Database(path, options);
    return opened;
  } as unknown as new (path: string, options?: { timeout?: number }) => Database.Database;

  const client = createSqliteStateClient({ path: ':memory:', DatabaseCtor });
  const recording = {
    isAvailable: () => client.isAvailable(),
    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      statements.push({ text: sql, values: params ?? [] });
      return client.query<T>(sql, params);
    },
    transaction: <T>(fn: Parameters<typeof client.transaction<T>>[0]): Promise<T> =>
      client.transaction<T>((tx) =>
        fn({
          query<T2>(sql: string, params?: unknown[]): Promise<T2[]> {
            statements.push({ text: sql, values: params ?? [] });
            return tx.query<T2>(sql, params);
          },
        }),
      ),
  };

  // Opens the file and applies `CACHE_DDL` — the same call the profile makes at start.
  const available = recording.isAvailable();
  if (!available.ok) throw new Error(available.reason);

  return {
    engine: createEngineStore(recording),
    get db(): Database.Database {
      if (opened === undefined) throw new Error('the database was never opened');
      return opened;
    },
    statements,
    close: () => opened?.close(),
  };
}

/** The seed profile both migrations write — `data-model.md` §4.5.3's literal ULID. */
export const PHASE_0_PROFILE_ID = '01JPHASE00000000000000000A';
