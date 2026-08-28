import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilityManifests } from '@onchain-intel/core';
import {
  DEFAULT_HTTP_RESPONSE_TIMEOUT_MS,
  EnvSchema,
  HTTP_RESPONSE_TIMEOUT_FLOOR_MS,
  loadEnv,
  toProcessEnv,
  withDeclaredDefaults,
} from '../src/env.js';
import { PROFILE_NAMES, resolveProfile } from '../src/profile.js';
import { SETTING_CLASSES } from '../src/settings-classification.js';

/**
 * Unit tests for `src/env.ts` (task 001-3, closes R-6/R-12).
 *
 * Explicit vitest imports throughout (no `globals: true`) — the package tsconfig's
 * `types: ["node"]` deliberately does not include vitest's ambient globals (carry-forward
 * reviewer note 2).
 */

describe('EnvSchema', () => {
  it('parse({}) does not throw — the M0 empty-env contract (R-12)', () => {
    expect(() => EnvSchema.parse({})).not.toThrow();
  });

  it('accepts a valid LOG_LEVEL value', () => {
    const result = EnvSchema.parse({ LOG_LEVEL: 'debug' });
    expect(result.LOG_LEVEL).toBe('debug');
  });

  it('strips unknown env keys instead of rejecting them (process.env carries hundreds)', () => {
    const result = EnvSchema.parse({ PATH: '/usr/bin', HOME: '/home/example', RANDOM: '1' });
    expect(result).toStrictEqual({});
  });

  it('treats LOG_LEVEL: "" as unset — a blank optional env var behaves as absent', () => {
    const result = EnvSchema.parse({ LOG_LEVEL: '' });
    expect(result.LOG_LEVEL).toBeUndefined();
  });

  // Task 003-6 (R-23): 4 new M1 optional keys — COINGECKO_API_KEY, DUNE_API_KEY, ONCHAIN_PG_URL,
  // DATA_DIR. ARCHITECTURE.md §3.2/§10.3: empty env stays valid (UC-1), each key is optional.
  it('parse({}) still does not throw with the 4 new M1 keys declared (R-23)', () => {
    expect(() => EnvSchema.parse({})).not.toThrow();
  });

  it('accepts COINGECKO_API_KEY/COINGECKO_PRO_API_KEY/DUNE_API_KEY/DATA_DIR as plain optional strings', () => {
    const result = EnvSchema.parse({
      COINGECKO_API_KEY: 'cg-demo-key',
      COINGECKO_PRO_API_KEY: 'cg-pro-key',
      DUNE_API_KEY: 'dune-key',
      DATA_DIR: '/var/lib/onchain-intel',
    });
    expect(result.COINGECKO_API_KEY).toBe('cg-demo-key');
    expect(result.COINGECKO_PRO_API_KEY).toBe('cg-pro-key');
    expect(result.DUNE_API_KEY).toBe('dune-key');
    expect(result.DATA_DIR).toBe('/var/lib/onchain-intel');
  });

  it('ONCHAIN_PG_URL accepts a realistic Supabase postgres:// DSN with a percent-encoded password', () => {
    const dsn =
      'postgres://user:p%40ss@aws-1-eu-west.pooler.supabase.com:5432/postgres?sslmode=require';
    const result = EnvSchema.parse({ ONCHAIN_PG_URL: dsn });
    expect(result.ONCHAIN_PG_URL).toBe(dsn);
  });

  it('ONCHAIN_PG_URL rejects a non-URL value with an error that names the key, never the value', () => {
    const garbageValue = 'not-a-real-dsn-773f2a';
    let thrown: unknown;
    try {
      EnvSchema.parse({ ONCHAIN_PG_URL: garbageValue });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('ONCHAIN_PG_URL');
    expect(message).not.toContain(garbageValue);
  });

  it('treats ONCHAIN_PG_URL: "" as unset, same empty-string idiom as LOG_LEVEL', () => {
    // [Phase 1 RED]: the bare `z.string().url().optional()` stub does not yet special-case an
    // empty string (unlike LOG_LEVEL's z.preprocess wrapper) — '' fails `.url()` validation, so
    // this assertion fails until Phase 2 wraps ONCHAIN_PG_URL in the same preprocess idiom.
    const result = EnvSchema.parse({ ONCHAIN_PG_URL: '' });
    expect(result.ONCHAIN_PG_URL).toBeUndefined();
  });

  it('COINGECKO_API_KEY/COINGECKO_PRO_API_KEY/DUNE_API_KEY/DATA_DIR: "" are treated as unset (empty-string idiom)', () => {
    const result = EnvSchema.parse({
      COINGECKO_API_KEY: '',
      COINGECKO_PRO_API_KEY: '',
      DUNE_API_KEY: '',
      DATA_DIR: '',
    });
    expect(result.COINGECKO_API_KEY).toBeUndefined();
    expect(result.COINGECKO_PRO_API_KEY).toBeUndefined();
    expect(result.DUNE_API_KEY).toBeUndefined();
    expect(result.DATA_DIR).toBeUndefined();
  });

  // Task 005-6 (R-46): 3 new M2 optional keys — NANSEN_API_KEY, NANSEN_DAILY_CREDIT_CAP,
  // NANSEN_BUDGET_WARN_RATIO. interfaces.md §5.1.2/§5.2: empty env stays valid (same M0/M1
  // invariant), each key is optional (TC-UNIT-12).
  it('parse({}) still does not throw with the 3 new M2 keys declared (R-46)', () => {
    expect(() => EnvSchema.parse({})).not.toThrow();
  });

  it('accepts NANSEN_API_KEY as a plain optional string', () => {
    const result = EnvSchema.parse({ NANSEN_API_KEY: 'nansen-demo-key' });
    expect(result.NANSEN_API_KEY).toBe('nansen-demo-key');
  });

  it('treats NANSEN_API_KEY: "" as unset (empty-string idiom)', () => {
    const result = EnvSchema.parse({ NANSEN_API_KEY: '' });
    expect(result.NANSEN_API_KEY).toBeUndefined();
  });

  it('coerces NANSEN_DAILY_CREDIT_CAP from its raw env string into a positive integer', () => {
    const result = EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '5000' });
    expect(result.NANSEN_DAILY_CREDIT_CAP).toBe(5000);
  });

  it('treats NANSEN_DAILY_CREDIT_CAP: "" as unset — equivalent to not set at all (TC-UNIT-12)', () => {
    const result = EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '' });
    expect(result.NANSEN_DAILY_CREDIT_CAP).toBeUndefined();
  });

  it('rejects a non-positive/non-integer NANSEN_DAILY_CREDIT_CAP', () => {
    expect(() => EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '0' })).toThrow();
    expect(() => EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '-5' })).toThrow();
    expect(() => EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: 'not-a-number' })).toThrow();
  });

  it('coerces NANSEN_BUDGET_WARN_RATIO from its raw env string into a 0..1 ratio', () => {
    const result = EnvSchema.parse({ NANSEN_BUDGET_WARN_RATIO: '0.9' });
    expect(result.NANSEN_BUDGET_WARN_RATIO).toBe(0.9);
  });

  it('treats NANSEN_BUDGET_WARN_RATIO: "" as unset', () => {
    const result = EnvSchema.parse({ NANSEN_BUDGET_WARN_RATIO: '' });
    expect(result.NANSEN_BUDGET_WARN_RATIO).toBeUndefined();
  });

  it('rejects NANSEN_BUDGET_WARN_RATIO: "1.5" — out of the 0..1 range (TC-UNIT-12)', () => {
    expect(() => EnvSchema.parse({ NANSEN_BUDGET_WARN_RATIO: '1.5' })).toThrow();
  });
});

