import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step); only its data is read
import { PROFILE_STORAGE, stateTargetLabel, storageOf } from '../eval/profiles.mjs';
import { EnvSchema } from '../src/env.js';
import { PROFILES } from '../src/profile.js';

/**
 * Task 015-29 — the eval's view of the storage axis, and the wiring that carries it.
 *
 * **Why these assertions exist offline.** The three cases they protect need a raised HTTP profile,
 * which R-21 keeps out of CI. What IS provable here is the part that fails SILENTLY at run time:
 * a ledger reader pointed at the wrong store returns zero rows and the case then asserts against
 * its own zero — a green run that measured nothing. Both halves of that failure are static.
 */

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../eval');
const runner = readFileSync(path.join(evalDir, 'run.mjs'), 'utf8');

describe('the eval follows the storage axis of the profile it raised', () => {
  it('the eval mirror agrees with PROFILES, key for key', () => {
    // A profile added or re-axed in `src/profile.ts` and forgotten in `eval/profiles.mjs` would
    // send a live case to read the wrong store. Compared as whole objects so a MISSING key fails
    // too — a per-key loop over the mirror would pass while the mirror was short.
    const fromSource = Object.fromEntries(
      Object.entries(PROFILES).map(([name, profile]) => [name, profile.storage]),
    );
    expect(PROFILE_STORAGE).toStrictEqual(fromSource);
  });

  it('an unknown profile name yields null rather than a plausible default', () => {
    // Defaulting to `'sqlite'` would make a typo in ONCHAIN_EVAL_HTTP_PROFILE read a cache file
    // that the run never wrote, and report the emptiness as a pass.
    expect(storageOf('network')).toBe('postgres');
    expect(storageOf('network-sqlite')).toBe('sqlite');
    expect(storageOf('does-not-exist')).toBeNull();
  });

  it('TC-UNIT-04 — the state DSN reaches every process of the HTTP phase, from one constant', () => {
    // The failure this prevents is not a crash. `admin()` and `startHttpServer` both spread
    // `process.env`, and the runner has already loaded the repo-root `.env`. Setting the DSN for
    // the server ALONE splits them: the token is issued into one database and read from another,
    // every transport case answers "authentication refused", and the run reads as broken cases
    // rather than a misdirected store.
    expect(runner).toContain('const PHASE_ENV = Object.freeze({');
    // Exactly one place derives the value.
    const derivations = runner.match(/^const HTTP_STATE_PG_URL =/gm) ?? [];
    expect(derivations).toHaveLength(1);
    // …and two spawners consume the one table.
    const consumers = runner.match(/\.\.\.PHASE_ENV,/g) ?? [];
    expect(
      consumers.length,
      'PHASE_ENV must be spread into BOTH admin() and startHttpServer()',
    ).toBe(2);
    // The key must not be set anywhere else in the runner: a second literal would be a second
    // source of truth, which is the split this test exists to forbid.
    const literals = runner.match(/ONCHAIN_STATE_PG_URL:/g) ?? [];
    expect(literals).toHaveLength(1);
  });

  it('the phase names its synthetic ceiling and its meta namespace, not the productive ones', () => {
    // R-12.1: the live check must not walk toward the productive estimate (~625/day) nor starve
    // the shared limiter. R-13.4/AC-28b: without a namespace the server accepts no client id and a
    // retry case would silently measure two independent requests.
    expect(runner).toContain('BLOCKSCOUT_DAILY_CALL_CAP: String(HTTP_DAILY_CALL_CAP)');
    expect(runner).toContain('ONCHAIN_META_NAMESPACE: HTTP_META_NAMESPACE');
    const cap = /const HTTP_DAILY_CALL_CAP = Number\(process\.env\.\w+ \?\? (\d+)\)/.exec(runner);
    expect(cap, 'the synthetic ceiling must be a literal small number').not.toBeNull();
    expect(Number(cap?.[1])).toBeLessThan(10);
  });

  it('the run artifact names the axis and the state target, and never the DSN', () => {
    // D10 on one side, and on the other: a run against the engine's own container must be
    // distinguishable IN THE RECORD from a run against a throwaway SQLite file, because the same
    // billing assertions mean different things in the two cases.
    expect(runner).toContain('httpStorage: HTTP_STORAGE,');
    expect(runner).toContain('stateTarget: stateTargetLabel(HTTP_STORAGE, HTTP_STATE_PG_URL),');
    expect(runner).not.toMatch(/console\.(log|error)\([^)]*HTTP_STATE_PG_URL/);
  });

  it('the state target follows the AXIS, so an inherited DSN cannot mislabel a SQLite run', () => {
    // The runner loads the repo-root `.env`, which has carried `ONCHAIN_STATE_PG_URL` since the
    // WI-62 move — so the key is set on every run, including the ones that never open Postgres.
    // Labelling those with the engine's address would claim a run touched the live container when
    // its state went to a temporary file: the field's own confusion, inverted.
    const dsn = 'postgres://someone:secret@db.example:5433/onchain_engine';
    expect(stateTargetLabel('postgres', dsn)).toBe('db.example:5433/onchain_engine');
    expect(stateTargetLabel('sqlite', dsn)).not.toContain('db.example');
    // …and neither answer may carry the credentials (D10).
    for (const storage of ['postgres', 'sqlite'] as const) {
      const label = String(stateTargetLabel(storage, dsn));
      expect(label).not.toContain('secret');
      expect(label).not.toContain('someone');
    }
    // A Postgres run with no named target is `null` — unstated, not guessed.
    expect(stateTargetLabel('postgres', null)).toBeNull();
    expect(stateTargetLabel('postgres', 'not a url')).toBe('(unparseable DSN)');
  });

  it('every value the phase sets is one EnvSchema ACCEPTS, not merely one it is handed', () => {
    // The grep above proves the keys are PASSED. Only the schema proves the VALUES are taken, and
    // they were not: `onchain-eval` carries no dot, `isMetaNamespace` demands reverse-DNS form, and
    // the first live run died at `admin user:add` with "invalid environment configuration for:
    // ONCHAIN_META_NAMESPACE" — all eight transport rows, on code the suite called green. A
    // spelling assertion about a value nothing parses is the printed-expectation defect (L-2).
    const namespace = /const HTTP_META_NAMESPACE = '([^']+)'/.exec(runner)?.[1];
    const cap = /const HTTP_DAILY_CALL_CAP = Number\(process\.env\.\w+ \?\? (\d+)\)/.exec(
      runner,
    )?.[1];
    expect(namespace, 'the runner must declare a namespace literal').toBeDefined();
    expect(cap, 'the runner must declare a ceiling literal').toBeDefined();
    expect(() =>
      EnvSchema.parse({ ONCHAIN_META_NAMESPACE: namespace, BLOCKSCOUT_DAILY_CALL_CAP: cap }),
    ).not.toThrow();
  });

  it('the retry case composes its _meta key FROM the namespace the phase declares', () => {
    // Two files, one vocabulary. `billing-retry.mjs` says in a comment that it is "kept in step
    // with HTTP_META_NAMESPACE" — a comment is not a check, and a drift here does not fail: the
    // server silently accepts no client id, mints one per call, and the case then measures two
    // independent requests while reporting on a retry.
    const namespace = /const HTTP_META_NAMESPACE = '([^']+)'/.exec(runner)?.[1];
    const retryCase = readFileSync(path.join(evalDir, 'cases', 'billing-retry.mjs'), 'utf8');
    const key = /const META_KEY = '([^']+)'/.exec(retryCase)?.[1];
    expect(key).toBe(`${String(namespace)}/client-request-id`);
  });

  it('the capability phase DECLARES the local profile rather than inheriting one', () => {
    // `local` is the only profile that raises a stdio transport (`src/profile.ts`), and this phase
    // speaks JSON-RPC over pipes. Since the WI-62 move the repo-root `.env` sets
    // `ONCHAIN_PROFILE=network`, so an inherited value made the matrix spawn a process that binds
    // an HTTP port — the live server's own, out of the same file — and answers nothing on stdout.
    // Every capability row would be a timeout on a machine where the server works.
    expect(runner).toContain("ONCHAIN_PROFILE: 'local',");
    // One per spawner: the stdio server, `admin()` and the HTTP server. A fourth child with no
    // profile of its own would be the same defect again.
    const declarations = runner.match(/ONCHAIN_PROFILE: /g) ?? [];
    expect(declarations).toHaveLength(3);
  });

  it('the Postgres axis is authorised by a NAMED administrator, never by a guessed one', () => {
    // `user:add` may omit an actor only for the first user of an EMPTY store (`src/admin/cli.ts`),
    // and the engine's own store is seeded by migration 003 — so the acceptance run cannot
    // bootstrap itself and must not invent an authoriser either.
    expect(runner).toContain('const HTTP_ADMIN_ACTOR = process.env.ONCHAIN_EVAL_ADMIN_ACTOR');
    expect(runner).toMatch(/HTTP_STORAGE === 'postgres' && HTTP_ADMIN_ACTOR === null/);
    // The refusal names the KEY, not the value: the value is a real person's address, and the
    // gate copies a failed phase's message verbatim into `eval/ledger.jsonl`, which is committed.
    expect(runner).toContain('needs ONCHAIN_EVAL_ADMIN_ACTOR');
    expect(runner).not.toMatch(/console\.(log|error)\([^)]*HTTP_ADMIN_ACTOR/);
  });

  it('the phase issues FIRST and creates only on failure, so a second run adds no identity', () => {
    // The admin CLI has no `user:list`, so "does this identity already exist?" can only be asked by
    // doing. An unconditional `user:add` fails on the second acceptance run against one engine; one
    // that never runs fails on the first. The order IS the mechanism, so it is what is asserted.
    const fn = /function issueToken\(dataDir\) \{[\s\S]*?\n\}/.exec(runner)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn.indexOf("'token:issue'")).toBeLessThan(fn.indexOf("'user:add'"));
    expect(fn).toMatch(/catch \{[\s\S]*'user:add'/);
  });

  it('the capability phase hands its DATA_DIR to the HTTP phase', () => {
    // AC-28's comparison needs the rows the LOCAL phase wrote. The directory outlives the HTTP
    // phase by the existing order alone — `server.stop()` removes it in the `finally` that runs
    // after — so this is a wiring assertion, not a lifetime one.
    expect(runner).toContain('return { send, notify, stop, stderr, dataDir };');
    expect(runner).toContain('await runHttpPhase(record, { stdioDataDir: server.dataDir });');
  });
});
