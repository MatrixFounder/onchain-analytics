import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DDL } from '../src/cache/ddl.js';

/**
 * Task 015-03 — the Postgres axis of T-015's billing ledger, checked against its own text and
 * against the SQLite axis `cache/ddl.ts` already declares (task 015-02).
 *
 * **Why this reads `sql/migrations/004_t015_billing.sql` rather than editing
 * `engine-axes-agree.test.ts`.** That existing test reads `002_t014_network_profile.sql`
 * (`engine-axes-agree.test.ts:29-32`), and `client_usage` lives in file 004 — a test reading two
 * files for one table would lose its own claim about the eight T-014 tables it already covers. This
 * file is `client_usage`'s home instead.
 *
 * **What the R-21 boundary means here.** No live Postgres runs in CI, so every assertion below reads
 * the SHIPPED SQL text — the same static-check discipline `pg-migration-static.test.ts` already
 * applies to migrations 002/003. A live-container measurement (TC-OPS-09, the idempotency re-run) is
 * out of this file's reach by design and belongs to tasks 015-21/015-24.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION_004 = 'sql/migrations/004_t015_billing.sql';
const migration = readFileSync(path.join(repoRoot, MIGRATION_004), 'utf8');

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** The body of one `CREATE TABLE IF NOT EXISTS <qualifier><table> ( ... );` statement. */
const tableBody = (sql: string, table: string, qualifier: string): string => {
  const pattern = new RegExp(
    `CREATE TABLE IF NOT EXISTS\\s+${qualifier}${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i',
  );
  return pattern.exec(stripComments(sql))?.[1] ?? '';
};

/** Column DECLARATION lines of a `CREATE TABLE` body, table constraints excluded — the same split
 * `engine-axes-agree.test.ts`'s own `columnsOf` makes, reproduced here rather than imported: that
 * file is T-014's own conformance test and this one is T-015's, and importing a helper across that
 * boundary would give one file two owners. */
const columnLines = (body: string): string[] =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY)\b/i.test(line));

const columnNames = (body: string): string[] =>
  columnLines(body)
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((name) => name !== '');

/** The type token of one column declaration, with a trailing comma stripped: a column with no
 * further modifier (`terminal_at INTEGER,`) has the comma glued to the type token, and a column
 * followed by `NOT NULL,` does not — the comma must not become part of the type either way. */
const columnType = (body: string, column: string): string | undefined =>
  columnLines(body)
    .find((line) => line.split(/\s+/)[0] === column)
    ?.split(/\s+/)[1]
    ?.replace(/,$/, '');

/** The canonical thirteen columns of `data-model.md` §4.6.1, in declared order. */
const CLIENT_USAGE_COLUMNS = [
  'id',
  'principal_id',
  'access_profile_id',
  'client_request_id',
  'tool',
  'capability',
  'price_raw',
  'state',
  'refund_reason',
  'reserved_at',
  'terminal_at',
  'created_at',
  'updated_at',
] as const;

describe('client_usage (data-model.md §4.6.1) — the Postgres declaration', () => {
  it('TC-UNIT-01: declares the thirteen columns of §4.6.1, and price_raw as TEXT NOT NULL', () => {
    const body = tableBody(migration, 'client_usage', 'onchain\\.');
    expect(columnNames(body)).toEqual([...CLIENT_USAGE_COLUMNS]);
    expect(columnType(body, 'price_raw')).toBe('TEXT');
    expect(body).toMatch(/price_raw\s+TEXT NOT NULL/);

    // Falls if TEXT is replaced with BIGINT (§1.7 canon: credits exceed the safe 2^53 of a number).
    const mutated = migration.replace(
      'price_raw          TEXT NOT NULL,',
      'price_raw          BIGINT NOT NULL,',
    );
    expect(mutated).not.toBe(migration);
    expect(columnType(tableBody(mutated, 'client_usage', 'onchain\\.'), 'price_raw')).not.toBe(
      'TEXT',
    );
  });

  it('TC-UNIT-02: the dedup key is UNIQUE (principal_id, client_request_id), with no received_at (R-5.1, AC-12)', () => {
    const body = tableBody(migration, 'client_usage', 'onchain\\.');
    expect(body).toMatch(/UNIQUE\s*\(principal_id,\s*client_request_id\)/);
    expect(body).not.toMatch(/UNIQUE\s*\([^)]*received_at[^)]*\)/);

    // Falls if a third component (received_at) is added to the key — a retry would then charge
    // twice, the exact defect R-5.1 forbids.
    const mutated = body.replace(
      'UNIQUE (principal_id, client_request_id)',
      'UNIQUE (principal_id, client_request_id, received_at)',
    );
    expect(mutated).not.toBe(body);
    expect(/UNIQUE\s*\([^)]*received_at[^)]*\)/.test(mutated)).toBe(true);
  });

  it('TC-UNIT-03: three CHECK constraints and three indexes are declared by name', () => {
    const body = tableBody(migration, 'client_usage', 'onchain\\.');
    expect((body.match(/CHECK\s*\(/gi) ?? []).length).toBe(3);
    expect(body).toMatch(/CHECK \(state IN \('reserved','settled','refunded'\)\)/);
    expect(body).toMatch(/CHECK \(\(state = 'refunded'\) = \(refund_reason IS NOT NULL\)\)/);
    expect(body).toMatch(/CHECK \(\(state = 'reserved'\) = \(terminal_at IS NULL\)\)/);

    const indexNames = [
      ...migration.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON onchain\.client_usage/gi),
    ].map((m) => m[1]);
    expect(indexNames.sort()).toEqual(
      [
        'idx_client_usage_principal',
        'idx_client_usage_terminal',
        'idx_client_usage_reserved',
      ].sort(),
    );
  });
});

describe('usage.calls_made (data-model.md §4.6.3) — the additive column', () => {
  it('TC-UNIT-04: added via ALTER TABLE ... ADD COLUMN with DEFAULT 0, and CHECK (calls_made >= 0) declared alongside', () => {
    expect(migration).toMatch(
      /ALTER TABLE onchain\.usage ADD COLUMN IF NOT EXISTS calls_made BIGINT NOT NULL DEFAULT 0;/,
    );
    expect(migration).toContain('CHECK (calls_made >= 0)');
    // The CHECK is a NAMED table constraint, guarded — Postgres 16 has no
    // `ADD CONSTRAINT IF NOT EXISTS`, so a bare re-run would fail the second time without the guard.
    expect(migration).toMatch(
      /ADD CONSTRAINT usage_calls_made_non_negative CHECK \(calls_made >= 0\)/,
    );
    expect(migration).toMatch(
      /pg_constraint[\s\S]{0,120}conname = 'usage_calls_made_non_negative'/,
    );
  });
});

describe('the grant (deployment.md §10.5.1, §10.9.3)', () => {
  it('TC-UNIT-05: names client_usage, and none of the three forbidden grant forms appear (mirrors pg-migration-static.test.ts:49-63)', () => {
    const body = stripComments(migration);
    expect(body).toMatch(
      /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+onchain\.client_usage\s+TO\s+:"STATE_ROLE"/i,
    );
    expect(body, 'ALL TABLES IN SCHEMA would cover every future table').not.toMatch(
      /GRANT[\s\S]{0,80}ON\s+ALL\s+TABLES\s+IN\s+SCHEMA/i,
    );
    expect(body, 'ALTER DEFAULT PRIVILEGES would grant every future table').not.toMatch(
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
    );
    expect(body, 'CREATE on the schema would let the running process add tables').not.toMatch(
      /GRANT[\s\S]{0,40}\bCREATE\b[\s\S]{0,20}ON\s+SCHEMA/i,
    );
  });
});

describe('MINOR-7 — access_profiles.credits_balance_raw format guard', () => {
  const predicateSource =
    /credits_balance_raw\s+IS\s+NULL\s+OR\s+credits_balance_raw\s+~\s+'([^']+)'/.exec(
      migration,
    )?.[1];

  it('the predicate is present in the shipped SQL', () => {
    expect(
      predicateSource,
      'the format CHECK predicate is declared in migration 004',
    ).toBeDefined();
  });

  it('TC-UNIT-06: accepts an integer-shaped string, rejects everything else', () => {
    const pattern = new RegExp(predicateSource as string);
    expect(pattern.test('12')).toBe(true);
    expect(pattern.test('-3')).toBe(true);
    expect(pattern.test('NaN')).toBe(false);
    expect(pattern.test('1.5')).toBe(false);
    expect(pattern.test('')).toBe(false);
  });

  it('TC-UNIT-04 (MINOR-7 twin): the CHECK is also a guarded named constraint', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT client_usage_balance_is_integer[\s\S]{0,40}CHECK \(credits_balance_raw/,
    );
    expect(migration).toMatch(/conname = 'client_usage_balance_is_integer'/);
  });
});

describe('MAJOR-F — where the ledger is allowed to live', () => {
  const header = migration.slice(0, migration.indexOf('BEGIN;'));
  // The header is hand-wrapped `--`-prefixed prose, so a phrase can straddle a line break with the
  // next line's `-- ` prefix sitting between two words. Flattened to one line, comment markers
  // stripped, so a phrase-level match does not depend on where the author happened to wrap the text.
  const headerFlat = header
    .split('\n')
    .map((line) => line.replace(/^--\s?/, ''))
    .join(' ');
  const deployment = readFileSync(path.join(repoRoot, 'docs/architectures/deployment.md'), 'utf8');

  it('TC-UNIT-07: the migration header names the T-014 target and denies application to supabase-db', () => {
    expect(headerFlat).toMatch(/twelve\s+T-014\s+engine\s+tables/i);
    expect(headerFlat).toMatch(/supabase-db/);
    expect(headerFlat).toMatch(/FORBIDDEN|DO NOT RUN THIS AGAINST/i);
  });

  it('the header names the same rollout destination as task 015-21: file 005, not this file, creates the new container', () => {
    expect(headerFlat).toMatch(/005_wi62_dedicated_container\.sql/);
    expect(headerFlat, 'task 015-21 is named as the file 005 owner').toMatch(/015-21/);
  });

  it('deployment.md §10.9.4 and §10.9.7 carry the SAME precondition — client_usage lives only on the new container', () => {
    const s4Start = deployment.indexOf('#### 10.9.4');
    const s4End = deployment.indexOf('#### 10.9.5');
    const s7Start = deployment.indexOf('#### 10.9.7');
    const s7End = deployment.indexOf('#### 10.9.8');
    expect(s4Start).toBeGreaterThan(-1);
    expect(s7Start).toBeGreaterThan(-1);
    const section494 = deployment.slice(s4Start, s4End);
    const section497 = deployment.slice(s7Start, s7End);
    for (const [name, section] of [
      ['§10.9.4', section494],
      ['§10.9.7', section497],
    ] as const) {
      expect(section, `${name} names client_usage`).toMatch(/client_usage/);
      expect(section, `${name} names supabase-db`).toMatch(/supabase-db|old container/i);
      expect(section, `${name} states the MAJOR-F precondition`).toMatch(/MAJOR-F/);
    }
  });

  it('§10.9.7 no longer claims the OLD container drops a thirteenth table it never had', () => {
    // The old container is never migrated by 004 (MAJOR-F), so it carries the TWELVE tables of
    // migration 002 — never client_usage. §10.9.7 must count what it actually drops there.
    const s7Start = deployment.indexOf('#### 10.9.7');
    const s7End = deployment.indexOf('#### 10.9.8');
    const section = deployment.slice(s7Start, s7End);
    expect(section).not.toMatch(/thirteen engine tables are dropped from the OLD container/i);
    expect(section).toMatch(/twelve engine tables are dropped from the OLD container/i);
  });
});

describe('dialect parity — client_usage on both axes (DB-SCHEMA-CONCEPT §5 type map)', () => {
  const TYPE_MAP: Record<string, string> = { TEXT: 'TEXT', INTEGER: 'BIGINT' };

  it('TC-UNIT-08: the same column names, in the same order, with the mapped type each column has', () => {
    const pgBody = tableBody(migration, 'client_usage', 'onchain\\.');
    const sqliteBody = tableBody(CACHE_DDL, 'client_usage', '');
    expect(
      columnNames(sqliteBody),
      'client_usage parsed to no columns on the SQLite axis',
    ).not.toEqual([]);
    expect(columnNames(pgBody)).toEqual(columnNames(sqliteBody));
    for (const name of CLIENT_USAGE_COLUMNS) {
      const sqliteType = columnType(sqliteBody, name);
      const pgType = columnType(pgBody, name);
      expect(sqliteType, `${name} missing on the SQLite axis`).toBeDefined();
      const expected = TYPE_MAP[sqliteType as string] ?? sqliteType;
      expect(pgType, `${name}: SQLite declares ${sqliteType}, Postgres declares ${pgType}`).toBe(
        expected,
      );
    }
  });

  it('detects a column added on one axis only — the drift this test exists to catch', () => {
    // `capability` also names a column on `request_trace`/`diagnostics` earlier in CACHE_DDL, so the
    // mutation is applied to the ALREADY-EXTRACTED client_usage body, never to the whole file — a
    // file-wide replace would silently strike the wrong table's column and pass for the wrong reason.
    const sqliteBody = tableBody(CACHE_DDL, 'client_usage', '');
    const mutatedBody = sqliteBody.replace(/\n\s*capability\s+TEXT,[^\n]*/, '');
    expect(mutatedBody).not.toBe(sqliteBody);
    expect(columnNames(mutatedBody)).not.toEqual(
      columnNames(tableBody(migration, 'client_usage', 'onchain\\.')),
    );
  });

  it('TC-UNIT-09: the credits_balance_raw format CHECK is intentionally Postgres-only', () => {
    // Migration 004 declares it; CACHE_DDL (the SQLite axis, task 015-02, owned there) does not, and
    // the asymmetry is deliberate — SQLite's arithmetic already runs in BigInt, and `BigInt('NaN')`
    // throws by construction, so the refusal exists on that axis without any added constraint
    // (data-model.md §4.6.1, migration 004's own comment beside the constraint).
    expect(migration, 'the format CHECK is declared on the Postgres axis').toContain(
      'client_usage_balance_is_integer',
    );
    expect(
      CACHE_DDL,
      'the SQLite axis carries no equivalent named constraint — deliberately',
    ).not.toContain('client_usage_balance_is_integer');
  });
});

describe('STATE_TABLES docstring (packages/core/src/pg/state-client.ts) — the third of three counters', () => {
  const stateClientPath = path.join(repoRoot, 'packages/core/src/pg/state-client.ts');
  const stateClientSrc = readFileSync(stateClientPath, 'utf8');
  const declStart = stateClientSrc.indexOf('export const STATE_TABLES');
  const docStart = stateClientSrc.lastIndexOf('/**', declStart);
  const listEnd = stateClientSrc.indexOf('] as const;', declStart) + '] as const;'.length;
  const section = stateClientSrc.slice(docStart, listEnd);

  it('TC-UNIT-13: the docstring number equals the list length, and the stale "twelve" wording is gone', () => {
    expect(declStart).toBeGreaterThan(-1);
    expect(docStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(declStart);
    const names = [...stateClientSrc.slice(declStart, listEnd).matchAll(/'(\w+)'/g)];
    expect(names).toHaveLength(13);
    expect(section, 'a mutation that adds a name without re-counting the docstring').not.toMatch(
      /The twelve engine tables/,
    );
    expect(section).toMatch(/The thirteen engine tables/);
  });

  it('the docstring says the comparison reads the union of migrations 002 and 004', () => {
    expect(section).toMatch(/is compared against/);
    expect(section).toMatch(/002_t014_network_profile\.sql/);
    expect(section).toMatch(/004_t015_billing\.sql/);
  });
});
