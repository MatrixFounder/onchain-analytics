import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_TRACE_OUTCOMES,
  REQUEST_TRACE_SERVED_FROM,
  createRequestTraceStoreStub,
  requestTraceDedupKey,
  type RequestTraceRecord,
} from '../src/engine/request-trace-store.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-29 — the shape of a trace row, measured on BOTH storage axes (R-27, AC-39 in part).
 *
 * **Why a shape gate and not a docstring.** Four paths write this row (cache hit, coalesced wait,
 * live vendor call, refusal) and T-015 charges from it. A column that exists on one engine and not
 * the other, or a `CHECK` that admits a fifth value, is a defect nobody notices until a bill is
 * wrong — and the two declarations live in different files, in different languages, in different
 * packages. This reads both.
 *
 * **The SQLite side is executed, the Postgres side is parsed.** R-21 forbids network in CI, so the
 * Postgres declaration is checked as TEXT — which measures the columns and their nullability and
 * NOT the engine's acceptance of them. That limit is stated rather than implied: what proves the
 * Postgres axis end to end is the migration's own verify gate on a live database.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The 24 columns of `data-model.md` §4.5.7, in the declared order. */
const DECLARED_COLUMNS = [
  'id',
  'received_at',
  'completed_at',
  'principal_id',
  'user_id',
  'access_profile_id',
  'client_request_id',
  'session_id',
  'transport',
  'tool',
  'capability',
  'args_hash',
  'outcome',
  'refusal_class',
  'served_from',
  'cache_age_ms',
  'vendor_provider',
  'vendor_credits',
  'vendor_calls',
  'vendor_day',
  'vendor_window_start',
  'escalated_to_paid',
  'tried_json',
  'created_at',
] as const;

/** The eleven the task declares `NOT NULL`, including `id` and all three dedup components. */
const NOT_NULL_COLUMNS = [
  'id',
  'received_at',
  'completed_at',
  'principal_id',
  'client_request_id',
  'transport',
  'tool',
  'outcome',
  'served_from',
  'escalated_to_paid',
  'created_at',
] as const;

let harness: SqliteEngine;

beforeEach(() => {
  harness = createSqliteEngine();
});

afterEach(() => harness.close());

