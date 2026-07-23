import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { GetTokenInputSchema, getTokenHandler } from '../../src/tools/get-token.js';

/**
 * Unit tests for `src/tools/get-token.ts` (task 003-7, R-16) — input schema + the pure handler,
 * exercised directly against a small, purpose-built `CapabilityRegistry` (mirrors
 * `packages/core/test/registry.test.ts`'s own mock-adapter convention) — no MCP transport stood
 * up here (that's `test/e2e.inprocess.test.ts`).
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [
  { capability: 'token.price', chains: ['ethereum', 'solana'], adapterIds: ['coingecko'] },
];

const FAKE_TOKEN = {
  chain: 'ethereum' as const,
  address: ETH_ADDRESS,
  symbol: 'USDC',
  name: 'USDC',
  source: 'coingecko',
  fetchedAt: 1_800_000_000_000,
};

function fakeCoingeckoAdapter(): ProviderAdapter {
  return {
    id: 'coingecko',
    capabilities: () => [{ id: 'token.price', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => FAKE_TOKEN,
    isAvailable: () => ({ ok: true }),
  };
}

describe('GetTokenInputSchema', () => {
  it('accepts a valid ethereum address', () => {
    expect(() =>
      GetTokenInputSchema.parse({ chain: 'ethereum', address: ETH_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts a valid solana address', () => {
    expect(() =>
      GetTokenInputSchema.parse({ chain: 'solana', address: SOL_ADDRESS }),
    ).not.toThrow();
  });

  it('rejects a chain outside ethereum/solana (e.g. dash) — narrowed enum, not the full ChainSchema', () => {
    expect(() => GetTokenInputSchema.parse({ chain: 'dash', address: ETH_ADDRESS })).toThrow();
  });

  it('rejects an invalid address for the given chain (superRefine)', () => {
    expect(() =>
      GetTokenInputSchema.parse({ chain: 'ethereum', address: 'not-an-address' }),
    ).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      GetTokenInputSchema.parse({ chain: 'ethereum', address: ETH_ADDRESS, unexpected: 'x' }),
    ).toThrow();
  });

  it('rejects a pathologically long address FAST (adversarial cycle 2, finding 3 — no bs58 quadratic work)', () => {
    const hugeAddress = 'x'.repeat(100_000);
    const start = performance.now();
    const result = GetTokenInputSchema.safeParse({ chain: 'solana', address: hugeAddress });
    const elapsedMs = performance.now() - start;

    expect(result.success).toBe(false);
    // A bounded, cheap length-check rejection completes near-instantly — a naive bs58.decode() on
    // a 100k-character string (if reached at all) would be dramatically slower (quadratic-ish).
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('getTokenHandler', () => {
  it('resolves via the registry and returns a Token-shaped output + cache meta on success', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['coingecko', fakeCoingeckoAdapter()]]),
    );
    const outcome = await getTokenHandler(
      { chain: 'ethereum', address: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_TOKEN);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'coingecko',
      capability: 'token.price',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await getTokenHandler(
      { chain: 'ethereum', address: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('token.price');
    expect(outcome.reason).not.toContain(ETH_ADDRESS);
  });
});
