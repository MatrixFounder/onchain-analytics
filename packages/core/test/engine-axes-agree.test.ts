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
 * **What this compares and what it deliberately does not.** Table names, column names and `CHECK`
 * bodies, per table. Not types: the axes differ there on purpose (§4.5.1 maps `INTEGER` to `BIGINT`
 * and `REAL` to `DOUBLE PRECISION`), and asserting equality would forbid the mapping the canon
 * requires. Not the append-only guard: SQLite has no rules, so it spells with two triggers what
 * Postgres spells with a rule and a trigger — a difference of dialect, not of intent.
 *
 * **`CHECK` bodies were exempted in the first revision, and that exemption cost a defect within the
 * day.** `onchain.usage` shipped without the `CHECK (credits_used >= 0)` its SQLite twin carries;
 * the engine-level seatbelt was missing on one axis while both files passed their own gates. The
 * reasoning for the exemption — "the two dialects need not spell every guard identically" — is true
 * of the audit guard and false of a column predicate, and the gate had inherited the wrong half.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = readFileSync(
  path.join(repoRoot, 'sql/migrations/002_t014_network_profile.sql'),
  'utf8',
);

/**
 * T-015 (task 015-03, migration 004) adds `usage.calls_made` — and its `CHECK (calls_made >= 0)` —
 * via a SEPARATE file rather than editing 002 in place: 002 is already live on the dev VM
 * (`deployment.md`:706, "live on the dev VM"), so its text stays a historical record rather than
 * something this repository edits after the fact. `checksOf` below only looks inside a `CREATE
 * TABLE` body, so it cannot see a CHECK added by a later `ALTER TABLE`; `alterAddedChecksOf` reads
 * that ALTER form instead, and is merged into ONLY the `usage` comparison below — the same UNION
 * `packages/core/test/pg-store-parity.test.ts`'s STATE_TABLES check reads for the thirteenth table
 * name (TC-UNIT-11).
 */
const migration004 = readFileSync(
  path.join(repoRoot, 'sql/migrations/004_t015_billing.sql'),
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

/** The four counter tables of §4.2.4 — also declared on both axes, also comparable. */
const COUNTER_TABLES = ['providers', 'cache_entries', 'usage', 'usage_window'] as const;

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

/**
 * The `CHECK` predicates of one table, normalised so only the predicate itself is compared.
 *
 * Whitespace is collapsed and the trailing comma dropped: the two files lay their columns out
 * differently, and a gate that failed on alignment would be noise rather than a guard.
 */
const checksOf = (sql: string, table: string, qualifier: string): string[] => {
  const pattern = new RegExp(
    `CREATE TABLE IF NOT EXISTS\\s+${qualifier}${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i',
  );
  // The captured body stops before the closing `\n);`, so the LAST constraint of a table has no
  // newline behind it. A lookahead for one silently dropped it on every table — which made this
  // comparison pass on the very defect it was added for. One appended newline is the whole fix.
  const body = `${pattern.exec(stripComments(sql))?.[1] ?? ''}\n`;
  return [...body.matchAll(/CHECK\s*(\([\s\S]*?\))\s*,?\s*(?=\n)/gi)]
    .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
    .sort();
};

/**
 * `CHECK` predicates a LATER migration adds to an EXISTING table via a guarded
 * `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`, rather than inside the table's original
 * `CREATE TABLE` (`checksOf`'s own blind spot, see the `migration004` note above).
 *
 * Deliberately NOT merged into every table's comparison — only `usage`'s, below. Migration 004 also
 * adds a `CHECK` to `access_profiles` (MINOR-7, `credits_balance_raw`'s format guard), and THAT one
 * is Postgres-only ON PURPOSE (`ddl-dialect-parity.test.ts`, TC-UNIT-09): merging it in here would
 * make this file assert the asymmetry is a defect, contradicting the test that asserts it is
 * deliberate.
 */
const alterAddedChecksOf = (sql: string, table: string, qualifier: string): string[] => {
  const pattern = new RegExp(
    `ALTER TABLE\\s+${qualifier}${table}\\s+ADD CONSTRAINT\\s+\\w+\\s+(CHECK\\s*\\([\\s\\S]*?\\))\\s*;`,
    'gi',
  );
  return [...stripComments(sql).matchAll(pattern)].map((m) =>
    (m[1] ?? '')
      .replace(/^CHECK\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
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

  it.each([...ENGINE_TABLES, ...COUNTER_TABLES])(
    '%s declares the same CHECK predicates on both axes',
    (table) => {
      // ONLY `usage` gets migration 004's ALTER-added CHECK merged in (see `alterAddedChecksOf`'s
      // own note) — every other table's comparison is exactly what it was before T-015.
      const postgresChecks =
        table === 'usage'
          ? [
              ...checksOf(migration, table, 'onchain\\.'),
              ...alterAddedChecksOf(migration004, table, 'onchain\\.'),
            ].sort()
          : checksOf(migration, table, 'onchain\\.');
      expect(checksOf(CACHE_DDL, table, ''), `${table} CHECK predicates differ`).toEqual(
        postgresChecks,
      );
    },
  );

  it('detects a CHECK present on one axis only — the defect the first revision let through', () => {
    const mutated = migration.replace('  CHECK (credits_used >= 0)\n', '');
    expect(checksOf(mutated, 'usage', 'onchain\\.')).not.toEqual(checksOf(CACHE_DDL, 'usage', ''));
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
