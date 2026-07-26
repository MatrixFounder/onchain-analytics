import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CapabilityRegistry,
  createDefillamaAdapter,
  createNansenAdapter,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import {
  ListChainsInputSchema,
  ListChainsOutputSchema,
  listChainsHandler,
} from '../../src/tools/list-chains.js';

/** Task 006-7 — discovery (R-52). Everything here must hold WITHOUT touching the network. */
function ctx() {
  const adapters = new Map<string, ProviderAdapter>([
    ['defillama', createDefillamaAdapter()],
    ['nansen', createNansenAdapter()],
  ]);
  return { registry: new CapabilityRegistry([...routes], adapters) };
}

describe('onchain_list_chains', () => {
  it('makes zero network calls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call from a discovery tool');
    });
    try {
      expect(listChainsHandler({}, ctx()).total).toBeGreaterThan(100);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('truncates by default and reports the untruncated total (R-52c)', () => {
    // Without `total`, a truncated page is indistinguishable from "that is all there is" — the
    // agent would conclude the engine supports 50 chains. And an untruncated default would make
    // the tool that exists to SAVE ~8k tokens of schema cost more than that on its first call.
    const out = listChainsHandler({}, ctx());
    expect(out.chains.length).toBe(50);
    expect(out.total).toBeGreaterThan(out.chains.length);
  });

  it('honours an explicit limit', () => {
    expect(listChainsHandler({ limit: 3 }, ctx()).chains).toHaveLength(3);
  });

  it('ranks by the stale TVL so the truncated page is the useful half', () => {
    const rows = listChainsHandler({ limit: 10 }, ctx()).chains;
    const tvls = rows.map((r) => r.tvlUsdAtRegistrySync ?? 0);
    expect([...tvls].sort((a, b) => b - a)).toEqual(tvls);
  });

  it('filters by capability using the SAME matrix the engine gates on', () => {
    const free = listChainsHandler({ capability: 'chain.tvl', limit: 200 }, ctx());
    const paid = listChainsHandler({ capability: 'smart-money.flows', limit: 200 }, ctx());

    expect(free.total).toBeGreaterThan(100);
    // Honest asymmetry, visible instead of hidden: the paid capability is far narrower and says
    // so. Asserted as a relation, not a fixed list — task 006-9 widened it from 2 to 17 and that
    // must not be a test failure.
    expect(paid.total).toBeGreaterThan(2);
    expect(paid.total).toBeLessThan(free.total / 5);
    expect(paid.chains.map((c) => c.slug)).toContain('ethereum');
  });

  it('finds a chain by slug, display name and alias', () => {
    for (const query of ['berachain', 'Berachain', 'berachain-bera']) {
      const found = listChainsHandler({ query }, ctx()).chains.map((c) => c.slug);
      expect(found, query).toContain('berachain');
    }
    expect(listChainsHandler({ query: 'eth' }, ctx()).chains.map((c) => c.slug)).toContain(
      'ethereum',
    );
  });

  it('filters by family and by the stale TVL threshold', () => {
    const svm = listChainsHandler({ family: 'svm', limit: 200 }, ctx()).chains;
    expect(svm.every((c) => c.family === 'svm')).toBe(true);

    const big = listChainsHandler({ minTvlUsd: 1e9, limit: 200 }, ctx()).chains;
    expect(big.every((c) => (c.tvlUsdAtRegistrySync ?? 0) >= 1e9)).toBe(true);
  });

  it('names the stale field `tvlUsdAtRegistrySync`, never `tvlUsd` (data-model §4.1 rule 3)', () => {
    const row = listChainsHandler({ limit: 1 }, ctx()).chains[0]!;
    expect(row).toHaveProperty('tvlUsdAtRegistrySync');
    expect(row).not.toHaveProperty('tvlUsd');
  });

  it('reports each row with the capabilities actually covered there', () => {
    const bera = listChainsHandler({ query: 'berachain' }, ctx()).chains.find(
      (c) => c.slug === 'berachain',
    )!;
    expect(bera.capabilities).toContain('chain.tvl');
    expect(bera.capabilities).not.toContain('smart-money.flows');
  });

  it('produces output that satisfies its own contract, and a JSON-Schema-able input', () => {
    expect(ListChainsOutputSchema.safeParse(listChainsHandler({ limit: 5 }, ctx())).success).toBe(
      true,
    );
    expect(() => z.toJSONSchema(ListChainsInputSchema)).not.toThrow();
  });
});
