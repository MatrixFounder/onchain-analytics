import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATE_TABLES } from '../src/pg/state-client.js';

/**
 * Task 015-21 — what `sql/migrations/005_wi62_dedicated_container.sql` must be true of, checked
 * without a database. Modelled on `pg-migration-static.test.ts` (task 014-35), which does the same
 * for the pattern file, `002_t014_network_profile.sql`. That file's end-to-end assertions need a
 * live Postgres and are excluded from CI by R-21 — these are the ones that hold on the text.
 *
 * **Why a separate file rather than more `describe` blocks in the existing one.** File 005 is not a
 * revision of 002's text — it is a DIFFERENT target (a container that starts one migration earlier,
 * task-015-21's own header note) that happens to share most of the pattern. Five stated differences
 * plus schema creation (`docs/tasks/task-015-21-container-migration-grants.md`, "Форма файла
 * миграции") are exactly what these tests check FOR, and a shared file would make "check the
 * difference" and "check the file didn't drift back to the pattern" the same assertion — which is
 * backwards, since the whole point is that they differ in five/six named ways and agree everywhere
 * else.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION = 'sql/migrations/005_wi62_dedicated_container.sql';
const sql = readFileSync(path.join(repoRoot, MIGRATION), 'utf8');
const MIGRATION_004 = 'sql/migrations/004_t015_billing.sql';
const sql004 = readFileSync(path.join(repoRoot, MIGRATION_004), 'utf8');

/** The three snapshotter tables this container never holds (deployment.md §10.9.2). */
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

describe('T-015 dedicated-container migration — the grant boundary, checked on the text', () => {
  it('TC-OPS-06: none of the three forbidden grant forms appears', () => {
    const body = statements();
    expect(body, 'ALL TABLES IN SCHEMA would cover every future table too').not.toMatch(
      /GRANT[\s\S]{0,80}ON\s+ALL\s+TABLES\s+IN\s+SCHEMA/i,
    );
    expect(body, 'ALTER DEFAULT PRIVILEGES would grant every future table').not.toMatch(
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
    );
    expect(body, 'CREATE on the schema would let the running process add tables').not.toMatch(
      /GRANT[\s\S]{0,40}\bCREATE\b[\s\S]{0,20}ON\s+SCHEMA/i,
    );
  });

  it('creates the schema — unlike its pattern file, and for a stated reason', () => {
    // File 002 deliberately does NOT create the schema (its own precondition is that 001_init.sql
    // already did, on `supabase-db`). This container starts with no `onchain` schema at all
    // (measured on the dev VM ahead of writing the file), so the omission that is correct in 002
    // would make every `CREATE TABLE onchain.…` below fail here.
    expect(statements()).toMatch(/CREATE SCHEMA IF NOT EXISTS onchain;/);
  });

  it('every created object is schema-qualified, and none targets public', () => {
    const unqualified = [...statements().matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi)];
    expect(unqualified.map((m) => m[1])).toEqual([]);
    expect(statements()).not.toMatch(/\bpublic\.\w+/i);
    for (const index of statements().matchAll(/CREATE INDEX IF NOT EXISTS \w+ ON\s+([\w.]+)/gi)) {
      expect(index[1], 'index target carries its schema').toMatch(/^onchain\./);
    }
  });

  it('the state grant names exactly the thirteen tables the file creates', () => {
    const created = createdTables().sort();
    expect(created).toHaveLength(13);
    expect(stateGrantTables().sort()).toEqual(created);
    expect(created).toEqual([...STATE_TABLES].sort());
  });

  it('no snapshotter table appears in the state-role grant, and no snapshotter table is created', () => {
    for (const table of SNAPSHOTTER_TABLES) {
      expect(stateGrantTables()).not.toContain(table);
      expect(createdTables()).not.toContain(table);
    }
  });

  it('difference 1: there is no READ_ROLE parameter anywhere in this file', () => {
    // Unlike 002, this container never holds a snapshotter table, so there is nothing for a read
    // role to read (R-8.6, R-8.7) — the file names STATE_ROLE only.
    expect(statements()).not.toMatch(/READ_ROLE/);
    expect(statements()).toMatch(/:"STATE_ROLE"/);
    expect(statements(), 'a hard-coded grantee is not the same file on the next host').not.toMatch(
      /TO\s+onchain_engine_state\b/i,
    );

    // Comment-stripped: the file's own header prose mentions `CREATE TABLE onchain.…` while
    // explaining why the schema-creation statement exists, and that prose precedes `BEGIN;` too.
    const body = statements();
    const preCheck = body.slice(0, body.indexOf('BEGIN;'));
    expect(preCheck).toMatch(/\\if :\{\?STATE_ROLE\}/);
    expect(preCheck, 'the pre-check must precede the first DDL statement').not.toMatch(
      /CREATE TABLE/i,
    );
  });
});