describe('loadEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('loadEnv({}) does not throw — the M0 empty-env contract (R-12)', () => {
    // Passing an explicit object (not `undefined`) skips the `process.loadEnvFile()` branch —
    // this test never touches the real process env or filesystem.
    expect(() => loadEnv({})).not.toThrow();
  });

  it('accepts a valid LOG_LEVEL value via an explicit raw override', () => {
    const env = loadEnv({ LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv);
    expect(env.LOG_LEVEL).toBe('warn');
  });

  // TC-UNIT-12 (R-46) — same "name the key, never the value" contract as the ONCHAIN_PG_URL test
  // above, now for NANSEN_BUDGET_WARN_RATIO.
  it('throws on NANSEN_BUDGET_WARN_RATIO: "1.5", naming only the KEY — never the value (D10)', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      loadEnv({ NANSEN_BUDGET_WARN_RATIO: '1.5' } as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('NANSEN_BUDGET_WARN_RATIO');
    expect(message).not.toContain('1.5');

    const stderrOutput = stderrSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderrOutput).toContain('NANSEN_BUDGET_WARN_RATIO');
    expect(stderrOutput).not.toContain('1.5');
  });

  it('throws on an invalid LOG_LEVEL value, naming only the KEY — never the value (D10)', () => {
    const secretLookingValue = 'not-a-real-level-773f2a';
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      loadEnv({ LOG_LEVEL: secretLookingValue } as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('LOG_LEVEL');
    expect(message).not.toContain(secretLookingValue);

    const stderrOutput = stderrSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderrOutput).toContain('LOG_LEVEL');
    expect(stderrOutput).not.toContain(secretLookingValue);
  });

  // loadEnv() with NO argument exercises the `process.loadEnvFile()` branch (skipped entirely by
  // the `{}`-argument tests above). Spy on `process.loadEnvFile` itself rather than touching a
  // real `.env` file on disk. `vi.stubEnv('LOG_LEVEL', 'info')` pins the real process env to a
  // known-valid value so `EnvSchema.safeParse(process.env)` always succeeds regardless of what a
  // developer's actual shell happens to export — these two tests are only about the
  // `.env`-load-error handling path, not about parse outcomes.
  it('swallows an ENOENT-shaped loadEnvFile error silently — no throw, no stderr warning', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const loadEnvFileSpy = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => loadEnv()).not.toThrow();
    expect(loadEnvFileSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not throw on an EACCES-shaped loadEnvFile error, but warns to stderr with no env VALUE', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const error = new Error("EACCES: permission denied, open '.env'") as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => loadEnv()).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    // The contract: the warning is the static prefix plus the OS error's OWN message — nothing
    // else. This exact-match (rather than a loose `.toContain`) is what proves no env VALUE (e.g.
    // LOG_LEVEL's contents) could have snuck into the message; it may reasonably echo the OS
    // error text itself ("EACCES: permission denied, ...").
    expect(stderrSpy.mock.calls[0]?.join(' ')).toBe(
      "onchain-intel-mcp-server: warning: could not load .env: EACCES: permission denied, open '.env'",
    );
  });

  // Happy-path exercise of the REAL `process.loadEnvFile()` load-and-apply behavior (001-4, F-4)
  // — no stub on `process.loadEnvFile` here, unlike the two tests above. Isolated in its own
  // nested `describe` with local `beforeEach`/`afterEach` (rather than reusing the parent
  // `loadEnv` describe's hooks) so the cwd change / temp `.env` file / `LOG_LEVEL` mutation this
  // test needs never leaks into its sibling tests above.
  describe('loading a real .env file from disk', () => {
    let tempDir: string;
    let originalCwd: string;
    let originalLogLevel: string | undefined;

    beforeEach(() => {
      originalCwd = process.cwd();
      // `process.loadEnvFile()` MUTATES `process.env` directly — snapshot and clear `LOG_LEVEL`
      // first so this test's outcome can't depend on (or be masked by) whatever a developer's
      // real shell happens to already export.
      originalLogLevel = process.env.LOG_LEVEL;
      delete process.env.LOG_LEVEL;
      tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-env-test-'));
      writeFileSync(path.join(tempDir, '.env'), 'LOG_LEVEL=warn\n', 'utf8');
      // process.loadEnvFile() reads `.env` from process.cwd() when called with no path argument.
      process.chdir(tempDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
      if (originalLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLogLevel;
      }
    });

    it('loadEnv() with no argument loads LOG_LEVEL from a real .env file via process.loadEnvFile()', () => {
      const env = loadEnv();
      expect(env.LOG_LEVEL).toBe('warn');
    });
  });
  // --- Q-2: NANSEN_DAILY_CREDIT_CAP has three states ---
  it('accepts the literal "off" to disable the self-imposed ceiling', () => {
    expect(EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: 'off' }).NANSEN_DAILY_CREDIT_CAP).toBe('off');
  });

  it('accepts a positive integer as an explicit ceiling', () => {
    expect(EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '250' }).NANSEN_DAILY_CREDIT_CAP).toBe(250);
  });

  it('leaves it undefined when unset, so the engine derives its own default', () => {
    expect(EnvSchema.parse({}).NANSEN_DAILY_CREDIT_CAP).toBeUndefined();
  });

  it('still REJECTS 0 — "off" is the disable switch, 0 would mean "spend nothing"', () => {
    // A money guard must not be disableable by a truncation/typo that yields "0".
    expect(() => EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: '0' })).toThrow();
  });

  it('rejects other words and negatives', () => {
    for (const bad of ['none', 'unlimited', 'true', '-5', '1.5']) {
      expect(() => EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: bad })).toThrow();
    }
  });
});

