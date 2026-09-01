import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step); only its data is read
import { PROFILE_STORAGE, storageOf } from '../eval/profiles.mjs';
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
    expect(runner).toContain('function stateTargetLabel()');
    expect(runner).toContain('httpStorage: HTTP_STORAGE,');
    expect(runner).toContain('stateTarget: stateTargetLabel(),');
    // The helper must be USED, not merely defined — a label nobody writes is not a record.
    expect((runner.match(/stateTargetLabel\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(runner).not.toMatch(/console\.(log|error)\([^)]*HTTP_STATE_PG_URL/);
  });

  it('the capability phase hands its DATA_DIR to the HTTP phase', () => {
    // AC-28's comparison needs the rows the LOCAL phase wrote. The directory outlives the HTTP
    // phase by the existing order alone — `server.stop()` removes it in the `finally` that runs
    // after — so this is a wiring assertion, not a lifetime one.
    expect(runner).toContain('return { send, notify, stop, stderr, dataDir };');
    expect(runner).toContain('await runHttpPhase(record, { stdioDataDir: server.dataDir });');
  });
});
