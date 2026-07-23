import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { CapabilityRoute, Pool, ProviderAdapter } from '@onchain-intel/core';
import { NewPairsInputSchema, newPairsHandler } from '../../src/tools/new-pairs.js';

/**
 * Unit tests for `src/tools/new-pairs.ts` (task 003-7, R-18) — see `get-token.test.ts`'s docstring
 * for the shared testing convention.
 */

const ROUTES: CapabilityRoute[] = [
  { capability: 'pairs.new', chains: ['ethereum', 'solana'], adapterIds: ['dexscreener'] },
];

const FAKE_POOLS: Pool[] = [
  {
    id: 'ethereum:0xpair',
    chain: 'ethereum',
    dexId: 'uniswap',
    baseTokenSymbol: 'WETH',
    quoteTokenSymbol: 'USDC',
    pairAddress: '0xpair',
    source: 'dexscreener',
    fetchedAt: 1_800_000_000_000,
  },
];

function fakeDexscreenerAdapter(): ProviderAdapter {
  return {
    id: 'dexscreener',
    capabilities: () => [{ id: 'pairs.new', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => FAKE_POOLS,
    isAvailable: () => ({ ok: true }),
  };
}

describe('NewPairsInputSchema', () => {
  it('accepts a chain with no limit', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'ethereum' })).not.toThrow();
  });

  it('accepts a chain with a positive integer limit', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'solana', limit: 5 })).not.toThrow();
  });

  it('rejects a chain outside ethereum/solana (e.g. dash)', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'dash' })).toThrow();
  });

  it('rejects a non-positive limit', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'ethereum', limit: 0 })).toThrow();
    expect(() => NewPairsInputSchema.parse({ chain: 'ethereum', limit: -1 })).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'ethereum', unexpected: 'x' })).toThrow();
  });
});

describe('newPairsHandler', () => {
  it('resolves via the registry and wraps Pool[] into {chain, pairs, source, fetchedAt} + cache meta', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['dexscreener', fakeDexscreenerAdapter()]]),
    );
    const before = Date.now();
    const outcome = await newPairsHandler({ chain: 'ethereum' }, { registry });
    const after = Date.now();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output.chain).toBe('ethereum');
    expect(outcome.output.pairs).toStrictEqual(FAKE_POOLS);
    expect(outcome.output.source).toBe('dexscreener');
    expect(outcome.output.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(outcome.output.fetchedAt).toBeLessThanOrEqual(after);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'dexscreener',
      capability: 'pairs.new',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await newPairsHandler({ chain: 'ethereum' }, { registry });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('pairs.new');
  });

  it('still validates the adapter output against the Pool schema after removing the redundant standalone z.array(PoolSchema) pass (fix I)', async () => {
    function fakeAdapterWithMalformedPools(): ProviderAdapter {
      return {
        id: 'dexscreener',
        capabilities: () => [{ id: 'pairs.new', chains: ['ethereum', 'solana'] }],
        costOf: () => ({ credits: 0 }),
        fetch: async () => ({}),
        // Missing required Pool fields (e.g. `id`, `fetchedAt`) — must still fail validation via
        // the single remaining NewPairsOutputSchema.parse(...) call, proving the dedup didn't
        // silently drop the validation itself.
        normalize: () => [{ chain: 'ethereum', dexId: 'uniswap' }],
        isAvailable: () => ({ ok: true }),
      };
    }

    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['dexscreener', fakeAdapterWithMalformedPools()]]),
    );

    await expect(newPairsHandler({ chain: 'ethereum' }, { registry })).rejects.toThrow();
  });
});
