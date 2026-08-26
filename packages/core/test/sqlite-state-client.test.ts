import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSqliteStateClient, toSqliteDialect } from '../src/sqlite/state-client.js';
import { STATE_TABLES } from '../src/pg/state-client.js';

/**
 * The SQLite axis of the engine's own state — the second `StateClient`.
 *
 * **What it is for.** `security.md` §7.5.4 makes `network-sqlite` authenticate every request exactly
 * as `network` does, against the SQLite tables, and calls it "not an authentication exception": a
 * debugging combination that skipped the token would be the one configuration whose refusal path
 * never runs. The identity repositories are written once, against `StateClient`; this is the adapter
 * that lets them run where there are no schemas.
 */

const client = (): ReturnType<typeof createSqliteStateClient> =>
  createSqliteStateClient({ path: ':memory:' });

describe('the dialect translation is the three substitutions of §4.2.4, reversed', () => {
  it('strips the schema, maps GREATEST to MAX, and renames the parameters', () => {
    expect(toSqliteDialect('SELECT * FROM onchain.api_tokens WHERE token_hash = $1')).toBe(
      'SELECT * FROM api_tokens WHERE token_hash = @p1',
    );
    expect(toSqliteDialect('SELECT GREATEST(a, b)')).toBe('SELECT MAX(a, b)');
  });

  it('renames a parameter named twice to the SAME name, which `?` could not do', () => {
    // SQLite's anonymous `?` binds by order of APPEARANCE, so a statement naming `$2` twice would
    // silently take two different values — and the canonical reservation names three parameters
    // more than once.
    expect(toSqliteDialect('INSERT INTO onchain.usage VALUES ($1, $2, $2)')).toBe(
      'INSERT INTO usage VALUES (@p1, @p2, @p2)',
    );
  });
});

describe('the guards run before the translation, so both axes accept the same statements', () => {
  it('refuses an unqualified table name — on the axis that has no schemas', async () => {
    // The point of checking here too: a repository that forgot its qualifier would pass on SQLite
    // and fail on Postgres, and an engine move would stop being mechanical. It fails on both.
    await expect(client().query('SELECT id FROM api_tokens')).rejects.toThrow(/schema-qualified/);
    await expect(client().query('SELECT id FROM onchain.api_tokens')).resolves.toStrictEqual([]);
  });

  it('refuses DDL and DCL', async () => {
    for (const statement of [
      'CREATE TABLE onchain.x (id TEXT)',
      'DROP TABLE onchain.api_tokens',
      'ALTER TABLE onchain.users ADD COLUMN x TEXT',
      'GRANT SELECT ON onchain.users TO someone',
    ]) {
      await expect(client().query(statement), statement).rejects.toThrow(/no DDL/);
    }
  });

  it('names every state table in the guard', () => {
    // TC-UNIT-10 (task 015-03): thirteen names since migration 004 added client_usage.
    expect(STATE_TABLES.length).toBe(13);
    expect(STATE_TABLES).toContain('client_usage');
  });

  it('TC-UNIT-12: the guard sees the new name — an unqualified client_usage is refused, a qualified one resolves', async () => {
    // Falls if 'client_usage' is removed from STATE_TABLES: the regex it feeds would stop matching
    // the bare name and this statement would run unqualified, exactly the WI-47 class of defect.
    await expect(
      client().query('SELECT price_raw FROM client_usage WHERE id = $1', ['x']),
    ).rejects.toThrow(/schema-qualified/);
    await expect(
      client().query('SELECT price_raw FROM onchain.client_usage WHERE id = $1', ['x']),
    ).resolves.toStrictEqual([]);
  });
});

