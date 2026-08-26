import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_DDL } from '../src/cache/ddl.js';
import { SqliteBudgetStore } from '../src/cache/budget-store.js';

/**
 * Task 015-02 — `client_usage` DDL (data-model.md §4.6.1) and `usage.calls_made` (§4.6.3), both on
 * the SQLite axis. `client_usage` gets no store here (task 015-04/015-06, packages/mcp-server) — this
 * file only proves the SHAPE that a future writer relies on, the same split `engine-ddl.test.ts`
 * already draws for the T-014 tables.
 *
 * **Why a raw `Database` + `CACHE_DDL` for the shape tests, not `SqliteBudgetStore`.**
 * `SqliteBudgetStore` keeps its connection private (no `client_usage` operations belong to it — the
 * store above lives in a different package), so introspecting constraints/indexes needs a direct
 * connection. `CACHE_DDL` is the EXACT string `SqliteBudgetStore`'s constructor execs
 * (`budget-store.ts:182`), so opening it directly still proves AC-14 ("the table is created when
 * DATA_DIR opens without Postgres") — it is the same statement, not a duplicate of it.
 *
 * The `usage.calls_made` MIGRATION tests (TC-UNIT-07..09) go through the real `SqliteBudgetStore`
 * constructor instead, against a file (idempotency-on-reopen needs a persistent file, not
 * `:memory:`), because `migrateUsage()` is the thing under test there.
 */

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

interface ClientUsageRow {
  id: string;
  principal_id: string;
  access_profile_id: string | null;
  client_request_id: string;
  tool: string;
  capability: string | null;
  price_raw: string;
  state: string;
  refund_reason: string | null;
  reserved_at: number;
  terminal_at: number | null;
  created_at: number;
  updated_at: number;
}

const CLIENT_USAGE_INDEXES = [
  'idx_client_usage_principal',
  'idx_client_usage_terminal',
  'idx_client_usage_reserved',
] as const;

const baseRow = (): ClientUsageRow => ({
  id: '01JCLIENTUSAGE00000000001',
  principal_id: 'local',
  access_profile_id: null,
  client_request_id: 'req-1',
  tool: 'onchain_ping',
  capability: null,
  price_raw: '1',
  state: 'reserved',
  refund_reason: null,
  reserved_at: 1_000,
  terminal_at: null,
  created_at: 1_000,
  updated_at: 1_000,
});

/** Opens a fresh `:memory:` database with `CACHE_DDL` applied — mirrors `engine-ddl.test.ts`. */
const openRaw = (): Database.Database => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CACHE_DDL);
  return db;
};

const insertClientUsage = (
  db: Database.Database,
  overrides: Partial<ClientUsageRow> = {},
): void => {
  const row = { ...baseRow(), ...overrides };
  db.prepare(
    `INSERT INTO client_usage (
       id, principal_id, access_profile_id, client_request_id, tool, capability, price_raw,
       state, refund_reason, reserved_at, terminal_at, created_at, updated_at
     ) VALUES (
       @id, @principal_id, @access_profile_id, @client_request_id, @tool, @capability, @price_raw,
       @state, @refund_reason, @reserved_at, @terminal_at, @created_at, @updated_at
     )`,
  ).run(row);
};

