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

/**
 * Task 014-37 — the admin seed migration, checked on its text.
 *
 * Its end-to-end assertions need a live Postgres and are excluded from CI by R-21, like 002's; the
 * integration set is run where `docs/tasks/task-014-34-acceptance.md` declares it. What holds on the
 * text is everything about the SECRET: that no digest is written into the file, that every value the
 * installation owns arrives as a parameter, and that the file stops before its first write when one
 * is missing.
 *
 * **Why this lives beside 002's checks rather than in `mcp-server`.** One home for the static checks
 * over `sql/migrations/`, so the next migration is checked by a file somebody already opens.
 */
const SEED = 'sql/migrations/003_seed_engine_admin.sql';
const seedSql = readFileSync(path.join(repoRoot, SEED), 'utf8');
const seedStatements = seedSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const SEED_PARAMETERS = [
  'ADMIN_EMAIL',
  'ADMIN_TOKEN_SHA256',
  'ADMIN_TOKEN_PREFIX',
  'ADMIN_USER_ID',
  'ADMIN_TOKEN_ID',
] as const;

describe('T-014 admin seed migration — the secret never reaches the file', () => {
  it('TC-UNIT-01: carries no digest literal', () => {
    // A token in a migration file is a token in git history, and a DIGEST literal is the same
    // mistake one step later: it pins one installation's credential into the repository, where it
    // would be applied to every other installation that ran the file.
    const hex64 = /\b[0-9a-fA-F]{64}\b/g;
    expect(seedStatements.match(hex64) ?? [], 'a 64-hex literal is a digest').toStrictEqual([]);
    // Not vacuous: the pattern does catch what it forbids.
    expect(hex64.test(`token_hash = '${'a'.repeat(64)}'`)).toBe(true);
  });

  it('carries no token-shaped literal either', () => {
    // The `oi_` form of §7.5.2. The digest check above would not see a plaintext token, and a file
    // that pasted one would be handing out a working credential to every reader of this repository.
    expect(seedStatements).not.toMatch(/'oi_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}'/);
  });

  it('takes every installation-local value as a parameter', () => {
    for (const parameter of SEED_PARAMETERS) {
      expect(seedStatements, `${parameter} is used`).toContain(`:'${parameter}'`);
    }
  });

  it('stops before its first write when a parameter is missing', () => {
    // The pre-check block, one `\if :{?VAR}` per parameter, ahead of `BEGIN`. Without it an unset
    // variable fails at the statement that uses it — after the `users` row was already written.
    const firstWrite = seedSql.indexOf('BEGIN;');
    expect(firstWrite).toBeGreaterThan(0);
    const preamble = seedSql.slice(0, firstWrite);
    for (const parameter of SEED_PARAMETERS) {
      expect(preamble, `${parameter} is pre-checked`).toContain(`\\if :{?${parameter}}`);
      expect(preamble, `the refusal names ${parameter}`).toContain(parameter);
    }
    // Counted on the RAISE, not on `\quit 1` (L-28, fixed 2026-08-28). `\quit` takes no exit
    // status before PostgreSQL 17, so the old form printed its reason and exited 0 — the guard
    // halted correctly and reported success. This count is what makes "one refusal per parameter"
    // an assertion rather than a comment; `pg-migration-guards.test.ts` owns the FORM of the
    // refusal across all five files, this owns the ARITY of it for the seed's own parameters.
    expect((preamble.match(/RAISE EXCEPTION 'FATAL:/g) ?? []).length).toBeGreaterThanOrEqual(
      SEED_PARAMETERS.length,
    );
    expect(preamble, 'the guard must not depend on the caller passing the flag').toContain(
      '\\set ON_ERROR_STOP on',
    );
  });

  it('interpolates no psql variable inside a dollar-quoted string', () => {
    // psql does not substitute its variables inside `$tag$ … $tag$`, so `:'ADMIN_EMAIL'` written
    // there would reach the server verbatim and fail as an undefined parameter — after reading
    // correctly in review. The first draft of this file had exactly that, in a `DO` block.
    const dollarQuoted = [...seedSql.matchAll(/\$(\w*)\$([\s\S]*?)\$\1\$/g)].map((m) => m[2] ?? '');
    for (const body of dollarQuoted) {
      expect(
        body,
        'a psql variable inside a dollar-quoted string is never substituted',
      ).not.toMatch(/:'?\w+'?/);
    }
  });
});

describe('T-014 admin seed migration — what it writes', () => {
  it('inserts idempotently on both natural keys', () => {
    // Applied by hand over stdin, and re-applied whenever a neighbouring step is corrected.
    expect(seedStatements).toMatch(/ON CONFLICT \(email\) DO NOTHING/i);
    expect(seedStatements).toMatch(/ON CONFLICT \(token_hash\) DO NOTHING/i);
  });

  it('never promotes an existing user to admin', () => {
    // `DO UPDATE SET role` would hand administrator rights to whoever took the address first.
    expect(seedStatements).not.toMatch(/DO UPDATE\s+SET[\s\S]{0,80}role/i);
    // And the refusal is checked before anything is written.
    expect(seedSql.slice(0, seedSql.indexOf('BEGIN;'))).toContain('address_taken');
  });

  it('writes both journal rows with no actor (§4.5.3, §4.5.5)', () => {
    const audits = [...seedStatements.matchAll(/INSERT INTO onchain\.access_audit[\s\S]*?;/gi)];
    expect(audits).toHaveLength(2);
    const actions = audits.map((match) => /'(user\.create|token\.issue)'/.exec(match[0])?.[1]);
    expect(actions.sort()).toStrictEqual(['token.issue', 'user.create']);
    for (const match of audits) {
      // The null means one thing: the bootstrap write, performed when no administrator exists to
      // name. Every other row of this table names one.
      expect(match[0]).toMatch(/NULL,\s*\n?\s*'(user\.create|token\.issue)'/);
    }
  });

  it('keeps the digest out of the journal and out of the operator report', () => {
    const audits = seedStatements.match(/INSERT INTO onchain\.access_audit[\s\S]*?;/gi) ?? [];
    expect(audits).toHaveLength(2);
    for (const statement of audits) {
      // **The claim is about what the row CARRIES, not about what the statement mentions.** The
      // second audit insert locates its row by `WHERE t.token_hash = :'ADMIN_TOKEN_SHA256'`, which
      // is the same indexed equality the authentication path uses and discloses nothing — the digest
      // is an input there, not a stored value. So the check reads the part BEFORE the first `WHERE`:
      // the values actually being written. The first version of this assertion forbade the
      // identifier anywhere in the statement and failed on the lookup, which would have pushed the
      // migration to find its own row by a weaker key.
      const inserted = statement.split(/\bWHERE\b/i)[0] ?? '';
      expect(inserted, 'the digest is not among the written values').not.toContain(
        'ADMIN_TOKEN_SHA256',
      );
      expect(inserted, 'no digest column is written to the journal').not.toContain('token_hash');
    }
    // The verify block reads the prefix, which identifies the row without disclosing it.
    const verify = seedSql.slice(seedSql.indexOf('COMMIT;'));
    expect(verify).toContain('t.prefix');
    expect(verify).not.toContain('token_hash');
  });

  it('references the phase-0 profile by the literal id both migrations seed', () => {
    expect(seedStatements).toContain("'01JPHASE00000000000000000A'");
    expect(sql, 'the same literal is seeded by 002').toContain("'01JPHASE00000000000000000A'");
  });

  it('schema-qualifies every object it names', () => {
    // `search_path` is not a correctness condition on this installation (WI-47), so an unqualified
    // name here would write into whatever namespace the pooler chose.
    for (const table of ['users', 'api_tokens', 'access_audit']) {
      const bare = new RegExp(
        String.raw`\b(?:INTO|FROM|JOIN|UPDATE)\s+(?!onchain\.)${table}\b`,
        'i',
      );
      expect(bare.test(seedStatements), `${table} is unqualified somewhere`).toBe(false);
    }
    expect(seedStatements).not.toMatch(/\bpublic\./i);
  });
});
