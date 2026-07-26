import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CapabilityRegistry,
  createDefillamaAdapter,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import {
  ChainTvlInputSchema,
  ChainTvlOutputSchema,
  chainTvlHandler,
} from '../../src/tools/chain-tvl.js';

/** Task 006-7 — chain-level TVL (R-53). The original question that started TASK-006. */
const CHAINS_BODY = [
  { gecko_id: 'ethereum', tvl: 6.0e10, tokenSymbol: 'ETH', name: 'Ethereum', chainId: 1 },
  {
    gecko_id: 'berachain-bera',
    tvl: 50_579_539.42,
    tokenSymbol: 'BERA',
    name: 'Berachain',
    chainId: 80094,
  },
];

/** Minimal in-memory CacheStore — `CapabilityRegistry` defaults to a passthrough (no-op) store,
 * so cache behaviour is only observable when one is injected. */
function memoryCache() {
  const entries = new Map<string, unknown>();
  return {
    get: (provider: string, capability: string, argsHash: string) =>
      Promise.resolve(
        entries.has(`${provider}|${capability}|${argsHash}`)
          ? { value: entries.get(`${provider}|${capability}|${argsHash}`), ageMs: 0 }
          : undefined,
      ),
    set: (provider: string, capability: string, argsHash: string, value: unknown) => {
      entries.set(`${provider}|${capability}|${argsHash}`, value);
      return Promise.resolve();
    },
  };
}

function ctx(body: unknown = CHAINS_BODY) {
  const calls: string[] = [];
  const adapters = new Map<string, ProviderAdapter>([
    [
      'defillama',
      createDefillamaAdapter({
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify(body), { status: 200 });
        },
      }),
    ],
  ]);
  return { ctx: { registry: new CapabilityRegistry([...routes], adapters, memoryCache()) }, calls };
}

describe('onchain_chain_tvl', () => {
  it('answers the chain TVL question that started TASK-006', async () => {
    const { ctx: c, calls } = ctx();
    const out = await chainTvlHandler({ chain: 'berachain' }, c);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.chain).toBe('berachain');
    expect(out.value.tvlUsd).toBe(50_579_539.42);
    expect(out.value.source).toBe('defillama');
    expect(calls).toEqual(['https://api.llama.fi/v2/chains']);
  });

  it('accepts an alias and answers under the canonical slug (R-59)', async () => {
    const { ctx: c } = ctx();
    const out = await chainTvlHandler({ chain: 'eth' }, c);
    expect(out.ok && out.value.chain).toBe('ethereum');
  });

  it('has NO totalTvlUsd — a chain has nothing to total across (R-53b)', async () => {
    const { ctx: c } = ctx();
    const out = await chainTvlHandler({ chain: 'ethereum' }, c);
    expect(out.ok && Object.keys(out.value).sort()).toEqual([
      'chain',
      'fetchedAt',
      'name',
      'source',
      'tvlUsd',
    ]);
  });

  it('serves the second identical call from cache (no second fetch)', async () => {
    const { ctx: c, calls } = ctx();
    await chainTvlHandler({ chain: 'ethereum' }, c);
    const second = await chainTvlHandler({ chain: 'ethereum' }, c);
    expect(second.ok && second.cache.status).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('collapses two spellings of one chain onto ONE cache entry (data-model §4.2.2)', async () => {
    const { ctx: c, calls } = ctx();
    await chainTvlHandler({ chain: 'ethereum' }, c);
    const viaAlias = await chainTvlHandler({ chain: 'eth' }, c);
    // If canonicalization happened after the cache key was built, this would refetch — and on a
    // paid route that is a second charge for one logical request.
    expect(viaAlias.ok && viaAlias.cache.status).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('reports a bad vendor value as a failed outcome, never a throw', async () => {
    const { ctx: c } = ctx([{ name: 'Ethereum', tvl: -1 }]);
    const out = await chainTvlHandler({ chain: 'ethereum' }, c);
    expect(out.ok).toBe(false);
  });

  it('refuses an uncovered chain before any network call (coverage gate)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call for an uncovered chain');
    });
    try {
      const adapters = new Map<string, ProviderAdapter>();
      const c = { registry: new CapabilityRegistry([...routes], adapters) };
      const out = await chainTvlHandler({ chain: 'berachain' }, c);
      expect(out.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps both schemas renderable as JSON Schema (tools/list must not break)', () => {
    expect(() => z.toJSONSchema(ChainTvlInputSchema)).not.toThrow();
    expect(() => z.toJSONSchema(ChainTvlOutputSchema)).not.toThrow();
  });
});
