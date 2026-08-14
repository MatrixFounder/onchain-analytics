import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_DDL } from '../src/cache/ddl.js';

/**
 * Task 014-36 — the eight engine tables on the SQLite axis, exercised against a real file database.
 *
 * **Why a file and not `:memory:`.** Idempotency is the property under test, and re-opening a file
 * is what an installation actually does. An in-memory database is a fresh one every time, so it
 * would pass the re-run assertion without ever exercising it.
 *
 * **Why this is where token revocation and the audit guard get tested at all.** One DDL string and
 * one store implementation serve both dialects, so these assertions run with no Postgres process —
 * which is what makes them runnable in CI, where R-21 forbids reaching over the network.
 */

const ENGINE_TABLES = [
  'users',
  'access_profiles',
  'api_tokens',
  'access_audit',
  'provider_buckets',
  'request_trace',
  'diagnostics',
  'retention_runs',
] as const;

const ENGINE_INDEXES = [
  'idx_api_tokens_user',
  'idx_access_audit_actor',
  'idx_access_audit_target',
  'idx_access_audit_ts',
  'idx_request_trace_principal',
  'idx_request_trace_received',
  'idx_request_trace_spend',
  'idx_diagnostics_ts',
  'idx_diagnostics_event_ts',
  'idx_retention_runs_job',
] as const;

/** The seven ULID primary keys of §4.5; `provider_buckets` has a composite key and is not among them. */
const ULID_KEYED = ENGINE_TABLES.filter((t) => t !== 'provider_buckets');

const PHASE0_PROFILE_ID = '01JPHASE00000000000000000A';

let dir: string;
let file: string;

const open = (): Database.Database => {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(CACHE_DDL);
  return db;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'engine-ddl-'));
  file = path.join(dir, 'cache.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('engine DDL on the SQLite axis — shape', () => {
  it('TC-UNIT-01: the eight tables and ten indexes appear on a fresh database', () => {
    const db = open();
    const objects = db
      .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','index')`)
      .all() as { name: string; type: string }[];
    const names = new Set(objects.map((o) => o.name));
    for (const table of ENGINE_TABLES) expect(names, `table ${table}`).toContain(table);
    for (const index of ENGINE_INDEXES) expect(names, `index ${index}`).toContain(index);
    db.close();
  });

  it('TC-UNIT-02: re-opening the same file is a no-op, not an error', () => {
    open().close();
    expect(() => open().close()).not.toThrow();
  });

  it('TC-UNIT-06: the phase 0 profile is seeded once, with the id migration 002 also seeds', () => {
    open().close();
    const db = open();
    const rows = db
      .prepare(`SELECT id FROM access_profiles WHERE name = 'phase0-unlimited'`)
      .all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(PHASE0_PROFILE_ID);
    db.close();
  });

  it('spells NOT NULL beside every ULID primary key, so both axes declare the same count', () => {
    const db = open();
    for (const table of ULID_KEYED) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const id = columns.find((c) => c.name === 'id');
      expect(id?.pk, `${table}.id is the primary key`).toBe(1);
      expect(id?.notnull, `${table}.id declares NOT NULL — SQLite admits NULL without it`).toBe(1);
    }
    db.close();
  });

  it('TC-UNIT-07: a mode without its value is refused', () => {
    const db = open();
    const insert = (): unknown =>
      db
        .prepare(
          `INSERT INTO access_profiles (id, name, status, credits_mode, credits_balance_raw,
             rate_limit_mode, rate_limit_per_min, tool_allowlist_mode, tool_allowlist_json,
             route_disclosure_mode, created_at, updated_at)
           VALUES ('01JX', 'metered-no-balance', 'active', 'metered', NULL,
             'unlimited', NULL, 'all', NULL, 'full', 0, 0)`,
        )
        .run();
    expect(insert).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('refuses a third value of route_disclosure_mode', () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO access_profiles (id, name, status, credits_mode, rate_limit_mode,
             tool_allowlist_mode, route_disclosure_mode, created_at, updated_at)
           VALUES ('01JY', 'partial', 'active', 'unlimited', 'unlimited', 'all', 'partial', 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });
});

