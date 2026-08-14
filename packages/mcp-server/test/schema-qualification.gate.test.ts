import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 014-03 — every reference to an engine table carries its schema (R-30.1, R-30.3, AC-46).
 *
 * **Why this gate is the only detector left in CI.** `search_path` is not a correctness condition
 * here and cannot be made one: Supavisor owns port 5432 on the shipped Supabase deployment and
 * answers with its own path, discarding the `-c search_path=onchain` the client sends. WI-47 is what
 * that costs — the database was reachable, 3039 rows were in place, and `pg-history` read none of
 * them. A missing qualifier gives neither a privilege refusal nor a failing query; it gives an
 * answer with no rows.
 *
 * Under two schemas an unqualified name landed in another namespace and met a role with no
 * privileges there, so the database itself was the second detector. One shared schema removed that:
 * the state role already holds privileges inside `onchain`. The remaining executable check —
 * "the same rows under a substituted `search_path`" — needs a live Postgres and is excluded from CI
 * by R-21, so what is left is this file.
 *
 * **Why the input is BOTH packages.** `security.md` §7.5.1 puts the identity checks in `mcp-server`,
 * beside the transport that needs them, and the SQL naming `onchain.api_tokens`, `onchain.users`,
 * `onchain.request_trace` and `onchain.diagnostics` is therefore written outside `packages/core/src`.
 * A gate reading `core` alone observes none of them — asserted below, so the requirement cannot be
 * quietly narrowed later.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION = path.join(repoRoot, 'sql/migrations/002_t014_network_profile.sql');

/** The gate's input, exactly as `deployment.md` §10.2.1 item 1 declares it. */
const SCANNED_PACKAGES = ['packages/core/src', 'packages/mcp-server/src'] as const;

/**
 * A file is in scope when its statements can reach Postgres — never by its name.
 *
 * **Why scope is a property and not a list.** The SQLite axis addresses a file database, which has
 * no schemas, so `DELETE FROM cache_entries` is correct there and wrong here. The first revision of
 * this gate exempted one file by path; the run immediately found four more statements in
 * `cache/sqlite-store.ts`, all of them correct. A path list would have grown by four names and kept
 * growing — and a suppression list is where a gate goes to die, because the next name added to it is
 * never re-examined.
 *
 * Two candidate properties were rejected by measurement. "Imports `better-sqlite3`" wrongly exempts
 * `packages/core/src/pg/budget-store.ts`, which mentions it in prose while speaking Postgres.
 * "Lives under `pg/`" is a path list wearing a different hat.
 *
 * What decides it is whether a Postgres client is in the file at all: a module that holds none
 * cannot issue a statement against `onchain`, whatever its SQL says.
 */
const PG_CLIENT_MARKERS = [
  /from 'pg'/,
  /\bStateClient\b/,
  /\bReadClient\b/,
  /\bcreateStateClient\b/,
  /\bcreateReadClient\b/,
  /\bEngineStore\b/,
] as const;

const reachesPostgres = (body: string): boolean => PG_CLIENT_MARKERS.some((m) => m.test(body));

/**
 * The table list comes from the migration, never from a literal here.
 *
 * A hard-coded list diverges from the migration on the first table added, and the divergence reads
 * as "the gate passed".
 */
const engineTables = (): string[] => {
  const sql = readFileSync(MIGRATION, 'utf8');
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+onchain\.(\w+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly text: string;
}

/**
 * Unqualified references to an engine table, with the file and line of each.
 *
 * The clause keywords are what make a match a table reference rather than a word: `onchain.usage`
 * qualified is skipped by the negative lookbehind, and a bare `usage` in prose never follows `FROM`.
 */
const scan = (roots: readonly string[], tables: readonly string[]): Finding[] => {
  if (tables.length === 0) return [];
  const clause = String.raw`(?:FROM|JOIN|INTO|UPDATE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DELETE\s+FROM)`;
  const pattern = new RegExp(
    String.raw`\b${clause}\s+(?!onchain\.)(?:"?)(${tables.join('|')})\b`,
    'gi',
  );
  const findings: Finding[] = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    const files = root.endsWith('.sql') ? [abs] : sourceFiles(abs);
    for (const file of files) {
      const relative = path.relative(repoRoot, file);
      const body = readFileSync(file, 'utf8');
      if (!root.endsWith('.sql') && !reachesPostgres(body)) continue;
      const lines = body.split('\n');
      lines.forEach((text, index) => {
        for (const match of text.matchAll(pattern)) {
          findings.push({
            file: relative,
            line: index + 1,
            table: match[1] ?? '',
            text: text.trim(),
          });
        }
      });
    }
  }
  return findings;
};