describe('client_usage DDL on the SQLite axis (task 015-02, data-model.md §4.6.1)', () => {
  it('TC-UNIT-01: the table and its three indexes appear on a fresh database', () => {
    const db = openRaw();
    const columns = db.prepare('PRAGMA table_info(client_usage)').all() as ColumnInfo[];
    expect(columns).toHaveLength(13);
    const notNullCount = columns.filter((c) => c.notnull === 1).length;
    expect(notNullCount).toBe(9);

    const indexNames = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'client_usage'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    for (const index of CLIENT_USAGE_INDEXES) {
      expect(indexNames, `index ${index}`).toContain(index);
    }
    db.close();
  });

  it('TC-UNIT-02: the dedup key is declared without a time component', () => {
    const db = openRaw();
    const indexList = db.prepare('PRAGMA index_list(client_usage)').all() as {
      name: string;
      origin: string;
      unique: number;
    }[];
    const dedup = indexList.find((i) => i.origin === 'u'); // 'u' = table-level UNIQUE, not the PK
    expect(dedup, 'a UNIQUE index besides the primary key').toBeDefined();
    const keyColumns = (
      db.prepare(`PRAGMA index_info(${dedup!.name})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(keyColumns).toEqual(['principal_id', 'client_request_id']);
    expect(keyColumns).not.toContain('reserved_at');
    expect(keyColumns).not.toContain('created_at');
    db.close();
  });

  it('TC-UNIT-03: state accepts three values and rejects a fourth', () => {
    const db = openRaw();
    expect(() => insertClientUsage(db, { state: 'pending' })).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('TC-UNIT-04: refund_reason is filled if and only if state = refunded', () => {
    const db = openRaw();
    expect(() =>
      insertClientUsage(db, {
        id: '01JCLIENTUSAGE00000000002',
        client_request_id: 'req-2',
        state: 'refunded',
        refund_reason: null,
        terminal_at: 2_000,
      }),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      insertClientUsage(db, {
        id: '01JCLIENTUSAGE00000000003',
        client_request_id: 'req-3',
        state: 'settled',
        refund_reason: 'ClientCreditsExhaustedError',
        terminal_at: 2_000,
      }),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('TC-UNIT-05: terminal_at is empty if and only if state = reserved', () => {
    const db = openRaw();
    expect(() =>
      insertClientUsage(db, {
        id: '01JCLIENTUSAGE00000000004',
        client_request_id: 'req-4',
        state: 'reserved',
        terminal_at: 2_000,
      }),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      insertClientUsage(db, {
        id: '01JCLIENTUSAGE00000000005',
        client_request_id: 'req-5',
        state: 'settled',
        terminal_at: null,
      }),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('TC-UNIT-06: price_raw is stored as TEXT and reads back byte-for-byte', () => {
    const db = openRaw();
    const exact = '9007199254740993'; // 2^53 + 1 — unsafe as a JS number
    insertClientUsage(db, { price_raw: exact });
    const row = db.prepare('SELECT price_raw FROM client_usage WHERE id = ?').get(baseRow().id) as {
      price_raw: unknown;
    };
    expect(row.price_raw).toBe(exact);
    expect(typeof row.price_raw).toBe('string');
    db.close();
  });
});

describe('usage.calls_made on the SQLite axis (task 015-02, data-model.md §4.6.3)', () => {
  it('TC-UNIT-07: calls_made appears on a fresh database with a 0 default', () => {
    const db = openRaw();
    const columns = db.prepare('PRAGMA table_info(usage)').all() as ColumnInfo[];
    const callsMade = columns.find((c) => c.name === 'calls_made');
    expect(callsMade, 'usage.calls_made column').toBeDefined();
    expect(callsMade!.dflt_value).toBe('0');
    expect(callsMade!.notnull).toBe(1);
    db.close();
  });

  describe('migration idempotency (file-backed — needs a real reopen)', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'ddl-client-usage-'));
      dbPath = path.join(dir, 'cache.sqlite3');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('TC-UNIT-08: the column migration is idempotent across a second open of the same file', () => {
      const first = new SqliteBudgetStore({ dbPath, providers: [] });
      first.close();

      expect(() => {
        const second = new SqliteBudgetStore({ dbPath, providers: [] });
        second.close();
      }).not.toThrow();

      const db = new Database(dbPath);
      const columns = db.prepare('PRAGMA table_info(usage)').all() as ColumnInfo[];
      expect(columns.filter((c) => c.name === 'calls_made')).toHaveLength(1);
      db.close();
    });

    it('TC-UNIT-09: a database created before the column gets it with no backfill', () => {
      // Simulate a pre-015-02 file: `usage` WITHOUT calls_made, one row written before migration.
      const pre = new Database(dbPath);
      pre.exec(`
        CREATE TABLE providers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, notes TEXT);
        CREATE TABLE usage (
          provider     TEXT NOT NULL REFERENCES providers(id),
          day          INTEGER NOT NULL,
          credits_used INTEGER NOT NULL DEFAULT 0,
          updated_at   INTEGER NOT NULL,
          PRIMARY KEY (provider, day)
        );
        INSERT INTO providers (id, kind, notes) VALUES ('nansen', 'paid', NULL);
        INSERT INTO usage (provider, day, credits_used, updated_at) VALUES ('nansen', 1000, 42, 1000);
      `);
      pre.close();

      const store = new SqliteBudgetStore({ dbPath, providers: [] });
      store.close();

      const db = new Database(dbPath);
      const row = db
        .prepare('SELECT credits_used, calls_made FROM usage WHERE provider = ? AND day = ?')
        .get('nansen', 1000) as { credits_used: number; calls_made: number };
      expect(row.calls_made).toBe(0);
      expect(row.credits_used).toBe(42); // unchanged by the migration — no backfill
      db.close();
    });
  });
});