describe('BLOCKSCOUT_PRO_API_KEY (TASK-008 R-79a)', () => {
  it('is optional — a stock install with no key still validates', () => {
    expect(EnvSchema.parse({}).BLOCKSCOUT_PRO_API_KEY).toBeUndefined();
    expect(EnvSchema.parse({ BLOCKSCOUT_PRO_API_KEY: '' }).BLOCKSCOUT_PRO_API_KEY).toBeUndefined();
  });

  it('rejects a value that only LOOKS present, instead of shipping it as apikey=%20', () => {
    // The failure this guards is silent by construction: the key travels as a query parameter, so a
    // whitespace value does not fail at an auth layer — the facade answers 200 anyway during the
    // grace period, and the day enforcement lands it becomes a total auth failure with no
    // diagnostic. `echo key >> .env` leaves a trailing newline; a shell `KEY=" "` leaves a space.
    expect(() => EnvSchema.parse({ BLOCKSCOUT_PRO_API_KEY: '   ' })).toThrow();
    expect(
      EnvSchema.parse({ BLOCKSCOUT_PRO_API_KEY: 'proapi_real\n' }).BLOCKSCOUT_PRO_API_KEY,
    ).toBe('proapi_real');
  });
});

/**
 * Task 015-16 (`docs/tasks/task-015-16-blockscout-daily-call-cap-env.md`) — the key that narrows
 * the daily call gate `createCallGate` reads for `blockscout` (task 015-13/015-14/015-15). No `off`
 * sentinel: R-9.6 makes a declared ceiling mandatory for this provider, so disabling the gate is not
 * an admissible configuration (unlike `NANSEN_DAILY_CREDIT_CAP`, a money guard that DOES take one).
 */