describe('T-015 dedicated-container migration — form and order', () => {
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

  it('declares the thirteen named indexes — the ten of §4.4 plus the three of client_usage', () => {
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
        'idx_client_usage_principal',
        'idx_client_usage_terminal',
        'idx_client_usage_reserved',
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
    expect(statements()).toMatch(/CREATE SCHEMA IF NOT EXISTS/);
    expect(statements()).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });

  it('seeds the phase 0 profile with the same literal id the pattern file seeds', () => {
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

describe('T-015 dedicated-container migration — differences 4 and 5, named to match file 004', () => {
  it('difference 4: onchain.usage carries calls_made with a named, non-negative CHECK', () => {
    const usageBlock = /CREATE TABLE IF NOT EXISTS onchain\.usage\s*\(([\s\S]*?)\);/.exec(
      statements(),
    )?.[1];
    expect(usageBlock, 'onchain.usage table body').toBeDefined();
    expect(usageBlock).toMatch(/calls_made\s+BIGINT NOT NULL DEFAULT 0/);
    expect(usageBlock).toMatch(
      /CONSTRAINT usage_calls_made_non_negative CHECK \(calls_made >= 0\)/,
    );
  });

  it('difference 5: access_profiles carries a named integer-shape guard on credits_balance_raw', () => {
    const profilesBlock =
      /CREATE TABLE IF NOT EXISTS onchain\.access_profiles\s*\(([\s\S]*?)\n\);/.exec(
        statements(),
      )?.[1];
    expect(profilesBlock, 'onchain.access_profiles table body').toBeDefined();
    expect(profilesBlock).toMatch(
      /CONSTRAINT client_usage_balance_is_integer\s*\n?\s*CHECK \(credits_balance_raw IS NULL OR credits_balance_raw ~ '\^-\?\[0-9\]\+\$'\)/,
    );
  });

  it('both named constraints match file 004 exactly, by name — the TC-OPS-09 precondition', () => {
    // TC-OPS-09's postcondition ("applying 004 after 005 changes nothing") holds only if 004's own
    // `pg_constraint` guard finds a constraint already registered under the SAME name and skips its
    // `ALTER TABLE`. A name that merely resembles 004's would not match, and 004 would then add a
    // SECOND, redundant constraint on its second application against this container.
    for (const name of ['usage_calls_made_non_negative', 'client_usage_balance_is_integer']) {
      expect(sql, `${name} appears in file 005`).toContain(name);
      expect(sql004, `${name} appears in file 004`).toContain(name);
    }
  });

  it('client_usage is created directly here, with the same shape file 004 declares', () => {
    const clientUsageBlock005 =
      /CREATE TABLE IF NOT EXISTS onchain\.client_usage\s*\(([\s\S]*?)\);/.exec(statements())?.[1];
    const clientUsageBlock004 =
      /CREATE TABLE IF NOT EXISTS onchain\.client_usage\s*\(([\s\S]*?)\);/.exec(
        sql004
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n'),
      )?.[1];
    expect(clientUsageBlock005).toBeDefined();
    expect(clientUsageBlock004).toBeDefined();
    // Column and constraint names, not whitespace: the two blocks are authored independently (005
    // cannot literally include 004, since 004's own precondition is that the twelve T-014 tables
    // already exist) but must describe the identical table.
    const tokens = (block: string): string[] =>
      (block.match(/\b\w+\b/g) ?? []).filter((t) => t.length > 1);
    expect(tokens(clientUsageBlock005 ?? '').sort()).toEqual(
      tokens(clientUsageBlock004 ?? '').sort(),
    );
  });
});