describe('engine DDL on the SQLite axis — the guarantees other tasks build on', () => {
  const seedIdentity = (db: Database.Database): void => {
    db.prepare(
      `INSERT INTO users (id, email, role, status, created_at, updated_at)
       VALUES ('01JU', 'owner@example.test', 'admin', 'active', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO api_tokens (id, user_id, access_profile_id, token_hash, prefix, status, created_at)
       VALUES ('01JT', '01JU', ?, ?, 'oi_abcdefg', 'active', 1)`,
    ).run(PHASE0_PROFILE_ID, 'a'.repeat(64));
  };

  it('TC-UNIT-04: revocation reads back as revocation, and a half-revoked row is refused', () => {
    const db = open();
    seedIdentity(db);

    expect(() =>
      db.prepare(`UPDATE api_tokens SET status = 'revoked' WHERE id = '01JT'`).run(),
    ).toThrow(/CHECK constraint/i);

    db.prepare(`UPDATE api_tokens SET status = 'revoked', revoked_at = 2 WHERE id = '01JT'`).run();
    const row = db
      .prepare(`SELECT status FROM api_tokens WHERE token_hash = ?`)
      .get('a'.repeat(64));
    expect(row).toEqual({ status: 'revoked' });
    db.close();
  });

  it('TC-UNIT-03: the audit log refuses UPDATE and DELETE alike', () => {
    const db = open();
    seedIdentity(db);
    db.prepare(
      `INSERT INTO access_audit (id, ts, actor_user_id, action, target_type, target_id, created_at)
       VALUES ('01JA', 1, '01JU', 'token.issue', 'api_token', '01JT', 1)`,
    ).run();

    expect(() =>
      db.prepare(`UPDATE access_audit SET action = 'x' WHERE id = '01JA'`).run(),
    ).toThrow(/append-only/i);
    expect(() => db.prepare(`DELETE FROM access_audit WHERE id = '01JA'`).run()).toThrow(
      /append-only/i,
    );
    expect(db.prepare(`SELECT count(*) AS n FROM access_audit`).get()).toEqual({ n: 1 });
    db.close();
  });

  it('TC-UNIT-05: the limiter bucket honours its foreign key', () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO provider_buckets (provider, scope_key, tokens, last_refill_ms, updated_at)
           VALUES ('no-such-provider', '', 1.0, 1, 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('keeps a negative bucket balance instead of clamping it at zero', () => {
    const db = open();
    db.prepare(`INSERT INTO providers (id, kind) VALUES ('defillama', 'free')`).run();
    db.prepare(
      `INSERT INTO provider_buckets (provider, scope_key, tokens, last_refill_ms, updated_at)
       VALUES ('defillama', '', -3.5, 1, 1)`,
    ).run();
    expect(db.prepare(`SELECT tokens FROM provider_buckets`).get()).toEqual({ tokens: -3.5 });
    db.close();
  });

  it('lets a diagnostics row name a trace that does not exist yet', () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO diagnostics (id, ts, severity, event, trace_id, detail_json, created_at)
           VALUES ('01JD', 1, 'warn', 'limiter.degraded', '01J-NOT-WRITTEN-YET', '{}', 1)`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('refuses a second trace row with the same dedup key, and admits a different one', () => {
    const db = open();
    const insert = (id: string, receivedAt: number): unknown =>
      db
        .prepare(
          `INSERT INTO request_trace (id, received_at, completed_at, principal_id,
             client_request_id, transport, tool, outcome, served_from, created_at)
           VALUES (?, ?, ?, 'local', 'req-1', 'stdio', 'onchain_ping', 'answer', 'none', 1)`,
        )
        .run(id, receivedAt, receivedAt);
    insert('01JR1', 10);
    expect(() => insert('01JR2', 10)).toThrow(/UNIQUE constraint/i);
    expect(() => insert('01JR3', 11)).not.toThrow();
    db.close();
  });

  it('refuses a refusal with no class, and a class with no refusal', () => {
    const db = open();
    const insert = (outcome: string, refusalClass: string | null): unknown =>
      db
        .prepare(
          `INSERT INTO request_trace (id, received_at, completed_at, principal_id,
             client_request_id, transport, tool, outcome, refusal_class, served_from, created_at)
           VALUES ('01JR' || ?, 1, 1, 'local', 'req-' || ?, 'stdio', 'onchain_ping', ?, ?, 'none', 1)`,
        )
        .run(outcome, outcome, outcome, refusalClass);
    expect(() => insert('refusal', null)).toThrow(/CHECK constraint/i);
    expect(() => insert('answer', 'BudgetExceeded')).toThrow(/CHECK constraint/i);
    expect(() => insert('partial_deadline', null)).not.toThrow();
    db.close();
  });
});