describe('BLOCKSCOUT_DAILY_CALL_CAP (task 015-16, R-10.1/R-10.2/R-12.1)', () => {
  it('TC-UNIT-01: EnvSchema.parse({}) passes without this key — the value is empty', () => {
    const result = EnvSchema.parse({});
    expect(result.BLOCKSCOUT_DAILY_CALL_CAP).toBeUndefined();
  });

  it('TC-UNIT-02: a raw env string coerces to a positive integer', () => {
    const result = EnvSchema.parse({ BLOCKSCOUT_DAILY_CALL_CAP: '5' });
    expect(result.BLOCKSCOUT_DAILY_CALL_CAP).toBe(5);
  });

  it('TC-UNIT-03: 0, a negative, a fraction and the word "off" are all rejected — no disable sentinel', () => {
    for (const bad of ['0', '-1', '2.5', 'off']) {
      expect(() => EnvSchema.parse({ BLOCKSCOUT_DAILY_CALL_CAP: bad })).toThrow();
    }
  });

  it('TC-UNIT-04: an empty string equals the key being unset', () => {
    const result = EnvSchema.parse({ BLOCKSCOUT_DAILY_CALL_CAP: '' });
    expect(result.BLOCKSCOUT_DAILY_CALL_CAP).toBeUndefined();
  });

  it('TC-UNIT-05: the refusal names the key and never the value (D10)', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      loadEnv({ BLOCKSCOUT_DAILY_CALL_CAP: '0' } as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('BLOCKSCOUT_DAILY_CALL_CAP');
    expect(message).not.toContain('0');

    const stderrOutput = stderrSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderrOutput).toContain('BLOCKSCOUT_DAILY_CALL_CAP');
  });

  it('TC-UNIT-06: the class is narrowing in both the registry and §10.3 — never secret, never bootstrap', () => {
    expect(SETTING_CLASSES.BLOCKSCOUT_DAILY_CALL_CAP).toBe('narrowing');

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const deployment = readFileSync(
      path.join(repoRoot, 'docs/architectures/deployment.md'),
      'utf8',
    );
    const row = /\|\s*`BLOCKSCOUT_DAILY_CALL_CAP`\s*\|\s*(secret|bootstrap|narrowing)\s*\|/.exec(
      deployment,
    );
    expect(row, 'the §10.3 row for BLOCKSCOUT_DAILY_CALL_CAP is missing').not.toBeNull();
    expect(row![1]).toBe('narrowing');
  });
});

