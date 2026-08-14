import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 014-35 — what the Postgres migration must be true of, checked without a database.
 *
 * The end-to-end assertions of that task need a live Postgres and are therefore excluded from CI by
 * R-21. These are the ones that hold on the file's text, and they are deliberately the ones about
 * the grant boundary: an over-broad grant is the failure this milestone can least afford, and it is
 * fully visible in the SQL.
 *
 * **Why the migration is parsed rather than pattern-matched loosely.** Both the DDL set and the
 * grant set are extracted and compared as sets. A regex that merely looked for "GRANT" would pass a
 * file that granted eleven of twelve tables, which is the drift these assertions exist to catch.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION = 'sql/migrations/002_t014_network_profile.sql';
const sql = readFileSync(path.join(repoRoot, MIGRATION), 'utf8');

/** The three snapshotter tables the engine's state role must never reach (deployment.md §10.5.1). */
const SNAPSHOTTER_TABLES = ['assets', 'metrics', 'snapshots'] as const;

/** Statements only, with `--` comments stripped: a forbidden form quoted in a comment is prose. */
const statements = (): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const createdTables = (): string[] =>
  [...statements().matchAll(/CREATE TABLE IF NOT EXISTS\s+onchain\.(\w+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );

/** The tables named in the state role's DML grant — the single multi-table GRANT of the file. */
const stateGrantTables = (): string[] => {
  const grant =
    /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON([\s\S]*?)TO\s+:"STATE_ROLE"/i.exec(
      statements(),
    );
  return [...(grant?.[1] ?? '').matchAll(/onchain\.(\w+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
};

describe('T-014 Postgres migration — the grant boundary, checked on the text', () => {
  it('TC-UNIT-01: none of the three forbidden grant forms appears', () => {
    const body = statements();
    expect(body, 'ALL TABLES IN SCHEMA would cover the snapshotter tables').not.toMatch(
      /GRANT[\s\S]{0,80}ON\s+ALL\s+TABLES\s+IN\s+SCHEMA/i,
    );
    expect(body, 'ALTER DEFAULT PRIVILEGES would grant every future table').not.toMatch(
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
    );
    expect(body, 'CREATE on the schema would let the running process add tables').not.toMatch(
      /GRANT[\s\S]{0,40}\bCREATE\b[\s\S]{0,20}ON\s+SCHEMA/i,
    );
  });

  it('TC-UNIT-02: CREATE SCHEMA is absent in every spelling', () => {
    expect(statements()).not.toMatch(/CREATE\s+SCHEMA/i);
  });

  it('TC-UNIT-03: every created object is schema-qualified, and none targets public', () => {
    const unqualified = [...statements().matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi)];
    expect(unqualified.map((m) => m[1])).toEqual([]);
    expect(statements()).not.toMatch(/\bpublic\.\w+/i);
    for (const index of statements().matchAll(/CREATE INDEX IF NOT EXISTS \w+ ON\s+([\w.]+)/gi)) {
      expect(index[1], 'index target carries its schema').toMatch(/^onchain\./);
    }
  });

  it('TC-UNIT-04: the state grant names exactly the tables the file creates', () => {
    const created = createdTables().sort();
    expect(created).toHaveLength(12);
    expect(stateGrantTables().sort()).toEqual(created);
  });

  it('TC-UNIT-04b: no snapshotter table appears in any state-role grant', () => {
    for (const table of SNAPSHOTTER_TABLES) {
      expect(stateGrantTables()).not.toContain(table);
    }
    const readGrant = /GRANT\s+SELECT\s+ON([\s\S]*?)TO\s+:"READ_ROLE"/i.exec(statements());
    const readTables = [...(readGrant?.[1] ?? '').matchAll(/onchain\.(\w+)/gi)].map((m) => m[1]);
    expect(readTables.sort()).toEqual([...SNAPSHOTTER_TABLES].sort());
  });

  it('TC-UNIT-04c: no engine table appears in the read role grant — the reverse direction', () => {
    const readGrant = /GRANT\s+SELECT\s+ON([\s\S]*?)TO\s+:"READ_ROLE"/i.exec(statements());
    const readTables = [...(readGrant?.[1] ?? '').matchAll(/onchain\.(\w+)/gi)].map((m) =>
      (m[1] ?? '').toLowerCase(),
    );
    for (const engineTable of createdTables()) {
      expect(readTables, `${engineTable} must not be readable by the read role`).not.toContain(
        engineTable,
      );
    }
  });

  it('TC-UNIT-05: both role names are parameters, and the pre-check names both', () => {
    expect(statements()).toMatch(/:"STATE_ROLE"/);
    expect(statements()).toMatch(/:"READ_ROLE"/);
    expect(statements(), 'a hard-coded grantee is not the same file on the next host').not.toMatch(
      /TO\s+onchain_engine_state\b/i,
    );

    const preCheck = sql.slice(0, sql.indexOf('BEGIN;'));
    expect(preCheck).toMatch(/\\if :\{\?STATE_ROLE\}/);
    expect(preCheck).toMatch(/\\if :\{\?READ_ROLE\}/);
    expect(preCheck, 'the pre-check must precede the first DDL statement').not.toMatch(
      /CREATE TABLE/i,
    );
  });
});

describe('T-014 Postgres migration — form and order', () => {
  it('creates providers before every table that references it', () => {
    const body = statements();
    const providersAt = body.indexOf('CREATE TABLE IF NOT EXISTS onchain.providers');
    expect(providersAt).toBeGreaterThan(-1);
    for (const dependent of ['cache_entries', 'usage', 'usage_window', 'provider_buckets']) {
      expect(
        body.indexOf(`CREATE TABLE IF NOT EXISTS onchain.${dependent}`),
        `${dependent} references providers`,
      ).toBeGreaterThan(providersAt);
    }
  });

  it('creates users and access_profiles before api_tokens, which references both', () => {
    const body = statements();
    const tokensAt = body.indexOf('CREATE TABLE IF NOT EXISTS onchain.api_tokens');
    expect(body.indexOf('CREATE TABLE IF NOT EXISTS onchain.users')).toBeLessThan(tokensAt);
    expect(body.indexOf('CREATE TABLE IF NOT EXISTS onchain.access_profiles')).toBeLessThan(
      tokensAt,
    );
  });

  it('declares the ten named indexes of §4.4', () => {
    const declared = [...statements().matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/gi)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(
      [
        'idx_access_audit_actor',
        'idx_access_audit_target',
        'idx_access_audit_ts',
        'idx_api_tokens_user',
        'idx_diagnostics_event_ts',
        'idx_diagnostics_ts',
        'idx_request_trace_principal',
        'idx_request_trace_received',
        'idx_request_trace_spend',
        'idx_retention_runs_job',
      ].sort(),
    );
  });

  it('uses only the Postgres side of the §4.5.1 type map', () => {
    const body = statements();
    expect(body, 'INTEGER maps to BIGINT in this dialect').not.toMatch(/\bINTEGER\b/);
    expect(body, 'REAL maps to DOUBLE PRECISION in this dialect').not.toMatch(/\bREAL\b/);
  });

  it('spells NOT NULL beside every ULID PRIMARY KEY (§4.5.2a)', () => {
    for (const declaration of statements().matchAll(/(\w+)\s+TEXT PRIMARY KEY([^,\n]*)/gi)) {
      expect(declaration[2], `${declaration[1]} PRIMARY KEY without NOT NULL`).toMatch(/NOT NULL/);
    }
  });

  it('is re-runnable: every table, index and seed is conditional', () => {
    const creates = [...statements().matchAll(/CREATE (TABLE|INDEX)\s+(IF NOT EXISTS)?/gi)];
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create[2], `CREATE ${create[1]} without IF NOT EXISTS`).toBeDefined();
    }
    expect(statements()).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });

  it('seeds the phase 0 profile with the literal id task 014-36 also seeds', () => {
    expect(statements()).toMatch(/'01JPHASE00000000000000000A'/);
    expect(statements()).toMatch(/'phase0-unlimited'/);
  });

  it('guards the audit log against update and delete (§4.5.5)', () => {
    expect(statements()).toMatch(/ON DELETE TO onchain\.access_audit DO INSTEAD NOTHING/i);
    expect(statements()).toMatch(/BEFORE UPDATE ON onchain\.access_audit/i);
  });

  it('measures the state role with has_table_privilege, never the catalogue view', () => {
    expect(statements()).toMatch(/has_table_privilege\(:'STATE_ROLE'/);
    expect(statements(), 'the view is blind to PUBLIC and to inherited grants').not.toMatch(
      /role_table_grants/i,
    );
  });
});
