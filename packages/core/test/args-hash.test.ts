import { describe, expect, it } from 'vitest';
import { canonicalize, deriveArgsHash } from '../src/net/args-hash.js';

describe('canonicalize [Phase 2]', () => {
  it('recursively sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
    expect(Object.keys(canonicalize({ b: 1, a: 2 }) as Record<string, unknown>)).toEqual([
      'a',
      'b',
    ]);
  });

  it('sorts nested object keys too, not just the top level', () => {
    const input = { outer: { z: 1, a: 2 }, aaa: 3 };
    const result = canonicalize(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['aaa', 'outer']);
    expect(Object.keys(result.outer as Record<string, unknown>)).toEqual(['a', 'z']);
  });

  it('preserves array element order — only object keys are canonicalized, not array contents', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
    expect(canonicalize({ list: [{ b: 1, a: 2 }] })).toEqual({ list: [{ a: 2, b: 1 }] });
  });

  it('passes primitives through unchanged', () => {
    expect(canonicalize('x')).toBe('x');
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize(true)).toBe(true);
    expect(canonicalize(null)).toBe(null);
  });
});

describe('deriveArgsHash [Phase 2 — canonical key-order]', () => {
  it('is a 64-character lowercase hex string (sha256 hex digest)', () => {
    const hash = deriveArgsHash('token.price', { chain: 'ethereum' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable to key order — {chain, address} and {address, chain} hash identically', () => {
    const a = deriveArgsHash('token.price', { chain: 'ethereum', address: '0xabc' });
    const b = deriveArgsHash('token.price', { address: '0xabc', chain: 'ethereum' });
    expect(a).toBe(b);
  });

  it('is stable to nested key order too', () => {
    const a = deriveArgsHash('wallet.balances.native', {
      chain: 'ethereum',
      opts: { limit: 10, offset: 0 },
    });
    const b = deriveArgsHash('wallet.balances.native', {
      opts: { offset: 0, limit: 10 },
      chain: 'ethereum',
    });
    expect(a).toBe(b);
  });

  it('produces a different hash for different args (same capability)', () => {
    const a = deriveArgsHash('token.price', { chain: 'ethereum', address: '0xabc' });
    const b = deriveArgsHash('token.price', { chain: 'ethereum', address: '0xdef' });
    expect(a).not.toBe(b);
  });

  it('produces a different hash for different capabilities, even with byte-identical args', () => {
    const a = deriveArgsHash('token.price', { chain: 'ethereum' });
    const b = deriveArgsHash('token.metadata', { chain: 'ethereum' });
    expect(a).not.toBe(b);
  });

  it('is deterministic — the same (capability, args) pair always hashes to the same value', () => {
    const args = { chain: 'solana', address: 'Vote111111111111111111111111111111111111111' };
    const first = deriveArgsHash('token.price', args);
    const second = deriveArgsHash('token.price', args);
    expect(first).toBe(second);
  });
});
