import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvSchema, loadEnv } from '../src/env.js';

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
