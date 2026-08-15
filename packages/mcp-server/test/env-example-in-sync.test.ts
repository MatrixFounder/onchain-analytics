import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/env.js';

/**
 * Task 014-40 — `.env.example` and `EnvSchema` describe the same surface.
 *
 * **Why this is a gate and not a habit.** `.env.example` is the ONLY description of the environment
 * surface in the repository (`deployment.md` §10.3). A key declared in the schema and absent from
 * the example is invisible to the operator setting the installation up — and the price is not a red
 * test, it is a network profile that will not start, discovered by a human at 2am with no statement
 * anywhere of what is missing. That is why §10.3 requires the two to move in ONE commit, and why the
 * requirement is checked rather than asked for.
 *
 * **Three directions, not one.** Equality in one direction would let the example grow keys the code
 * never reads; equality in the other would let the schema grow keys nobody documents. Both happen,
 * and the third case — a key documented as "not read by the code" that has since become read — is
 * the one that reads as fine from either side alone.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The marker that exempts one key, and the rule for where it applies.
 *
 * **Why a per-key marker and not a section boundary.** A boundary ("everything below this line is
 * reserved") exempts by POSITION, so a key appended under it years later is exempt without anybody
 * deciding that — the failure mode of every suppression list. A marker attached to the next key
 * exempts exactly one key and forces a reason to be written beside it.
 *
 * Two keys carry it today: `TEST_LINK_BLOCKSCOUT_PRO_API_KEY` (a verification URL for a human, read
 * by no code) and `BITQUERY_API_KEY` (a name reserved before its adapter exists). Both are real
 * documentation and neither belongs in `EnvSchema` — a schema key is a promise that something reads
 * it.
 */
const EXEMPT_MARKER = /^#\s*not-in-EnvSchema:\s*(\S.*)$/;

/** A `.env` assignment line, commented or not: `#KEY=value` / `KEY=value`. */
const KEY_LINE = /^#?([A-Z][A-Z0-9_]*)=/;

interface DocumentedKey {
  readonly key: string;
  readonly line: number;
  readonly exemptReason: string | null;
}

/**
 * Every key `.env.example` documents, with the exemption in force for each.
 *
 * A marker applies to the next key line below it, and is consumed there — so one marker can never
 * cover two keys, and a marker with no key under it is reported rather than ignored.
 */
function documentedKeys(text: string): { keys: DocumentedKey[]; danglingMarkers: number[] } {
  const keys: DocumentedKey[] = [];
  const danglingMarkers: number[] = [];
  // A one-slot queue rather than a nullable `let`: the marker in force is consumed by the next key
  // line, and a second marker arriving before any key is a dangling one.
  const pending: { reason: string; line: number }[] = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const marker = EXEMPT_MARKER.exec(line);
    if (marker) {
      for (const stale of pending.splice(0)) danglingMarkers.push(stale.line);
      pending.push({ reason: (marker[1] ?? '').trim(), line: index + 1 });
      return;
    }
    const key = KEY_LINE.exec(line);
    if (!key) return;
    keys.push({
      key: key[1] as string,
      line: index + 1,
      exemptReason: pending.splice(0)[0]?.reason ?? null,
    });
  });

  for (const stale of pending) danglingMarkers.push(stale.line);
  return { keys, danglingMarkers };
}

const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
const parsed = documentedKeys(example);
const schemaKeys = Object.keys(EnvSchema.shape).sort();
/** One entry per key: a key documented twice (`KEY=a` / `KEY=off`) is one documented key. */
const documented = new Map(parsed.keys.map((entry) => [entry.key, entry]));

