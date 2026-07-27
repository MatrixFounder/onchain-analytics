import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, createCacheStore } from '@onchain-intel/core';
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

  // CHANGED EXPECTATION (task 006-6, R-50). The schema used to reject anything outside a
  // two-value enum. It now accepts any chain the REGISTRY knows and rejects only what the registry
  // does not — because refusing at the schema is the wrong layer for "this capability is not
  // served there": that answer belongs to the coverage matrix, which can say WHERE it IS served
  // (§4.2.3). A schema-level refusal could only say "no".
  it('accepts any registry chain and rejects an unknown one (R-50c)', () => {
    expect(() => NewPairsInputSchema.parse({ chain: 'ethereum' })).not.toThrow();
    const unknown = NewPairsInputSchema.safeParse({ chain: 'not-a-real-chain' });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((i) => i.message.includes('unknown chain'))).toBe(true);
    }
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

    // CHANGED EXPECTATION (vdd-multi cycle 6, M): the validation still runs — that is what this
    // test was written to prove and it is still proven — but it is now reported through the
    // handler's own `{ok:false, reason}` contract instead of thrown. Six sibling handlers already
    // worked this way; `parse` here escaped the declared `Promise<NewPairsOutcome>` return type
    // and surfaced as a generic transport error rather than this tool's own message.
    const outcome = await newPairsHandler({ chain: 'ethereum' }, { registry });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('violating the tool contract');
  });

  it('materializes the default limit BEFORE building cache-key args — an omitted limit and an explicit default-valued limit share the SAME cache entry, never a duplicate upstream fetch (post-M1 polish, fix 1)', async () => {
    let fetchCalls = 0;
    function countingDexscreenerAdapter(): ProviderAdapter {
      return {
        id: 'dexscreener',
        capabilities: () => [{ id: 'pairs.new', chains: ['ethereum', 'solana'] }],
        costOf: () => ({ credits: 0 }),
        fetch: async () => {
          fetchCalls += 1;
          return {};
        },
        normalize: () => FAKE_POOLS,
        isAvailable: () => ({ ok: true }),
      };
    }

    // A real two-level cache (in-memory sqlite) — the same seam `test/e2e.inprocess.test.ts` uses
    // — so this test proves the fix via actually-observed cache-hit behavior, not just by reaching
    // into `deriveArgsHash` internals.
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['dexscreener', countingDexscreenerAdapter()]]),
      createCacheStore({ dbPath: ':memory:' }),
    );

    const first = await newPairsHandler({ chain: 'ethereum' }, { registry }); // limit omitted
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok:true');
    expect(first.cache.status).toBe('miss');

    // dexscreener's own DEFAULT_LIMIT, passed EXPLICITLY this time — before the fix, this built a
    // different `args` shape (`{chain, limit: 10}` vs. `{chain}`) and therefore a different cache
    // key, causing a second, redundant upstream fetch for the identical logical query.
    const second = await newPairsHandler({ chain: 'ethereum', limit: 10 }, { registry });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok:true');
    expect(second.cache.status).toBe('hit');

    expect(fetchCalls).toBe(1);
  });
});
