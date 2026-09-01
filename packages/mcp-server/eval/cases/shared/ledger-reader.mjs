// Reading the engine's own state from a live eval run (task 015-29).
//
// WHY THE EVAL READS THE STORE AND NOT A TOOL. There is no tool that lists ledger rows, and there
// will not be one by design: a tool that reads `client_usage` is a tool that reports on what the
// caller was charged for calling it (`src/tools/registry.ts`). The billing claims of AC-28 are
// therefore assertions about the STORE, and the case has to open it.
//
// WHY THE READER FOLLOWS THE AXIS AND NOT A FILENAME. On the `network` profile BOTH the cache and
// the budget live in Postgres (`packages/core/src/pg/stores.ts`), and `DATA_DIR/cache.sqlite3` is
// never created. A reader hard-wired to that path returns zero rows there and the case then asserts
// against its own zero — passing by reading nothing. `storage` comes from the runner
// (`eval/profiles.mjs`), so the reader follows the profile that was actually raised.
//
// WHY ONE QUERY FOR BOTH AXES. The same substitution the state client makes
// (`packages/core/src/sqlite/state-client.ts` — `toSqliteDialect`): the table is qualified
// `onchain.` on Postgres and bare on SQLite. Two hand-written queries would be two places for one
// rule, and the copy is the one that drifts.
//
// This directory is not scanned by the case loader, so nothing here is mistaken for a case.

import path from 'node:path';
import { existsSync } from 'node:fs';

/** `onchain.` on the Postgres axis, nothing on SQLite — mirrors `toSqliteDialect`. */
const qualify = (storage, table) => (storage === 'postgres' ? `onchain.${table}` : table);

/**
 * Runs one read-only query on whichever store the phase raised.
 *
 * @param storage  `'postgres' | 'sqlite'` — the axis, from the case context.
 * @param location DSN for Postgres, or the `DATA_DIR` for SQLite.
 * @param sql      a query already qualified for the axis by {@link qualify}.
 * @param params   positional parameters, `$1…` on Postgres and `?` on SQLite.
 */
async function query(storage, location, sql, params = []) {
  if (storage === 'postgres') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: location });
    await client.connect();
    try {
      const { rows } = await client.query(sql, params);
      return rows;
    } finally {
      await client.end();
    }
  }
  const file = path.join(location, 'cache.sqlite3');
  // A missing file is not "no rows": it means the phase wrote its state somewhere else, which is
  // the exact confusion this reader exists to prevent. Say so instead of returning `[]`.
  if (!existsSync(file)) {
    throw new Error(`no SQLite store at ${file} — the phase wrote its state elsewhere`);
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** `client_usage` rows of this run, newest first. */
export async function readClientUsage(storage, location, { limit = 50 } = {}) {
  const table = qualify(storage, 'client_usage');
  return await query(
    storage,
    location,
    `SELECT id, principal_id, access_profile_id, client_request_id, tool, capability,
            price_raw, state, refund_reason, reserved_at, terminal_at
       FROM ${table}
      ORDER BY reserved_at DESC
      LIMIT ${String(Number(limit))}`,
  );
}

/** `request_trace` rows of this run, newest first. */
export async function readRequestTrace(storage, location, { limit = 50 } = {}) {
  const table = qualify(storage, 'request_trace');
  return await query(
    storage,
    location,
    `SELECT id, principal_id, client_request_id, tool, capability, outcome, refusal_class,
            served_from, received_at
       FROM ${table}
      ORDER BY received_at DESC
      LIMIT ${String(Number(limit))}`,
  );
}

/** `usage` rows — the per-provider daily counters the call gate reads. */
export async function readUsage(storage, location) {
  const table = qualify(storage, 'usage');
  return await query(
    storage,
    location,
    `SELECT provider, day, credits_used, calls_made FROM ${table} ORDER BY provider`,
  );
}

/**
 * The store a case should read for the phase it is in.
 *
 * The HTTP phase reads its own axis; the capability phase is always SQLite under `local`
 * (`src/profile.ts`), so its location is always a directory.
 */
export const httpStore = (ctx) => ({
  storage: ctx.storage,
  // `ctx.stateDsn`, never `process.env`. The runner declares the target ONCE and hands the same
  // value to the server, to both `admin()` calls and to here; a case that reached for the
  // environment could read a different database than the one the run wrote to, and the artifact
  // would not say so.
  location: ctx.storage === 'postgres' ? (ctx.stateDsn ?? '') : ctx.dataDir,
});

export const stdioStore = (ctx) => ({ storage: 'sqlite', location: ctx.stdioDataDir });
