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
});

describe('loadEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
