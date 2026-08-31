import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * L-28 — every psql guard must report its refusal in the process exit code.
 *
 * **The defect these assertions close.** Ten guards across five migration files ended in
 * `\quit 1`. The exit-status argument to `\quit` arrived in PostgreSQL 17; measured 2026-08-28 on
 * both targets this project applies migrations to — psql 15.8 (`supabase-db`) and 16.13
 * (`onchain-engine-db`) — it prints `\quit: extra argument "1" ignored` and the process exits `0`.
 * A caller reading `$?` therefore saw SUCCESS on a refusal. The script did halt before `BEGIN`, so
 * nothing was half-applied; what was lost was the ability to observe that it had refused.
 *
 * **Why a text assertion rather than a live run.** Reaching all ten guards at run time needs two
 * containers and, for `003`, a seeded non-admin row — R-21 keeps the network out of CI. The failure
 * these guard against is a NEW guard added in the old form, which no behavioural coverage of the
 * existing ones would catch. The live measurement was taken once, by hand, and is recorded in
 * `docs/issues/l-28-…` and in the header comment of each file.
 *
 * **Why the scan covers `sql/verify` too.** The defect is a property of the GUARD FORM, not of
 * migrations: the verify gate of task 015-24 takes three psql variables and refuses without them,
 * exactly like a migration does. Scoping the scan to one directory would have let the next such
 * file reintroduce `\quit 1` while this test stayed green — the same shape of hole the issue
 * records.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL_DIRS = ['sql/migrations', 'sql/verify'] as const;

/**
 * Statements only, PAIRED WITH THEIR ORIGINAL LINE NUMBERS. The old form quoted inside a `--`
 * comment is prose about the fix, not the fix — so comments are dropped. Dropping them renumbers
 * the file, and a failure that names a renumbered line sends the reader to the wrong place, so the
 * original number travels with each line rather than being recomputed from the filtered array.
 */
const statementLines = (text: string): { line: string; lineNo: number }[] =>
  text
    .split('\n')
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => !line.trimStart().startsWith('--'));

const statementsOf = (text: string): string =>
  statementLines(text)
    .map(({ line }) => line)
    .join('\n');

/** Repo-relative paths, so a failure names the directory as well as the file. */
const sqlFiles = (): string[] =>
  SQL_DIRS.flatMap((dir) =>
    readdirSync(path.join(repoRoot, dir))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => `${dir}/${name}`),
  );

const readSql = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/** A file carries guards if it can refuse to run at all — `001_init.sql` takes no parameter. */
const guardedFiles = (): string[] =>
  sqlFiles().filter((rel) => statementsOf(readSql(rel)).includes('\\echo '));

