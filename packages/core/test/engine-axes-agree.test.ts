import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DDL } from '../src/cache/ddl.js';

/**
 * The two storage axes declare the same engine tables with the same columns.
 *
 * Task 014-35 declares them for Postgres, task 014-36 for SQLite. Each task checks its own file, and
 * neither compares the two — so a column added to one axis and forgotten on the other passes both
 * gates. The profile `network-sqlite` exists precisely to debug the transport against SQLite before
 * switching to Postgres, which means a divergence here shows up as "works in debugging, fails in
 * production" — the most expensive shape a schema defect can take.
 *
 * **What this compares and what it deliberately does not.** Table names and column names, per table.
 * Not types: the axes differ there on purpose (§4.5.1 maps `INTEGER` to `BIGINT` and `REAL` to
 * `DOUBLE PRECISION`), and asserting equality would forbid the mapping the canon requires. Not
 * constraints: `CHECK` text is the same in both today, but SQLite and Postgres do not have to spell
 * every guard identically — the audit guard already differs by construction.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = readFileSync(
  path.join(repoRoot, 'sql/migrations/002_t014_network_profile.sql'),
  'utf8',
);

/** The eight tables of §4.5 — the ones both axes must carry. */
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

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/**
 * Column names of one `CREATE TABLE` body, table constraints excluded.
 *
 * A line opening with `UNIQUE`, `CHECK`, `PRIMARY KEY` or `FOREIGN KEY` is a table constraint, not a
 * column; taking the first word blindly would compare constraint keywords as if they were columns
 * and pass whenever both axes happened to carry the same number of them.
 */
const columnsOf = (sql: string, table: string, qualifier: string): string[] => {
  const pattern = new RegExp(
    `CREATE TABLE IF NOT EXISTS\\s+${qualifier}${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i',
  );
  const body = pattern.exec(stripComments(sql))?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY)\b/i.test(line))
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((name) => name !== '')
    .sort();
};

describe('the two storage axes declare the same engine schema', () => {
  it('both axes carry all eight tables of §4.5', () => {
    for (const table of ENGINE_TABLES) {
      expect(migration, `${table} missing from the Postgres axis`).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS\\s+onchain\\.${table}\\b`, 'i'),
      );
      expect(CACHE_DDL, `${table} missing from the SQLite axis`).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, 'i'),
      );
    }
  });

  it.each(ENGINE_TABLES)('%s declares the same columns on both axes', (table) => {
    const postgres = columnsOf(migration, table, 'onchain\\.');
    const sqlite = columnsOf(CACHE_DDL, table, '');
    expect(postgres.length, `${table} parsed to no columns on the Postgres axis`).toBeGreaterThan(
      0,
    );
    expect(sqlite, `${table} column sets differ between the axes`).toEqual(postgres);
  });

  it('both axes seed the phase 0 profile under the SAME literal id', () => {
    const idOf = (sql: string): string | undefined =>
      /'(01J[0-9A-HJKMNP-TV-Z]{23})'/.exec(stripComments(sql))?.[1];
    const fromMigration = idOf(migration);
    expect(fromMigration, 'the Postgres axis seeds a ULID literal').toBeDefined();
    expect(idOf(CACHE_DDL), 'two ids for one entity dangle a token on one host').toBe(
      fromMigration,
    );
  });

  it('detects a column present on one axis only — the drift this exists to catch', () => {
    const mutated = CACHE_DDL.replace('  session_id   TEXT,\n', '');
    expect(columnsOf(mutated, 'diagnostics', '')).not.toEqual(
      columnsOf(migration, 'diagnostics', 'onchain\\.'),
    );
  });
});