/**
 * T-014's ten keys (task 014-40, `deployment.md` §10.3).
 *
 * Nine bootstrap, one secret. Every one optional, so the invariant the twelve before them established
 * survives: `EnvSchema.parse({})` succeeds, and an empty value behaves as an absent one.
 */
describe('T-014 environment keys (task 014-40)', () => {
  const TASK_014_KEYS = [
    'ONCHAIN_PROFILE',
    'ONCHAIN_STATE_PG_URL',
    'ONCHAIN_HTTP_BIND',
    'ONCHAIN_HTTP_PORT',
    'ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS',
    'ONCHAIN_ALLOWED_HOSTS',
    'ONCHAIN_ALLOWED_ORIGINS',
    'ONCHAIN_TOKEN_HASH_SALT',
    'ONCHAIN_SESSION_MAX',
    'ONCHAIN_SESSION_IDLE_MS',
  ] as const;

  it('TC-UNIT-01: an empty environment is still a valid configuration (R-13.5)', () => {
    expect(() => EnvSchema.parse({})).not.toThrow();
    // And it is still EMPTY. A zod `.default()` on any of the ten would make an unset key
    // indistinguishable from a chosen one — the L-10 shape, a value with nothing to say whether
    // anybody decided it. The defaults live in `withDeclaredDefaults`, where the answer is derived
    // rather than remembered.
    expect(EnvSchema.parse({})).toStrictEqual({});
  });

  it('declares all ten, and nine of them are new bootstrap keys', () => {
    for (const key of TASK_014_KEYS) {
      expect(Object.keys(EnvSchema.shape), `${key} is declared`).toContain(key);
    }
  });

  it('TC-UNIT-06: an empty value equals an unset key for each of the ten', () => {
    for (const key of TASK_014_KEYS) {
      const parsed = EnvSchema.parse({ [key]: '' }) as Record<string, unknown>;
      expect(parsed[key], `${key}='' behaves as absent`).toBeUndefined();
      const decided = Object.entries(parsed).filter(([, value]) => value !== undefined);
      expect(decided, `${key}='' decided nothing else`).toStrictEqual([]);
    }
  });

  it('an empty value leaves the PROPERTY present, so presence is not the test for "set"', () => {
    // Measured, not assumed: `EnvSchema.parse({KEY: ''})` yields `{KEY: undefined}` — the property
    // exists and its value does not. That is true of all twenty-two keys, not just T-014's, and it
    // matters because `'ONCHAIN_HTTP_PORT' in env` answers `true` for a `.env` line with no value.
    // A consumer deciding "configured?" must read the VALUE. `withDeclaredDefaults` does; a
    // hand-written `in` check would silently treat a blank line as a decision.
    const blank = EnvSchema.parse({ ONCHAIN_HTTP_PORT: '', LOG_LEVEL: '' });
    expect('ONCHAIN_HTTP_PORT' in blank).toBe(true);
    expect(blank.ONCHAIN_HTTP_PORT).toBeUndefined();
    expect('ONCHAIN_HTTP_PORT' in EnvSchema.parse({})).toBe(false);
  });

  it('TC-UNIT-05: ONCHAIN_PROFILE admits the three declared names and refuses a fourth', () => {
    for (const name of PROFILE_NAMES) {
      expect(EnvSchema.parse({ ONCHAIN_PROFILE: name }).ONCHAIN_PROFILE).toBe(name);
    }
    expect(() => EnvSchema.parse({ ONCHAIN_PROFILE: 'remote' })).toThrow();
    // Unset is `local`, and that default is `profile.ts`'s — the schema leaves the field undefined
    // so the two cannot disagree about the vocabulary or about the default.
    expect(EnvSchema.parse({}).ONCHAIN_PROFILE).toBeUndefined();
    expect(resolveProfile({}).name).toBe('local');
  });

  it('the schema and resolveProfile admit exactly the same set of names', () => {
    // One key, one set of admissible values. The failure this prevents is a value that parses and
    // then throws — or throws and would have parsed — depending on which door it came through.
    for (const candidate of [...PROFILE_NAMES, 'remote', 'LOCAL', 'network sqlite']) {
      const schemaAccepts = EnvSchema.safeParse({ ONCHAIN_PROFILE: candidate }).success;
      let resolverAccepts = true;
      try {
        resolveProfile({ ONCHAIN_PROFILE: candidate });
      } catch {
        resolverAccepts = false;
      }
      expect(schemaAccepts, `${candidate}: schema and resolver disagree`).toBe(resolverAccepts);
    }
  });

  describe('ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS is bounded from below by the manifest (R-16.3)', () => {
    it('TC-UNIT-02: the floor itself is refused, and the message names the key, not the value', () => {
      let thrown: unknown;
      try {
        EnvSchema.parse({
          ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: String(HTTP_RESPONSE_TIMEOUT_FLOOR_MS),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain('ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS');
      // A value equal to the floor cuts a call that was completing lawfully, so `gt` and not `gte`.
      expect(EnvSchema.safeParse({ ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: '1000' }).success).toBe(false);
    });

    it('TC-UNIT-03: one millisecond above the floor is accepted', () => {
      expect(
        EnvSchema.parse({
          ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: String(HTTP_RESPONSE_TIMEOUT_FLOOR_MS + 1),
        }).ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS,
      ).toBe(HTTP_RESPONSE_TIMEOUT_FLOOR_MS + 1);
    });

    it('TC-UNIT-04: an unset value resolves to 360 000 through the one place that defaults it', () => {
      expect(EnvSchema.parse({}).ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS).toBeUndefined();
      expect(withDeclaredDefaults(EnvSchema.parse({})).httpResponseTimeoutMs).toBe(360_000);
      expect(DEFAULT_HTTP_RESPONSE_TIMEOUT_MS).toBeGreaterThan(HTTP_RESPONSE_TIMEOUT_FLOOR_MS);
    });

    /**
     * The floor is a DERIVED number, and this is the derivation.
     *
     * §10.3 states it as a measurement over the manifest: the worst case one response may lawfully
     * occupy is the largest `deadlineMs + paidLegMs`, because the deadline bounds the cancellable
     * part and the paid leg is uncut. Written as a constant, that number would rot the first time a
     * capability raised either half — and it would rot INVISIBLY, because a too-low floor refuses
     * nothing: it admits a response window that cuts a lawful call.
     *
     * So the measurement runs here instead of being remembered. It is deliberately an EQUALITY: a
     * manifest row that lowered the worst case would leave the floor higher than it needs to be,
     * refusing configurations that are now legitimate, and the operator would have no way to learn
     * why. Either direction is a statement someone has to make on purpose.
     */
    it('the floor equals the worst case measured over the whole manifest', () => {
      const rows = Object.values(capabilityManifests);
      expect(rows.length).toBeGreaterThan(0);
      const worst = Math.max(...rows.map((row) => row.deadlineMs + (row.paidLegMs ?? 0)));
      expect(
        HTTP_RESPONSE_TIMEOUT_FLOOR_MS,
        'the manifest worst case moved. Update HTTP_RESPONSE_TIMEOUT_FLOOR_MS, deployment.md §10.3 ' +
          'and .env.example together — the floor is what keeps a configured response window from ' +
          'cutting a call that was completing lawfully.',
      ).toBe(worst);
    });
  });

  it('ONCHAIN_HTTP_PORT is validated as a port, and has no default to fall back on', () => {
    expect(EnvSchema.parse({ ONCHAIN_HTTP_PORT: '8848' }).ONCHAIN_HTTP_PORT).toBe(8848);
    for (const bad of ['0', '65536', '-1', '80.5', 'http']) {
      expect(EnvSchema.safeParse({ ONCHAIN_HTTP_PORT: bad }).success, bad).toBe(false);
    }
    expect(EnvSchema.parse({}).ONCHAIN_HTTP_PORT).toBeUndefined();
  });

  it('ONCHAIN_STATE_PG_URL is a URL, and is a different key from the read-only DSN', () => {
    const dsn = 'postgres://onchain_state:p%40ss@ubuntu-linux-2404.local:5432/postgres';
    expect(EnvSchema.parse({ ONCHAIN_STATE_PG_URL: dsn }).ONCHAIN_STATE_PG_URL).toBe(dsn);
    expect(EnvSchema.safeParse({ ONCHAIN_STATE_PG_URL: 'not-a-dsn' }).success).toBe(false);
    // Two keys, because they carry two roles with two grant sets. One key for both would give the
    // read path write privileges (`sql/migrations/002_t014_network_profile.sql`).
    const both = EnvSchema.parse({ ONCHAIN_STATE_PG_URL: dsn, ONCHAIN_PG_URL: dsn });
    expect(both.ONCHAIN_STATE_PG_URL).toBe(dsn);
    expect(both.ONCHAIN_PG_URL).toBe(dsn);
  });

  it('the two perimeter keys parse to lists, so no consumer splits the string itself', () => {
    const parsed = EnvSchema.parse({
      ONCHAIN_ALLOWED_HOSTS: 'onchain.internal:8848, 127.0.0.1:8848 ',
      ONCHAIN_ALLOWED_ORIGINS: 'https://n8n.internal',
    });
    expect(parsed.ONCHAIN_ALLOWED_HOSTS).toStrictEqual(['onchain.internal:8848', '127.0.0.1:8848']);
    expect(parsed.ONCHAIN_ALLOWED_ORIGINS).toStrictEqual(['https://n8n.internal']);
    // A trailing comma cannot delete an entry the operator wrote, so it is forgiven.
    expect(
      EnvSchema.parse({ ONCHAIN_ALLOWED_HOSTS: 'a.internal,' }).ONCHAIN_ALLOWED_HOSTS,
    ).toStrictEqual(['a.internal']);
    // A value that yields NO entries is refused rather than read as an empty perimeter: it would
    // configure a listener that admits nothing while reading, to the operator, as configured.
    for (const bad of [',', ' , ', ',,']) {
      expect(EnvSchema.safeParse({ ONCHAIN_ALLOWED_HOSTS: bad }).success, bad).toBe(false);
    }
    // Unset stays unset — the defaults are the bound address and "no browser origin", and only the
    // bound listener knows the first (`security.md` §7.5.4, task 014-11).
    expect(EnvSchema.parse({}).ONCHAIN_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('ONCHAIN_TOKEN_HASH_SALT refuses a value that only looks present', () => {
    // The pepper enters `sha256(pepper || presented)`. A trailing newline from `echo salt >> .env`
    // changes every digest, so every issued token stops verifying at once — and D10 forbids printing
    // the value that did it, which leaves nothing to debug with.
    expect(EnvSchema.parse({ ONCHAIN_TOKEN_HASH_SALT: 'pepper\n' }).ONCHAIN_TOKEN_HASH_SALT).toBe(
      'pepper',
    );
    expect(EnvSchema.safeParse({ ONCHAIN_TOKEN_HASH_SALT: '   ' }).success).toBe(false);
    expect(
      EnvSchema.parse({ ONCHAIN_TOKEN_HASH_SALT: '' }).ONCHAIN_TOKEN_HASH_SALT,
    ).toBeUndefined();
  });

  it('the two session keys are positive integers, defaulted in one place', () => {
    expect(EnvSchema.parse({ ONCHAIN_SESSION_MAX: '128' }).ONCHAIN_SESSION_MAX).toBe(128);
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(EnvSchema.safeParse({ ONCHAIN_SESSION_MAX: bad }).success, bad).toBe(false);
      expect(EnvSchema.safeParse({ ONCHAIN_SESSION_IDLE_MS: bad }).success, bad).toBe(false);
    }
    const defaults = withDeclaredDefaults(EnvSchema.parse({}));
    expect(defaults.sessionMax).toBe(64);
    expect(defaults.sessionIdleMs).toBe(900_000);
    expect(defaults.httpBind).toBe('127.0.0.1');
  });

  it('a set value wins over every declared default', () => {
    const defaults = withDeclaredDefaults(
      EnvSchema.parse({
        ONCHAIN_HTTP_BIND: '0.0.0.0',
        ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: '400000',
        ONCHAIN_SESSION_MAX: '8',
        ONCHAIN_SESSION_IDLE_MS: '60000',
      }),
    );
    expect(defaults).toStrictEqual({
      httpBind: '0.0.0.0',
      httpResponseTimeoutMs: 400_000,
      sessionMax: 8,
      sessionIdleMs: 60_000,
    });
  });
});

describe('toProcessEnv projects the string-valued keys and only those', () => {
  it('drops exactly the keys whose parsed value is not a string', () => {
    // The projection is a predicate rather than a list of names, so this test is where the list
    // lives — a key that silently changes type shows up here instead of as an adapter reading
    // `undefined` from an environment record it was handed.
    const full = EnvSchema.parse({
      LOG_LEVEL: 'info',
      NANSEN_API_KEY: 'nansen-key',
      NANSEN_DAILY_CREDIT_CAP: '250',
      NANSEN_VELOCITY_CREDITS_PER_MIN: '200',
      NANSEN_MAX_CALLS_PER_MIN: '120',
      NANSEN_BUDGET_WARN_RATIO: '0.8',
      ONCHAIN_PROFILE: 'network',
      ONCHAIN_HTTP_PORT: '8848',
      ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: '400000',
      ONCHAIN_ALLOWED_HOSTS: 'a.internal:8848',
      ONCHAIN_ALLOWED_ORIGINS: 'https://n8n.internal',
      ONCHAIN_SESSION_MAX: '8',
      ONCHAIN_SESSION_IDLE_MS: '60000',
    });
    const projected = toProcessEnv(full);
    const dropped = Object.keys(full).filter((key) => !(key in projected));
    expect(dropped.sort()).toStrictEqual(
      [
        'NANSEN_DAILY_CREDIT_CAP',
        'NANSEN_VELOCITY_CREDITS_PER_MIN',
        'NANSEN_MAX_CALLS_PER_MIN',
        'NANSEN_BUDGET_WARN_RATIO',
        'ONCHAIN_HTTP_PORT',
        'ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS',
        'ONCHAIN_ALLOWED_HOSTS',
        'ONCHAIN_ALLOWED_ORIGINS',
        'ONCHAIN_SESSION_MAX',
        'ONCHAIN_SESSION_IDLE_MS',
      ].sort(),
    );
    // The three states of the Nansen caps include the WORD `off`, which is a string and therefore
    // survives the projection — that is correct and worth pinning: the adapters read it from `env`.
    expect(toProcessEnv(EnvSchema.parse({ NANSEN_DAILY_CREDIT_CAP: 'off' }))).toStrictEqual({
      NANSEN_DAILY_CREDIT_CAP: 'off',
    });
    // Every key an adapter reads through this view is a string key and survives.
    expect(projected.LOG_LEVEL).toBe('info');
    expect(projected.NANSEN_API_KEY).toBe('nansen-key');
    expect(projected.ONCHAIN_PROFILE).toBe('network');
  });
});
