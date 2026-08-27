import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteStateClient } from '@onchain-intel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerReadNotAuthoritativeError } from '../src/engine/billing-errors.js';
import {
  RESERVE_INSERT_SQL,
  createSqliteBillingStore,
  type BillingReserveResult,
} from '../src/engine/billing-store.js';

/**
 * Task 015-06 — `BillingStore` on the SQLite axis, checked against a REAL engine (a real
 * `better-sqlite3` connection, `:memory:` in every case except TC-UNIT-04 which needs a real file
 * under a temp `DATA_DIR`). The interface and the stub are task 015-04's (`billing-store-contract
 * .test.ts`); this file is the first one that reaches a database, per `tdd-stub-first` §2.
 */

/** One input shared across cases — mirrors `billing-store-contract.test.ts`'s own fixture. */
function reserveInput(overrides: { clientRequestId?: string } = {}) {
  return {
    principalId: 'local',
    accessProfileId: null,
    clientRequestId: overrides.clientRequestId ?? 'req-1',
    tool: 'onchain_token_price',
    capability: 'token.price',
    priceRaw: '1',
  };
}

/** Deterministic, strictly increasing clock — `Date.now()` at millisecond resolution can return the
 * SAME value across two calls a few lines apart, which would make "the first terminal_at survives a
 * second settle" (TC-UNIT-07) pass by accident even with the `WHERE state = 'reserved'` guard
 * removed. */
function counterClock(start = 1_000, step = 1_000): () => number {
  let value = start;
  return (): number => {
    const current = value;
    value += step;
    return current;
  };
}

/**
 * A `DatabaseCtor` that captures the one connection it opens and records every SQL string passed to
 * `.prepare()`, in order — the input TC-UNIT-05 needs ("record executed statements"). Recording on
 * `.prepare()` rather than around the client mirrors `test/helpers/sqlite-engine.ts`'s own choice for
 * the identical reason: the assertions are about the statement text the STORE emits, and that is
 * exactly what reaches `.prepare()` (after `toSqliteDialect`, which leaves `BEGIN IMMEDIATE`/
 * `COMMIT`/`ROLLBACK` untouched — none of the three substitutions apply to them).
 */
