import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRequestTraceStore,
  type RequestTraceRecord,
  type RequestTraceStore,
} from '../src/engine/request-trace-store.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-30 — the repository over `onchain.request_trace`, against a real engine (the SQLite axis,
 * R-21).
 *
 * The property under test is the one the stub could only model: `INSERT ... ON CONFLICT DO NOTHING`
 * cannot fail on a repeat, so `written` is the only in-band way a caller learns that its re-run was
 * absorbed. A store that always answered `true` would look identical in every other assertion.
 */

let harness: SqliteEngine;
let store: RequestTraceStore;

beforeEach(() => {
  harness = createSqliteEngine();
  store = createRequestTraceStore(harness.engine);
  // `vendor_provider` REFERENCES `providers(id)`, so a row naming a vendor requires that vendor to
  // be registered in the same database. Production gets this from the budget store's own bootstrap
  // (`pg/budget-store.ts`); a bare harness has to seed it, and the case below proves the constraint
  // is doing something rather than merely being declared.
  harness.db.prepare("INSERT INTO providers (id, kind, notes) VALUES ('nansen','paid',NULL)").run();
});

afterEach(() => harness.close());

const RECORD: RequestTraceRecord = {
  id: '01JTRACE00000000000000000A',
  receivedAt: 1_784_851_234_000,
  completedAt: 1_784_851_234_500,
  principalId: '01JTOKEN00000000000000000A',
  userId: null,
  accessProfileId: null,
  clientRequestId: 'req-1',
  sessionId: 'sess-1',
  transport: 'http',
  tool: 'onchain_entity_label',
  capability: 'entity.labels',
  argsHash: 'a'.repeat(64),
  outcome: 'answer',
  refusalClass: null,
  servedFrom: 'vendor',
  cacheAgeMs: null,
  vendorProvider: 'nansen',
  vendorCredits: 10,
  vendorCalls: 1,
  vendorDay: 1_784_851_200_000,
  vendorWindowStart: 1_784_851_260_000,
  escalatedToPaid: 0,
  triedJson: null,
  createdAt: 1_784_851_234_500,
};

const rows = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM request_trace ORDER BY id').all() as Record<string, unknown>[];

describe('the row reaches the table with every column in place', () => {
  it('writes all twenty-four columns and reports the write', async () => {
    expect(await store.append(RECORD)).toStrictEqual({ written: true });

    const [row] = rows();
    expect(row).toBeDefined();
    // Spot-checked across the three families the record mixes — identity, the two vocabularies, and
    // the five vendor columns — rather than field by field, which would restate the mapping.
    expect(row?.['principal_id']).toBe(RECORD.principalId);
    expect(row?.['client_request_id']).toBe('req-1');
    expect(row?.['outcome']).toBe('answer');
    expect(row?.['served_from']).toBe('vendor');
    expect(row?.['vendor_credits']).toBe(10);
    expect(row?.['vendor_calls']).toBe(1);
    expect(row?.['vendor_day']).toBe(1_784_851_200_000);
    expect(row?.['escalated_to_paid']).toBe(0);
  });

  it('writes a null where the record says null, not an empty string', async () => {
    // The distinction the two engines both keep and `SUM` depends on: NULL is skipped, `0` is added.
    await store.append({
      ...RECORD,
      vendorProvider: null,
      vendorCredits: null,
      vendorCalls: null,
      vendorDay: null,
      vendorWindowStart: null,
    });
    const [row] = rows();
    expect(row?.['vendor_credits']).toBeNull();
    expect(row?.['vendor_calls']).toBeNull();
    expect(row?.['vendor_provider']).toBeNull();
  });
});

describe('the declared dedup key is enforced by the engine, and the repeat is reported', () => {
  it('answers written:false on a second write of the same key, and keeps one row', async () => {
    expect(await store.append(RECORD)).toStrictEqual({ written: true });
    expect(await store.append({ ...RECORD, id: '01JTRACE00000000000000000B' })).toStrictEqual({
      written: false,
    });
    expect(rows()).toHaveLength(1);
    // The FIRST row survives: `DO NOTHING` keeps what is there rather than replacing it.
    expect(rows()[0]?.['id']).toBe(RECORD.id);
  });

  it('treats a client retry as a NEW request, because received_at is in the key', async () => {
    // A retry is admitted again, reads the cache again and may call a vendor again, so it needs its
    // own row. Charge idempotency by `client_request_id` alone is T-015's concern, one layer up.
    await store.append(RECORD);
    const retry = {
      ...RECORD,
      id: '01JTRACE00000000000000000B',
      receivedAt: RECORD.receivedAt + 1,
    };
    expect(await store.append(retry)).toStrictEqual({ written: true });
    expect(rows()).toHaveLength(2);
  });

  it('separates two principals sending the same client id', async () => {
    await store.append(RECORD);
    const other = {
      ...RECORD,
      id: '01JTRACE00000000000000000B',
      principalId: '01JTOKEN00000000000000000B',
    };
    expect(await store.append(other)).toStrictEqual({ written: true });
    expect(rows()).toHaveLength(2);
  });
});

describe('the engine refuses what the vocabularies forbid', () => {
  it('rejects an outcome outside the three declared classes', async () => {
    await expect(
      store.append({ ...RECORD, outcome: 'maybe' as RequestTraceRecord['outcome'] }),
    ).rejects.toThrow();
  });

  it('rejects a refusal with no class, which is what makes the column NOT NULL worth having', async () => {
    // The CHECK is an equivalence, so this is the row a producer that forgot the class would write.
    await expect(
      store.append({ ...RECORD, outcome: 'refusal', refusalClass: null }),
    ).rejects.toThrow();
  });

  it('rejects an answer that carries a refusal class', async () => {
    await expect(
      store.append({ ...RECORD, outcome: 'answer', refusalClass: 'Leftover' }),
    ).rejects.toThrow();
  });

  it('refuses to name a vendor this installation does not know', async () => {
    // The ledger must not claim spend at a provider the installation has never registered — that row
    // would join to nothing and would be unattributable in T-015's reconciliation against `usage`.
    await expect(store.append({ ...RECORD, vendorProvider: 'not-registered' })).rejects.toThrow();
  });
});