describe('schema qualification — the gate', () => {
  it('TC-UNIT-05: reads its table list from the migration, not from a literal here', () => {
    const tables = engineTables();
    expect(tables).toHaveLength(12);
    expect(tables).toContain('api_tokens');
    expect(tables).toContain('request_trace');
  });

  it('finds no unqualified engine-table reference in either package', () => {
    const findings = scan(SCANNED_PACKAGES, engineTables());
    const rendered = findings.map((f) => `${f.file}:${f.line} → ${f.table}: ${f.text}`);
    expect(rendered, 'an unqualified name answers with no rows, not with an error').toEqual([]);
  });

  it('finds no unqualified CREATE TABLE in any migration', () => {
    const migrations = readdirSync(path.join(repoRoot, 'sql/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.join('sql/migrations', f));
    const findings = scan(migrations, engineTables());
    expect(findings.map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it('creates nothing in public, in either package or any migration', () => {
    const offenders: string[] = [];
    for (const root of SCANNED_PACKAGES) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        if (/\bpublic\.\w+/i.test(readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('schema qualification — the gate detects what it exists for', () => {
  const tables = engineTables();
  const findingsIn = (text: string): Finding[] => {
    const clause = String.raw`(?:FROM|JOIN|INTO|UPDATE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DELETE\s+FROM)`;
    const pattern = new RegExp(
      String.raw`\b${clause}\s+(?!onchain\.)(?:"?)(${tables.join('|')})\b`,
      'gi',
    );
    return [...text.matchAll(pattern)].map((m) => ({
      file: 'probe',
      line: 1,
      table: m[1] ?? '',
      text,
    }));
  };

  it('TC-UNIT-01: an unqualified SELECT in core would be caught', () => {
    expect(findingsIn(`const q = 'SELECT id FROM snapshots WHERE ts > $1';`)).toHaveLength(0);
    expect(findingsIn(`const q = 'SELECT id FROM usage WHERE provider = $1';`)).toHaveLength(1);
  });

  it('TC-UNIT-02: an unqualified reference in mcp-server would be caught', () => {
    expect(
      findingsIn(`await client.query('SELECT id FROM api_tokens WHERE token_hash = $1')`),
    ).toHaveLength(1);
  });

  it('TC-UNIT-03: narrowing the input to one package would hide it — so the input names two', () => {
    const probe = path.join(repoRoot, 'packages/mcp-server/src/engine/pg-engine-store.ts');
    expect(statSync(probe).isFile(), 'the identity SQL lives in this package').toBe(true);
    const narrowed = scan(['packages/core/src'], tables).map((f) => f.file);
    expect(narrowed.some((f) => f.startsWith('packages/mcp-server'))).toBe(false);
    expect(SCANNED_PACKAGES).toContain('packages/mcp-server/src');
  });

  it('TC-UNIT-04: an unqualified CREATE TABLE would be caught', () => {
    expect(findingsIn(`CREATE TABLE IF NOT EXISTS diagnostics (`)).toHaveLength(1);
    expect(findingsIn(`CREATE TABLE IF NOT EXISTS onchain.diagnostics (`)).toHaveLength(0);
  });

  it('does not flag a qualified reference, nor the word outside a clause', () => {
    expect(findingsIn(`SELECT * FROM onchain.request_trace`)).toHaveLength(0);
    expect(findingsIn(`// the usage counter is additive`)).toHaveLength(0);
  });

  /**
   * A module out of scope must not be issuing Postgres SQL — checked on code, not on prose.
   *
   * Comments are stripped first, and that is not a convenience. The stubs of task 014-02 name
   * `onchain.request_trace` and `onchain.diagnostics` in their docstrings, which is exactly what a
   * declaration should do: say which table it stands for. Flagging those would push authors to stop
   * naming the table in prose — making the code less legible in order to satisfy a gate.
   */
  it('a file out of scope issues no Postgres SQL — the exemption checks itself', () => {
    const codeOnly = (body: string): string =>
      body
        .split('\n')
        .filter((line) => {
          const t = line.trimStart();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');

    const offenders: string[] = [];
    for (const root of SCANNED_PACKAGES) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        const body = readFileSync(file, 'utf8');
        if (reachesPostgres(body)) continue;
        if (/\bonchain\.\w+/.test(codeOnly(body))) offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(
      offenders,
      'a module naming the schema in code but holding no client breaks the scope rule',
    ).toEqual([]);
  });

  it('classifies the two axes the way measurement says, not the way names suggest', () => {
    const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
    expect(reachesPostgres(read('packages/core/src/pg/budget-store.ts')), 'speaks Postgres').toBe(
      true,
    );
    expect(reachesPostgres(read('packages/core/src/cache/sqlite-store.ts')), 'speaks SQLite').toBe(
      false,
    );
    expect(reachesPostgres(read('packages/core/src/cache/ddl.ts')), 'declares SQLite').toBe(false);
  });
});
