import { describe, it, expect } from 'vitest';
import { pingHandler, PingInputSchema, PingOutputSchema } from '../src/tools/ping.js';

/**
 * Unit tests for `src/tools/ping.ts` (task 001-3, closes R-6/R-10). `pingHandler` is exercised
 * directly as a pure function — no transport/server is stood up here (that's the E2E suite,
 * `test/e2e.stdio.test.ts`).
 */

describe('pingHandler', () => {
  it('returns output that validates against PingOutputSchema', () => {
    const result = pingHandler({}, { version: '1.2.3' });
    expect(() => PingOutputSchema.parse(result)).not.toThrow();
  });

  it('sets ok to the literal true', () => {
    const result = pingHandler({}, { version: '1.2.3' });
    expect(result.ok).toBe(true);
  });

  it('sets service to the exact literal service name', () => {
    const result = pingHandler({}, { version: '1.2.3' });
    expect(result.service).toBe('onchain-intel-mcp-server');
  });

  it('threads ctx.version through unchanged (never hardcoded)', () => {
    const result = pingHandler({}, { version: '9.9.9-test' });
    expect(result.version).toBe('9.9.9-test');
  });

  it('returns ts as an integer epoch-ms timestamp within [before, after] of Date.now()', () => {
    const before = Date.now();
    const result = pingHandler({}, { version: '1.0.0' });
    const after = Date.now();

    expect(Number.isInteger(result.ts)).toBe(true);
    expect(result.ts).toBeGreaterThanOrEqual(before);
    expect(result.ts).toBeLessThanOrEqual(after);
  });
});

describe('PingInputSchema', () => {
  it('accepts an empty object (the tool takes no parameters)', () => {
    expect(() => PingInputSchema.parse({})).not.toThrow();
  });

  it('rejects extra keys — .strict()', () => {
    expect(() => PingInputSchema.parse({ unexpected: 'value' })).toThrow();
  });
});