describe('.env.example and EnvSchema describe the same surface (task 014-40)', () => {
  it('parses the example at all — a broken reader would pass every assertion below', () => {
    // Vacuity guard. Every check here is "this set is empty", and a regex that matched nothing would
    // satisfy all of them while reading nothing. Two keys of the twelve that predate T-014, chosen
    // because they exercise both spellings the file uses: a bare `#KEY=` and `#KEY=value`.
    expect([...documented.keys()]).toContain('LOG_LEVEL');
    expect([...documented.keys()]).toContain('NANSEN_API_KEY');
    expect(documented.size).toBeGreaterThanOrEqual(schemaKeys.length);
  });

  it('documents every key the schema declares', () => {
    const undocumented = schemaKeys.filter((key) => !documented.has(key));
    expect(
      undocumented,
      'these keys are in EnvSchema and absent from .env.example — the operator cannot see them: ' +
        undocumented.join(', '),
    ).toStrictEqual([]);
  });

  it('declares every key it documents, unless the key says why it is not declared', () => {
    const undeclared = [...documented.values()]
      .filter((entry) => entry.exemptReason === null && !schemaKeys.includes(entry.key))
      .map((entry) => `${entry.key} (.env.example:${entry.line})`);
    expect(
      undeclared,
      'these keys are documented but not in EnvSchema. Either declare them, or add a ' +
        '`# not-in-EnvSchema: <reason>` line directly above each: ' +
        undeclared.join(', '),
    ).toStrictEqual([]);
  });

  it('carries no stale exemption — a key marked "not read" that the schema now reads', () => {
    // The direction neither equality check can see. `BITQUERY_API_KEY` gets its adapter, the key
    // enters the schema, and the line above it still tells the operator nothing reads it.
    const stale = [...documented.values()]
      .filter((entry) => entry.exemptReason !== null && schemaKeys.includes(entry.key))
      .map((entry) => `${entry.key} (.env.example:${entry.line}): "${entry.exemptReason}"`);
    expect(
      stale,
      'these keys are marked `not-in-EnvSchema` and ARE in EnvSchema. The comment now tells the ' +
        'operator the opposite of the truth: ' +
        stale.join(', '),
    ).toStrictEqual([]);
  });

  it('attaches every exemption marker to a key', () => {
    expect(
      parsed.danglingMarkers,
      `a \`not-in-EnvSchema\` marker at .env.example:${parsed.danglingMarkers.join(', ')} has no ` +
        'key line under it, so it exempts nothing and reads as if it did.',
    ).toStrictEqual([]);
  });

  it('exempts exactly the keys that carry a reason, and each reason is non-empty', () => {
    const exempt = [...documented.values()].filter((entry) => entry.exemptReason !== null);
    // Not a count assertion: what matters is that an exemption is never silent. A marker with an
    // empty reason would pass `!== null` and document nothing.
    expect(exempt.every((entry) => (entry.exemptReason ?? '').length > 0)).toBe(true);
    expect(exempt.map((entry) => entry.key).sort()).toStrictEqual([
      'BITQUERY_API_KEY',
      'TEST_LINK_BLOCKSCOUT_PRO_API_KEY',
    ]);
  });
});

describe('the in-sync gate detects what it exists for', () => {
  const probe = (text: string): Map<string, DocumentedKey> =>
    new Map(documentedKeys(text).keys.map((entry) => [entry.key, entry]));

  it('TC-UNIT-07: sees a key documented in one source of the two', () => {
    const found = probe('#SOME_NEW_KEY=value\n');
    expect(found.has('SOME_NEW_KEY')).toBe(true);
    expect(found.get('SOME_NEW_KEY')?.exemptReason).toBeNull();
  });

  it('attaches a marker to the next key and to no key after it', () => {
    const found = probe('# not-in-EnvSchema: reserved\n#FIRST=\n#SECOND=\n');
    expect(found.get('FIRST')?.exemptReason).toBe('reserved');
    expect(found.get('SECOND')?.exemptReason).toBeNull();
  });

  it('does not read prose as a key', () => {
    // The file's own header contains "Пустое значение (`KEY=`)" and similar. A reader that took
    // those for declarations would report keys nobody wrote.
    const found = probe('#   * Пустое значение (`KEY=`) равно отсутствию ключа.\n# see FOO=bar\n');
    expect([...found.keys()]).toStrictEqual([]);
  });

  it('reports a marker with no key under it', () => {
    expect(documentedKeys('# not-in-EnvSchema: orphan\n\n# end of file\n').danglingMarkers).toEqual(
      [1],
    );
  });
});