/** One valid row, as column→value, with every nullable column explicitly null. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JTRACE0000000000000000AB',
    received_at: 1_770_000_000_000,
    completed_at: 1_770_000_000_500,
    principal_id: '01JTOKEN0000000000000000AB',
    user_id: null,
    access_profile_id: null,
    client_request_id: '01JREQ000000000000000000AB',
    session_id: null,
    transport: 'http',
    tool: 'onchain_ping',
    capability: null,
    args_hash: null,
    outcome: 'answer',
    refusal_class: null,
    served_from: 'none',
    cache_age_ms: null,
    vendor_provider: null,
    vendor_credits: null,
    vendor_calls: null,
    vendor_day: null,
    vendor_window_start: null,
    escalated_to_paid: 0,
    tried_json: null,
    created_at: 1_770_000_000_500,
    ...overrides,
  };
}

function insert(values: Record<string, unknown>): void {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  harness.db
    .prepare(`INSERT INTO request_trace (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((column) => values[column] as never));
}

interface PragmaColumn {
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
}

const sqliteColumns = (): PragmaColumn[] =>
  harness.db.prepare('PRAGMA table_info(request_trace)').all() as PragmaColumn[];

/** The `CREATE TABLE onchain.request_trace (...)` body of the shipped Postgres migration. */
function postgresBody(): string {
  const sql = readFileSync(
    path.join(repoRoot, 'sql/migrations/002_t014_network_profile.sql'),
    'utf8',
  );
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS onchain.request_trace');
  expect(start, 'the migration no longer declares onchain.request_trace').toBeGreaterThan(-1);
  const end = sql.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('TC-UNIT-01: 24 columns and 11 NOT NULL, on both axes', () => {
  it('the SQLite axis declares exactly the 24 columns of §4.5.7, in order', () => {
    expect(sqliteColumns().map((column) => column.name)).toStrictEqual([...DECLARED_COLUMNS]);
  });

  it('the SQLite axis marks exactly the 11 declared columns NOT NULL, `id` among them', () => {
    const notNull = sqliteColumns()
      .filter((column) => column.notnull === 1)
      .map((column) => column.name);
    // SQLite admits NULL in a `TEXT PRIMARY KEY` column unless the word is written, and Postgres
    // does not (§4.5.2a). Without it the same DDL gives a different constraint and a different
    // count on the two axes — which is why `id` is asserted to be inside this list, not beside it.
    expect(notNull.sort()).toStrictEqual([...NOT_NULL_COLUMNS].sort());
    expect(notNull).toContain('id');
    expect(sqliteColumns().find((column) => column.name === 'id')?.pk).toBe(1);
  });

  it('the Postgres axis declares the same 24 columns and the same 11 NOT NULL', () => {
    const body = postgresBody();
    const declared = body
      .split('\n')
      .slice(1)
      .map((line) => /^\s{2}([a-z_]+)\s+(TEXT|INTEGER|BIGINT)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    expect(declared.map((match) => match[1])).toStrictEqual([...DECLARED_COLUMNS]);
    const notNull = declared
      .filter((match) => /\bNOT NULL\b/.test(match.input.slice(match.index)))
      .map((match) => match[1] ?? '');
    expect(notNull.sort()).toStrictEqual([...NOT_NULL_COLUMNS].sort());
  });

  it('the record type carries the same 24 fields, so no column is written by nobody', () => {
    const record: RequestTraceRecord = {
      id: 'x',
      receivedAt: 1,
      completedAt: 2,
      principalId: 'p',
      userId: null,
      accessProfileId: null,
      clientRequestId: 'r',
      sessionId: null,
      transport: 'http',
      tool: 't',
      capability: null,
      argsHash: null,
      outcome: 'answer',
      refusalClass: null,
      servedFrom: 'none',
      cacheAgeMs: null,
      vendorProvider: null,
      vendorCredits: null,
      vendorCalls: null,
      vendorDay: null,
      vendorWindowStart: null,
      escalatedToPaid: 0,
      triedJson: null,
      createdAt: 2,
    };
    expect(Object.keys(record)).toHaveLength(DECLARED_COLUMNS.length);
    // The two spellings of one column set, joined: camelCase field ↔ snake_case column.
    const asColumns = Object.keys(record)
      .map((field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
      .sort();
    expect(asColumns).toStrictEqual([...DECLARED_COLUMNS].sort());
  });
});

describe('TC-UNIT-02 / TC-UNIT-03 / TC-UNIT-04: the four CHECK constraints', () => {
  it('`outcome` takes three values and refuses a fourth', () => {
    for (const [index, outcome] of REQUEST_TRACE_OUTCOMES.entries()) {
      const refusalClass = outcome === 'refusal' ? 'tool.refused' : null;
      expect(() => {
        // `received_at` varies per row: the three components are a UNIQUE key, so reusing the
        // triple would make this measure the index instead of the CHECK.
        insert(
          row({
            id: `01JTRACE${outcome}`,
            received_at: 1_770_000_000_000 + index,
            outcome,
            refusal_class: refusalClass,
          }),
        );
      }, outcome).not.toThrow();
    }
    expect(() => {
      insert(row({ id: '01JBAD', outcome: 'timeout' }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('`served_from` takes four values — `coalesced` among them — and refuses a fifth', () => {
    for (const [index, servedFrom] of REQUEST_TRACE_SERVED_FROM.entries()) {
      expect(() => {
        insert(
          row({
            id: `01JTRACE${servedFrom}`,
            received_at: 1_770_000_000_000 + index,
            served_from: servedFrom,
          }),
        );
      }, servedFrom).not.toThrow();
    }
    expect(REQUEST_TRACE_SERVED_FROM).toContain('coalesced');
    expect(() => {
      insert(row({ id: '01JBAD', served_from: 'stale' }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('`refusal_class` is filled if and only if the outcome is a refusal', () => {
    // A refusal with no class: an operator learns that something was refused and not what.
    expect(() => {
      insert(row({ id: '01JBAD1', outcome: 'refusal', refusal_class: null }));
    }).toThrow(/CHECK constraint failed/i);
    // Each valid row below gets its own `received_at`, for the reason above.
    // An answer carrying one: the class would name a failure that did not happen.
    expect(() => {
      insert(row({ id: '01JBAD2', outcome: 'answer', refusal_class: 'tool.refused' }));
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insert(
        row({
          id: '01JOK',
          received_at: 1_770_000_000_009,
          outcome: 'refusal',
          refusal_class: 'tool.refused',
        }),
      );
    }).not.toThrow();
  });

  it('`escalated_to_paid` takes 0 and 1 and refuses anything else', () => {
    expect(() => {
      insert(row({ id: '01JBAD3', escalated_to_paid: 2 }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('both axes declare all four constraints and all three indexes', () => {
    const body = postgresBody();
    for (const check of [
      "CHECK (outcome IN ('answer','refusal','partial_deadline'))",
      "CHECK (served_from IN ('cache','coalesced','vendor','none'))",
      "CHECK ((outcome = 'refusal') = (refusal_class IS NOT NULL))",
      'CHECK (escalated_to_paid IN (0,1))',
      'UNIQUE (principal_id, client_request_id, received_at)',
    ]) {
      expect(body, `the Postgres axis is missing: ${check}`).toContain(check);
    }
    const indexes = harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'request_trace'")
      .all() as { name: string }[];
    const named = indexes.map((index) => index.name);
    for (const index of [
      'idx_request_trace_principal',
      'idx_request_trace_received',
      'idx_request_trace_spend',
    ]) {
      expect(named, `the SQLite axis is missing ${index}`).toContain(index);
    }
  });
});

describe('TC-UNIT-05 / TC-UNIT-06: the dedup key is the declared triple', () => {
  it('a repeat of all three components produces no duplicate row', () => {
    insert(row());
    expect(() => {
      insert(row({ id: '01JTRACE0000000000000000CD' }));
    }).toThrow(/UNIQUE constraint failed/i);
    expect(
      (harness.db.prepare('SELECT COUNT(*) AS n FROM request_trace').get() as { n: number }).n,
    ).toBe(1);
  });

  it('the same client_request_id at a DIFFERENT received_at keeps both rows', () => {
    // A client retry is a new server-side request: admitted again, reads the cache again, and may
    // call a vendor again. Charge idempotency by `client_request_id` is T-015's, one layer up.
    insert(row());
    insert(row({ id: '01JTRACE0000000000000000CD', received_at: 1_770_000_001_000 }));
    expect(
      (harness.db.prepare('SELECT COUNT(*) AS n FROM request_trace').get() as { n: number }).n,
    ).toBe(2);
  });

  it('the in-process key agrees with the index, including on a separator-bearing id', async () => {
    // `clientRequestId` is client-supplied, so a `join('|')` would collapse ('p|1','r') and
    // ('p','1|r') into one key and discard a second client's genuine request as a duplicate.
    const first = requestTraceDedupKey({
      principalId: 'p|1',
      clientRequestId: 'r',
      receivedAt: 1,
    });
    const second = requestTraceDedupKey({
      principalId: 'p',
      clientRequestId: '1|r',
      receivedAt: 1,
    });
    expect(first).not.toBe(second);

    // The rule has TWO enforcers — this process and the engine's unique index — and a rule kept
    // private to one of them cannot be tested against the other.
    const stub = createRequestTraceStoreStub();
    const base = toRecord(row());
    expect((await stub.append(base)).written).toBe(true);
    expect((await stub.append({ ...base, id: 'another-id' })).written).toBe(false);
    expect(stub.appended).toHaveLength(1);
  });
});

describe('TC-UNIT-07 / TC-UNIT-08 / TC-UNIT-09: the coalesced row and the defaults', () => {
  it('a coalesced row carries empty credits and calls, and filled bucket coordinates', () => {
    insert(
      row({
        served_from: 'coalesced',
        vendor_provider: null,
        vendor_credits: null,
        vendor_calls: null,
        vendor_day: 1_769_990_400_000,
        vendor_window_start: 1_770_000_000_000,
      }),
    );
    const stored = harness.db.prepare('SELECT * FROM request_trace').get() as Record<
      string,
      unknown
    >;
    // Empty, NOT zero: zero asserts that spend was measured here and came out nought, which is
    // false — the whole amount sits on the leader's row.
    expect(stored['vendor_credits']).toBeNull();
    expect(stored['vendor_calls']).toBeNull();
    // The coordinates ARE written: they name the buckets the leader's call landed in, which is the
    // link between this charge and the spend that served it.
    expect(stored['vendor_day']).toBe(1_769_990_400_000);
    expect(stored['vendor_window_start']).toBe(1_770_000_000_000);
  });

  it('SUM over a period of coalesced rows only is EMPTY, so it adds nothing to any total', () => {
    for (const [index, received] of [1_770_000_000_000, 1_770_000_001_000].entries()) {
      insert(
        row({
          id: `01JCOALESCED${String(index)}`,
          received_at: received,
          served_from: 'coalesced',
          vendor_credits: null,
          vendor_calls: null,
        }),
      );
    }
    const summed = harness.db
      .prepare('SELECT SUM(vendor_credits) AS credits, COUNT(*) AS rows FROM request_trace')
      .get() as { credits: number | null; rows: number };
    expect(summed.rows).toBe(2);
    // R-27.3: `SUM` skips nulls on both engines, so a follower row contributes to no total. A
    // period of followers alone answers "no attributable spend", not "zero spend".
    expect(summed.credits).toBeNull();
  });

  it('`escalated_to_paid` written without a value defaults to 0', () => {
    const values = row();
    delete values['escalated_to_paid'];
    insert(values);
    expect(
      (
        harness.db.prepare('SELECT escalated_to_paid AS flag FROM request_trace').get() as {
          flag: number;
        }
      ).flag,
    ).toBe(0);
  });
});

/** Turns the column-keyed fixture into the record type, so both spellings stay in one test. */
function toRecord(values: Record<string, unknown>): RequestTraceRecord {
  const camel: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(values)) {
    camel[column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())] = value;
  }
  return camel as unknown as RequestTraceRecord;
}