describe('L-28 — a migration guard reports its refusal in the exit code', () => {
  it('no migration ends a guard with `\\quit 1`, which exits 0 on psql 15 and 16', () => {
    const offenders: string[] = [];
    for (const name of sqlFiles()) {
      for (const { line, lineNo } of statementLines(readSql(name))) {
        if (/^\s*\\quit\s+\S/.test(line)) offenders.push(`${name}:${lineNo}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `\\quit takes no exit status before PostgreSQL 17 — raise instead:\n${offenders.join('\n')}`,
    ).toStrictEqual([]);
  });

  it('every guarded migration sets ON_ERROR_STOP itself, not relying on the caller', () => {
    // The runbook command passes `-v ON_ERROR_STOP=1`, and a guard that is only observable when
    // the operator remembers a flag is observable by luck. The `\set` makes the raise below fatal
    // on its own terms.
    const missing = guardedFiles().filter(
      (name) => !statementsOf(readSql(name)).includes('\\set ON_ERROR_STOP on'),
    );
    expect(
      guardedFiles().length,
      'no guarded migration found — the scan has drifted',
    ).toBeGreaterThan(3);
    expect(
      missing,
      `guarded migrations without their own ON_ERROR_STOP: ${missing.join(', ')}`,
    ).toStrictEqual([]);
  });

  it('every `\\echo` refusal is followed by a raise that produces the non-zero exit', () => {
    // The pairing is the assertion. `\echo` prints without a server round trip and survives a
    // connection that cannot execute `DO`; the raise is what `$?` reads. Either alone is half the
    // guard, and the half that was missing is the one L-28 records.
    const unpaired: string[] = [];
    let guards = 0;
    for (const name of guardedFiles()) {
      const rows = statementLines(readSql(name));
      for (const [index, row] of rows.entries()) {
        if (!/^\s*\\echo\s+'FATAL:/.test(row.line)) continue;
        guards += 1;
        // The raise may sit a few lines below: consecutive `\echo`s share one raise.
        const window = rows
          .slice(index + 1, index + 6)
          .map(({ line }) => line)
          .join('\n');
        if (!/RAISE EXCEPTION/.test(window) && !/^\s*\\echo\s+'/m.test(window)) {
          unpaired.push(`${name}:${row.lineNo}: ${row.line.trim()}`);
        }
      }
    }
    expect(guards, 'no FATAL guard found — the scan has drifted').toBeGreaterThan(5);
    expect(unpaired, `refusals that print but do not raise:\n${unpaired.join('\n')}`).toStrictEqual(
      [],
    );
  });

  it('every GUARD raise is dollar-quoted with a named tag, never bare `$$`', () => {
    // Scoped to the guard raises on purpose. `004` carries two legitimate `DO $$` blocks of its own
    // (the guarded `ADD CONSTRAINT` pair at file lines 118 and 142) that have nothing to do with a
    // refusal, and the first draft of this assertion flagged them — a check that fails on correct
    // code teaches the reader to disable it.
    //
    // The named tag matters where it IS a guard: the block sits a few lines from other
    // dollar-quoted bodies, and a bare `$$` there nests ambiguously. It also matches the project
    // rule against dollar-quoting untrusted text — these messages are literals authored here, and
    // the tag makes that visible at the call site.
    const bare: string[] = [];
    for (const name of guardedFiles()) {
      const rows = statementLines(readSql(name));
      for (const [index, row] of rows.entries()) {
        if (!/^\s*DO\s+\$\$/.test(row.line)) continue;
        const block = rows
          .slice(index, index + 6)
          .map(({ line }) => line)
          .join('\n');
        if (/RAISE EXCEPTION 'FATAL:/.test(block)) bare.push(`${name}:${row.lineNo}`);
      }
    }
    expect(bare, `guard raises with an untagged dollar quote: ${bare.join(', ')}`).toStrictEqual(
      [],
    );
  });

  it('a verify script only reads — no write statement reaches a live container', () => {
    // The verify gate runs against BOTH containers while the move is mid-flight, and on the old one
    // it runs BEFORE the irreversible drop. A write inside it would change the very numbers it
    // exists to compare, and would do so on the side that is still the only copy of the data.
    //
    // Scoped to `sql/verify` on purpose: migrations write by definition. `TRUNCATE` is listed
    // because skill `vm-deploy` §5 treats it as destructive, and a gate is not the place for it.
    const writes =
      /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|SCHEMA|DATABASE|ROLE)|ALTER\s+TABLE|GRANT|REVOKE)\b/i;
    const verifyFiles = sqlFiles().filter((rel) => rel.startsWith('sql/verify/'));
    const offenders: string[] = [];
    for (const name of verifyFiles) {
      for (const { line, lineNo } of statementLines(readSql(name))) {
        if (writes.test(line)) offenders.push(`${name}:${lineNo}: ${line.trim()}`);
      }
    }
    expect(verifyFiles.length, 'no verify script found — the scan has drifted').toBeGreaterThan(0);
    expect(offenders, `a verify script must not write:\n${offenders.join('\n')}`).toStrictEqual([]);
  });

  it('no guard interpolates a psql variable into the raised message', () => {
    // `003` documents why: psql does not substitute `:'VAR'` inside a dollar-quoted string, so the
    // reference would reach the server verbatim and fail as an undefined parameter — after looking
    // correct in review. A guard that fails for the wrong reason is not a guard.
    const interpolated: string[] = [];
    for (const name of guardedFiles()) {
      const body = statementsOf(readSql(name));
      for (const match of body.matchAll(/RAISE EXCEPTION '([^']*(?:''[^']*)*)'/g)) {
        if (/:'?[A-Z_]{3,}'?/.test(match[1] ?? '')) interpolated.push(`${name}: ${match[1]}`);
      }
    }
    expect(
      interpolated,
      `raised messages naming a psql variable:\n${interpolated.join('\n')}`,
    ).toStrictEqual([]);
  });
});
