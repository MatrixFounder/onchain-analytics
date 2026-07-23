import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { ProtocolTvlInputSchema, protocolTvlHandler } from '../../src/tools/protocol-tvl.js';

/**
 * Unit tests for `src/tools/protocol-tvl.ts` (task 003-7, R-19) — see `get-token.test.ts`'s
 * docstring for the shared testing convention.
 */

const ROUTES: CapabilityRoute[] = [
  { capability: 'protocol.tvl', chains: ['ethereum', 'solana'], adapterIds: ['defillama'] },
];

const FAKE_TVL = {
  protocol: 'Uniswap',
  chain: 'ethereum' as const,
  tvlUsd: 1_000_000,
  totalTvlUsd: 5_000_000,
  source: 'defillama',
  fetchedAt: 1_800_000_000_000,
};

function fakeDefillamaAdapter(): ProviderAdapter {
  return {
    id: 'defillama',
    capabilities: () => [{ id: 'protocol.tvl', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => FAKE_TVL,
    isAvailable: () => ({ ok: true }),
  };
}

describe('ProtocolTvlInputSchema', () => {
  it('accepts a valid chain + protocolSlug', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: 'uniswap' }),
    ).not.toThrow();
  });

  it('rejects a chain outside ethereum/solana (e.g. dash)', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'dash', protocolSlug: 'uniswap' }),
    ).toThrow();
  });

  it('rejects an empty protocolSlug', () => {
    expect(() => ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: '' })).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: 'uniswap', unexpected: 'x' }),
    ).toThrow();
  });
});

describe('protocolTvlHandler', () => {
  it('resolves via the registry and returns the ProtocolTvlResult shape + cache meta on success', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['defillama', fakeDefillamaAdapter()]]),
    );
    const outcome = await protocolTvlHandler(
      { chain: 'ethereum', protocolSlug: 'uniswap' },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_TVL);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'defillama',
      capability: 'protocol.tvl',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await protocolTvlHandler(
      { chain: 'ethereum', protocolSlug: 'uniswap' },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('protocol.tvl');
  });
});
