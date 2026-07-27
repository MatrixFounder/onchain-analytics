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

  /**
   * TASK-007 task 007-7 (R-72, AC-4) — the new capability must be visible exactly where it is
   * served and invisible where it is not. This is the system-level counterpart to
   * `defillama-dex-coverage.test.ts` in core: there the ADAPTER answers, here the matrix an agent
   * actually reads does.
   */
  describe('dex.volume.history visibility (task 007-7)', () => {
    it('is served on strictly FEWER chains than chain.tvl is', () => {
      const dex = listChainsHandler({ capability: 'dex.volume.history', limit: 200 }, ctx());
      const tvl = listChainsHandler({ capability: 'chain.tvl', limit: 200 }, ctx());

      // A RELATION, not a literal count: this survives a registry sync and vendor drift, whereas
      // `toBe(274)` would break on the next sync and be "fixed" by editing the number — at which
      // point it checks nothing. Restoring the naive `vendors.defillama != null` predicate makes
      // these two equal, which is exactly the over-claim this task exists to prevent.
      expect(dex.total).toBeGreaterThan(0);
      expect(dex.total).toBeLessThan(tvl.total);
    });

    it('lists the capability on a served chain and omits it on a TVL-only one', () => {
      const c = ctx();
      const ethereum = listChainsHandler({ query: 'ethereum', limit: 200 }, c).chains.find(
        (row) => row.slug === 'ethereum',
      );
      expect(ethereum?.capabilities).toContain('dex.volume.history');

      const zcash = listChainsHandler({ query: 'zcash', limit: 200 }, c).chains.find(
        (row) => row.slug === 'zcash',
      );
      // The vendor names this chain for TVL and not for DEX volume — so one row, two answers.
      expect(zcash?.capabilities).toContain('chain.tvl');
      expect(zcash?.capabilities).not.toContain('dex.volume.history');
    });

    it('answers the capability filter with zero network calls', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('network call from a discovery tool');
      });
      try {
        expect(
          listChainsHandler({ capability: 'dex.volume.history', limit: 200 }, ctx()).total,
        ).toBeGreaterThan(0);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
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