function capturingCtor(): {
  readonly Ctor: unknown;
  readonly statements: readonly string[];
  db(): Database.Database;
} {
  const statements: string[] = [];
  let opened: Database.Database | undefined;
  const Ctor = function (
    dbPath: string,
    options?: { readonly timeout?: number },
  ): Database.Database {
    const database = new Database(dbPath, options);
    const originalPrepare = database.prepare.bind(database);
    database.prepare = ((sql: string) => {
      statements.push(sql);
      return originalPrepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    opened = database;
    return database;
  };
  return {
    Ctor,
    statements,
    db(): Database.Database {
      if (opened === undefined) throw new Error('the database was never opened');
      return opened;
    },
  };
}

interface ClientUsageRow {
  readonly id: string;
  readonly principal_id: string;
  readonly access_profile_id: string | null;
  readonly client_request_id: string;
  readonly tool: string;
  readonly capability: string | null;
  readonly price_raw: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  readonly refund_reason: string | null;
  readonly reserved_at: number;
  readonly terminal_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function readRows(db: Database.Database): ClientUsageRow[] {
  return db.prepare('SELECT * FROM client_usage').all() as ClientUsageRow[];
}

function readRow(db: Database.Database, id: string): ClientUsageRow {
  const row = db.prepare('SELECT * FROM client_usage WHERE id = ?').get(id) as
    ClientUsageRow | undefined;
  if (row === undefined) throw new Error(`no row for id ${id}`);
  return row;
}

function unwrapOk(result: BillingReserveResult): { rowId: string; existing: boolean } {
  if (!result.ok) throw new Error(`unreachable — reserve() refused: ${JSON.stringify(result)}`);
  return result.reservation;
}

describe('BillingStore on the SQLite axis (task 015-06)', () => {
  it('TC-UNIT-01: reserve() writes one row in the declared form', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({ path: ':memory:', DatabaseCtor: Ctor });

    const result = await store.reserve(reserveInput());
    unwrapOk(result);

    const rows = readRows(db());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('reserved');
    expect(rows[0]?.price_raw).toBe('1');
    expect(rows[0]?.terminal_at).toBeNull();
  });

  it('TC-UNIT-02 (AC-10): a repeated client_request_id does not create a second row', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({ path: ':memory:', DatabaseCtor: Ctor });
    const input = reserveInput();

    const first = unwrapOk(await store.reserve(input));
    const second = unwrapOk(await store.reserve(input));

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.rowId).toBe(first.rowId);
    expect(readRows(db())).toHaveLength(1);
  });

  it('TC-UNIT-03 (AC-11): two concurrent reserves of the same id give exactly one reservation', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({ path: ':memory:', DatabaseCtor: Ctor });
    const input = reserveInput();

    const [first, second] = await Promise.all([store.reserve(input), store.reserve(input)]);
    const a = unwrapOk(first);
    const b = unwrapOk(second);

    expect(a.rowId).toBe(b.rowId);
    // Exactly one of the two observed the insert; the other read the row back.
    expect([a.existing, b.existing].filter((existing) => existing === true)).toHaveLength(1);
    expect(readRows(db())).toHaveLength(1);
  });

  describe('TC-UNIT-04 (AC-14): no ONCHAIN_STATE_PG_URL writes into DATA_DIR/cache.sqlite3', () => {
    let dataDir: string | undefined;

    afterEach(() => {
      if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    });

    it('lands the row in the DATA_DIR this env resolves to', async () => {
      dataDir = mkdtempSync(path.join(tmpdir(), 'billing-sqlite-'));
      // No `path` override and no `DatabaseCtor` override: this exercises the SAME default file
      // resolution `createSqliteStateClient` uses in production
      // (`packages/core/src/sqlite/state-client.ts:69`), and the env object below carries no
      // `ONCHAIN_STATE_PG_URL` key at all — the axis this store speaks is fixed at construction,
      // not chosen from the environment.
      const env = { DATA_DIR: dataDir } as unknown as NodeJS.ProcessEnv;
      const store = createSqliteBillingStore({ env });

      const result = unwrapOk(await store.reserve(reserveInput()));

      const verify = new Database(path.join(dataDir, 'cache.sqlite3'));
      try {
        const row = readRow(verify, result.rowId);
        expect(row.state).toBe('reserved');
      } finally {
        verify.close();
      }
    });
  });

  it('TC-UNIT-05: the reserve transaction opens in BEGIN IMMEDIATE, not BEGIN', async () => {
    const { Ctor, statements } = capturingCtor();
    const store = createSqliteBillingStore({ path: ':memory:', DatabaseCtor: Ctor });

    await store.reserve(reserveInput());

    expect(statements).toContain('BEGIN IMMEDIATE');
    expect(statements).not.toContain('BEGIN');
  });

  it('TC-UNIT-06: settle() moves reserved -> settled and fills terminal_at', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({
      path: ':memory:',
      DatabaseCtor: Ctor,
      now: counterClock(),
    });
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    await store.settle(rowId);

    const row = readRow(db(), rowId);
    expect(row.state).toBe('settled');
    expect(row.terminal_at).not.toBeNull();
    expect(row.refund_reason).toBeNull();
  });

  it('TC-UNIT-07: a repeat settle() on an already-closed row does not error and keeps the first terminal_at', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({
      path: ':memory:',
      DatabaseCtor: Ctor,
      now: counterClock(),
    });
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    await store.settle(rowId);
    const firstTerminalAt = readRow(db(), rowId).terminal_at;

    await expect(store.settle(rowId)).resolves.toEqual({ written: false });

    const row = readRow(db(), rowId);
    expect(row.terminal_at).toBe(firstTerminalAt);
    expect(row.state).toBe('settled');
  });

  it('TC-UNIT-08: refund() moves reserved -> refunded and records the reason', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({
      path: ':memory:',
      DatabaseCtor: Ctor,
      now: counterClock(),
    });
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    await store.refund(rowId, 'ClientCreditsExhaustedError');

    const row = readRow(db(), rowId);
    expect(row.state).toBe('refunded');
    expect(row.refund_reason).toBe('ClientCreditsExhaustedError');
    expect(row.terminal_at).not.toBeNull();
  });

  it('TC-UNIT-09: settle() on a refunded row changes no column — the WHERE state=reserved guard', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({
      path: ':memory:',
      DatabaseCtor: Ctor,
      now: counterClock(),
    });
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));
    await store.refund(rowId, 'ReplayWindowExpiredError');
    const before = readRow(db(), rowId);

    await store.settle(rowId);

    const after = readRow(db(), rowId);
    expect(after).toStrictEqual(before);
    expect(after.state).toBe('refunded');
  });

  it('TC-UNIT-10: the reserve operator is schema-qualified — the gate accepts it, rejects an unqualified version', async () => {
    expect(RESERVE_INSERT_SQL).toContain('onchain.client_usage');

    const client = createSqliteStateClient({ path: ':memory:' });
    const unqualified = RESERVE_INSERT_SQL.replace(/onchain\.client_usage/g, 'client_usage');

    await expect(
      client.query(unqualified, ['id-1', 'p', null, 'r', 't', null, '1', 1]),
    ).rejects.toThrow(/schema-qualified/);

    await expect(
      client.query(RESERVE_INSERT_SQL, ['id-2', 'p', null, 'r', 't', null, '1', 1]),
    ).resolves.toEqual([{ id: 'id-2', state: 'reserved' }]);
  });

  it('TC-UNIT-11: reserve() writes the caller-supplied client_request_id, minting no new id for it', async () => {
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({ path: ':memory:', DatabaseCtor: Ctor });

    const { rowId } = unwrapOk(
      await store.reserve(reserveInput({ clientRequestId: 'caller-supplied-abc' })),
    );

    expect(readRow(db(), rowId).client_request_id).toBe('caller-supplied-abc');
  });

  it('TC-UNIT-12: sumSettled on the SQLite axis throws LedgerReadNotAuthoritativeError, never "0"', async () => {
    const store = createSqliteBillingStore({ path: ':memory:' });
    await expect(store.sumSettled(0, 1)).rejects.toBeInstanceOf(LedgerReadNotAuthoritativeError);
  });
});