describe('the tables exist, with the constraints CACHE_DDL declares', () => {
  it('applies the declaration at open, so the client does not depend on who opened first', async () => {
    const state = client();
    expect(state.isAvailable()).toStrictEqual({ ok: true });
    // Twelve tables and their seed: the SAME string the cache store applies.
    await expect(
      state.query<{ id: string }>('SELECT id FROM onchain.access_profiles'),
    ).resolves.toStrictEqual([{ id: '01JPHASE00000000000000000A' }]);
  });

  it('opens with foreign_keys ON — asserted as STATE, not inferred from the call', async () => {
    // A mutation removing the `pragma('foreign_keys = ON')` line failed nothing: `better-sqlite3`
    // already opens with it on. So the invariant is read back from the connection instead, which
    // stays true whoever set it — and goes red the day a driver default changes underneath us.
    const captured: Database.Database[] = [];
    const Ctor = function (path: string, options?: { timeout?: number }): Database.Database {
      const database = new Database(path, options);
      captured.push(database);
      return database;
    } as unknown as never;
    const state = createSqliteStateClient({ path: ':memory:', DatabaseCtor: Ctor });
    expect(state.isAvailable()).toStrictEqual({ ok: true });
    expect(captured[0]?.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(captured[0]?.pragma('journal_mode', { simple: true })).toBe('memory');
  });

  it('enforces REFERENCES, which SQLite does not do by default (§1.6)', async () => {
    const state = client();
    // Without `PRAGMA foreign_keys = ON` a token could be issued to a person who does not exist and
    // nothing would say so.
    await expect(
      state.query(
        `INSERT INTO onchain.api_tokens
           (id, user_id, access_profile_id, token_hash, prefix, name, status, expires_at, revoked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, 'active', NULL, NULL, $6)`,
        ['01JT', '01JNOSUCHUSER', '01JPHASE00000000000000000A', 'a'.repeat(64), 'oi_abcdefghi', 1],
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe('transactions roll back, and never nest', () => {
  it('rolls back on a throw and propagates it', async () => {
    const state = client();
    await expect(
      state.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO onchain.users (id, email, display_name, role, status, created_at, updated_at)
           VALUES ($1, $2, NULL, 'admin', 'active', $3, $3)`,
          ['01JU1', 'a@example.com', 1],
        );
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');
    await expect(state.query('SELECT id FROM onchain.users')).resolves.toStrictEqual([]);
  });

  it('commits when the body returns', async () => {
    const state = client();
    await state.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO onchain.users (id, email, display_name, role, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'admin', 'active', $3, $3)`,
        ['01JU1', 'a@example.com', 1],
      );
    });
    await expect(state.query('SELECT id FROM onchain.users')).resolves.toStrictEqual([
      { id: '01JU1' },
    ]);
  });

  it('serializes overlapping transactions instead of nesting a second BEGIN', async () => {
    // `better-sqlite3` is synchronous over ONE connection, so two overlapping transactions would
    // issue a second `BEGIN` inside the first — which SQLite refuses, and the failure would arrive
    // at whichever caller happened to be second. The Postgres client checks a connection out of a
    // pool per transaction and has no such problem; the difference is the driver's, not the design's.
    const state = client();
    const insert = (id: string, email: string) =>
      state.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO onchain.users (id, email, display_name, role, status, created_at, updated_at)
           VALUES ($1, $2, NULL, 'user', 'active', $3, $3)`,
          [id, email, 1],
        );
        // Yield, so a second transaction would interleave here if nothing serialized them.
        await Promise.resolve();
      });

    await Promise.all([insert('01JU1', 'a@example.com'), insert('01JU2', 'b@example.com')]);
    await expect(state.query('SELECT id FROM onchain.users ORDER BY id')).resolves.toStrictEqual([
      { id: '01JU1' },
      { id: '01JU2' },
    ]);
  });

  it('keeps serving after a failed transaction — one failure does not wedge the queue', async () => {
    const state = client();
    await expect(state.transaction(() => Promise.reject(new Error('first fails')))).rejects.toThrow(
      'first fails',
    );
    await expect(
      state.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO onchain.users (id, email, display_name, role, status, created_at, updated_at)
           VALUES ($1, $2, NULL, 'user', 'active', $3, $3)`,
          ['01JU3', 'c@example.com', 1],
        );
        return 'done';
      }),
    ).resolves.toBe('done');
  });
});

describe('an unopenable database refuses with the path and the reason', () => {
  it('answers ok:false rather than throwing at construction', () => {
    const state = createSqliteStateClient({
      path: '/definitely/not/a/directory/that/exists/cache.sqlite3',
      DatabaseCtor: Database as unknown as never,
    });
    const available = state.isAvailable();
    expect(available.ok).toBe(false);
    // The path is named: an operator debugging `network-sqlite` needs it, and it is not a secret.
    expect(available.ok ? '' : available.reason).toContain('cache.sqlite3');
  });
});
