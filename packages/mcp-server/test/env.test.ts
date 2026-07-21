import { describe, it, expect, vi, afterEach } from 'vitest';
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
});
